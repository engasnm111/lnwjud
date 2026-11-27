import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineeringHarnessSettings } from '@lnwjud/shared';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import { EngineeringPreparationService } from './engineering-preparation-service.js';
import { EngineeringProjectAssessmentService } from './engineering-project-assessment.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('EngineeringProjectAssessmentService', () => {
  it('requires a separate workspace for a linked checkout and observes its own HEAD and dirty source', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-worktree-')));
    temporaryRoots.push(root);
    const linked = path.join(root, '.worktrees', 'candidate');
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd, encoding: 'utf8' }).trim();
    git(root, 'init', '-q');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, '.gitignore'), '.worktrees/\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'parent');
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    await writeFile(path.join(linked, 'package.json'), '{"name":"candidate"}');
    git(linked, 'commit', '-qam', 'candidate');
    const parentHead = git(root, 'rev-parse', 'HEAD');
    const linkedHead = git(linked, 'rev-parse', 'HEAD');
    expect(linkedHead).not.toBe(parentHead);
    const workspaces = { async get(id: string): Promise<{ realRootPath: string }> {
      return { realRootPath: id === 'candidate' ? linked : root };
    } } as WorkspaceRepository;
    const preparation = new EngineeringPreparationService(workspaces, {
      globalSettingsProvider: (): EngineeringHarnessSettings => ({ schemaVersion: 1, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true }),
    });
    const prepare = (id: string, scope?: string): ReturnType<EngineeringPreparationService['prepare']> => preparation.prepare(id, 'Fix the TypeScript source file', scope);
    await expect(prepare('parent', '.worktrees/candidate/src/new.ts')).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Register that checkout root') },
    });
    const parent = await prepare('parent');
    const original = await prepare('candidate');
    await writeFile(path.join(linked, 'package.json'), '{"name":"dirty-candidate"}');
    const resumed = await prepare('candidate');
    if (!parent.ok || !original.ok || !resumed.ok) throw new Error('Engineering preparation failed');
    expect(parent.value.workflow.contract?.facts.git).toEqual({ state: 'present', value: { head: parentHead } });
    expect(resumed.value.workflow.contract?.facts.git).toEqual({ state: 'present', value: { head: linkedHead } });
    expect(resumed.value.workflow.contract?.facts.source.state).toBe('present');
    expect(resumed.value.workflow.contract?.facts.source).not.toEqual(original.value.workflow.contract?.facts.source);
  });

  it('selects CodeGraph only when an index directory exists inside the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codegraph-assessment-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codegraph-outside-'));
    temporaryRoots.push(root, outside);
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'Use CodeGraph when .codegraph exists.', 'utf8');
    const service = new EngineeringProjectAssessmentService();
    expect((await service.assess(root)).codeGraphIndexed).toBe(false);
    await mkdir(path.join(root, '.codegraph'));
    expect((await service.assess(root)).codeGraphIndexed).toBe(true);
    await rm(path.join(root, '.codegraph'), { recursive: true });
    await symlink(outside, path.join(root, '.codegraph'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await service.assess(root)).codeGraphIndexed).toBe(false);
  });

  it('reads only applicable AGENTS scopes and the bounded project profile without writing the repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-assessment-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
    await mkdir(path.join(root, '.lnwjud'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'root rules', 'utf8');
    await writeFile(path.join(root, 'src', 'AGENTS.md'), 'src rules', 'utf8');
    await writeFile(path.join(root, 'src', 'feature', 'AGENTS.md'), 'feature rules', 'utf8');
    await writeFile(path.join(root, '.lnwjud', 'project-profile.json'), JSON.stringify({
      ponytail: { mode: 'lite' },
      engineering: { mode: 'inherit', profile: 'strict', commands: { test: 'pnpm test' } },
    }), 'utf8');

    const result = await new EngineeringProjectAssessmentService().assess(root, 'src/feature/component.ts');

    expect(result.project).toMatchObject({ kind: 'node', confidence: 'strong', detectedFiles: ['package.json'] });
    expect(result.instructions.map((entry) => [entry.path, entry.status, entry.content])).toEqual([
      ['AGENTS.md', 'loaded', 'root rules'],
      ['src/AGENTS.md', 'loaded', 'src rules'],
      ['src/feature/AGENTS.md', 'loaded', 'feature rules'],
    ]);
    expect(result.projectProfileStatus).toBe('loaded');
    expect(result.projectProfile).toMatchObject({ engineering: { profile: 'strict' }, ponytail: { mode: 'lite' } });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('surfaces truncated instructions and invalid profiles instead of treating them as complete policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-bounds-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, '.lnwjud'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1), 'utf8');
    await writeFile(path.join(root, '.lnwjud', 'project-profile.json'), JSON.stringify({ engineering: { mode: 'on' } }), 'utf8');

    const result = await new EngineeringProjectAssessmentService().assess(root);

    expect(result.instructions[0]).toMatchObject({ path: 'AGENTS.md', status: 'truncated', bytes: 64 * 1024 + 1 });
    expect(result.projectProfileStatus).toBe('invalid');
    expect(result.projectProfile).toEqual({});
    expect(result.warnings.join('\n')).toMatch(/truncated|inherit or off/i);
  });

  it('resolves AGENTS scopes from filesystem type and nearest existing ancestors for planned paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-scope-kind-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src', 'feature.v2'), { recursive: true });
    await mkdir(path.join(root, '..config'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'root rules', 'utf8');
    await writeFile(path.join(root, 'src', 'AGENTS.md'), 'src rules', 'utf8');
    await writeFile(path.join(root, '..config', 'AGENTS.md'), 'leading dot rules', 'utf8');
    await writeFile(path.join(root, 'src', 'feature.v2', 'AGENTS.md'), 'dotted directory rules', 'utf8');
    await writeFile(path.join(root, 'src', 'feature.v2', 'Dockerfile'), 'FROM scratch', 'utf8');
    await writeFile(path.join(root, 'src', 'blocked'), 'not a directory', 'utf8');

    const service = new EngineeringProjectAssessmentService();
    const dottedDirectory = await service.assess(root, 'src/feature.v2');
    const extensionlessFile = await service.assess(root, 'src/feature.v2/Dockerfile');
    const leadingDotsDirectory = await service.assess(root, '..config');

    expect(dottedDirectory.instructions.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
      'src/feature.v2/AGENTS.md',
    ]);
    expect(extensionlessFile.instructions.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
      'src/feature.v2/AGENTS.md',
    ]);
    expect(leadingDotsDirectory.instructions.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      '..config/AGENTS.md',
    ]);

    const plannedNestedFile = await service.assess(root, 'src/planned.v3/component.ts');
    const plannedExtensionlessFile = await service.assess(root, 'src/PlannedDockerfile');
    expect(plannedNestedFile.instructions.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
    expect(plannedExtensionlessFile.instructions.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
    await expect(service.assess(root, 'src/blocked/child.ts')).rejects.toThrow(/traverses a file/i);
  });

  it('rejects a scoped path that escapes the registered project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-scope-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');

    await expect(new EngineeringProjectAssessmentService().assess(root, '../outside.ts')).rejects.toThrow(/escapes the project root/i);
  });

  it('rejects an in-root scoped symlink that resolves outside the registered project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-symlink-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-symlink-outside-'));
    temporaryRoots.push(root, outside);
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(outside, 'AGENTS.md'), 'outside rules', 'utf8');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(new EngineeringProjectAssessmentService().assess(root, 'linked/component.ts')).rejects.toThrow(/symlink|escapes the project root/i);
  });
});
