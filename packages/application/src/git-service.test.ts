
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitAdapter } from '@lnwjud/git';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { GitService } from './git-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-service-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  return {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('GitService', () => {
  it('forwards cancellation to every MCP-exposed Git adapter operation', async () => {
    const workspace = await createWorkspace();
    const observedSignals: Array<AbortSignal | undefined> = [];
    const adapter = {
      async status(_cwd: string, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { entries: [] } };
      },
      async diff(_cwd: string, _request: unknown, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { patch: '', truncated: false } };
      },
      async log(_cwd: string, _request: unknown, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { entries: [], truncated: false } };
      },
      async run(_cwd: string, _args: readonly string[], _timeoutMs: number | undefined, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const actor = { clientId: 'test', clientName: 'test' };
    const signal = new AbortController().signal;

    await service.status(actor, workspace.id, signal);
    await service.diff(actor, workspace.id, {}, signal);
    await service.log(actor, workspace.id, {}, signal);
    await service.run(actor, { args: ['status'], workspaceId: workspace.id }, signal);

    expect(observedSignals).toEqual([signal, signal, signal, signal]);
  });

  it('guards a diff path before delegating to the Git adapter', async () => {
    const workspace = await createWorkspace();
    const adapter = {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(rootPath: string, request: { path?: string; staged?: boolean; maxBytes?: number }): Promise<{ ok: true; value: { patch: string; truncated: boolean } }> {
        expect(rootPath).toBe(workspace.realRootPath);
        expect(request.path).toBe(path.join('src', 'new.txt'));
        return { ok: true, value: { patch: '', truncated: false } };
      },
      async log(): Promise<never> { throw new Error('not used'); },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    const result = await service.diff({ clientId: 'test', clientName: 'test' }, workspace.id, { path: 'src' + path.sep + 'new.txt' });

    expect(result).toEqual({ ok: true, value: { patch: '', truncated: false } });
  });

  it('rejects a diff path outside the workspace', async () => {
    const workspace = await createWorkspace();
    const service = new GitService(repository(workspace), undefined, {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(): Promise<never> { throw new Error('must not run'); },
      async log(): Promise<never> { throw new Error('not used'); },
    } as unknown as GitAdapter);

    const result = await service.diff({ clientId: 'test', clientName: 'test' }, workspace.id, { path: ['..','outside.txt'].join(path.sep) });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('runs git against an absolute cwd in a registered workspace', async () => {
    const workspace = await createWorkspace();
    const adapter = {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(): Promise<never> { throw new Error('not used'); },
      async log(): Promise<never> { throw new Error('not used'); },
      async run(cwd: string, args: readonly string[]): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        expect(path.resolve(cwd).toLowerCase()).toBe(path.resolve(workspace.realRootPath).toLowerCase());
        expect(args).toEqual(['init']);
        return { ok: true, value: { exitCode: 0, stdout: 'Initialized empty Git repository', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    const result = await service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['init'],
      cwd: workspace.realRootPath,
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { exitCode: 0, stdout: 'Initialized empty Git repository', stderr: '' },
    });
  });

  it.each([
    ['global option', ['-C', 'C:\\outside', 'status']],
    ['repository mutation', ['init']],
    ['deletion', ['rm', 'victim.txt']],
    ['read command with broad pathspec magic', ['status', ':/']],
  ] as const)('rejects an unconfirmed %s before the Git adapter runs', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, { args, workspaceId: workspace.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['workspace override', ['-C', 'C:\\outside', 'status']],
    ['inline alias override', ['-c', 'alias.wipe=!rm -rf .', 'wipe']],
    ['repository shell alias', ['wipe']],
    ['path checkout', ['checkout', '--', 'victim.txt']],
    ['stash history deletion', ['stash', 'drop']],
    ['forced branch deletion', ['branch', '-D', 'old']],
    ['forced remote rewrite', ['push', '--force', 'origin', 'main']],
    ['remote ref deletion', ['push', 'origin', ':main']],
  ] as const)('denies confirmed Git %s because it can bypass scope or irreversibly discard recovery state', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
      userConfirmed: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['rm', '--', 'victim.txt'],
    ['clean', '-fd'],
    ['reset', '--hard'],
    ['restore', '--worktree', 'victim.txt'],
    ['add', '--', 'src/file.ts'],
    ['commit', '-m', 'safe checkpoint'],
    ['reset', '--soft', 'HEAD~1'],
    ['restore', '--staged', 'src/file.ts'],
  ] as const)('allows a confirmed policy-supported Git command: %s', async (...args) => {
    const workspace = await createWorkspace();
    const observed: readonly string[][] = [];
    const calls: string[][] = observed as string[][];
    const adapter = {
      async run(_cwd: string, command: readonly string[]): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls.push([...command]);
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
      userConfirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([[...args]]);
  });

  it('requires workspaceId unless cwd is an absolute path', async () => {
    const workspace = await createWorkspace();
    const service = new GitService(repository(workspace));

    const result = await service.run({ clientId: 'test', clientName: 'test' }, { args: ['status'] });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
