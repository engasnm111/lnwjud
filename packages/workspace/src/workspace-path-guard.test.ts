import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '@lnwjud/domain';
import type { Workspace, ResolvedWorkspacePath } from './workspace-types.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<Workspace> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-workspace-'));
  temporaryRoots.push(rawRoot);
  const rootPath = await realpath(rawRoot);
  await mkdir(path.join(rootPath, 'src'));
  await writeFile(path.join(rootPath, 'src', 'index.ts'), 'export const value = 42;\n', 'utf8');
  await writeFile(path.join(rootPath, '.env.example'), 'EXAMPLE=true\n', 'utf8');
  return {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath,
    realRootPath: rootPath,
    createdAt: new Date(0).toISOString(),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expectError(
  result: Result<ResolvedWorkspacePath>,
  code: 'INVALID_INPUT' | 'PATH_OUTSIDE_WORKSPACE' | 'SECRET_ACCESS_DENIED',
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe('WorkspacePathGuard', () => {
  it('resolves an existing file inside the workspace', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard();

    const result = await guard.resolveForRead(workspace, 'src\\index.ts');

    expect(result).toEqual({
      ok: true,
      value: {
        workspaceId: workspace.id,
        relativePath: path.join('src', 'index.ts'),
        absolutePath: path.join(workspace.rootPath, 'src', 'index.ts'),
        realPath: path.join(workspace.realRootPath, 'src', 'index.ts'),
        exists: true,
      },
    });
  });

  it('rejects traversal and absolute paths outside the workspace', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard();

    expectError(await guard.resolveForRead(workspace, '..\\..\\Windows\\System32'), 'PATH_OUTSIDE_WORKSPACE');
    expectError(await guard.resolveForRead(workspace, path.resolve(workspace.rootPath, '..', 'outside.txt')), 'PATH_OUTSIDE_WORKSPACE');
    expectError(await guard.resolveForRead(workspace, '\\\\server\\share\\file'), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects NUL bytes before filesystem access', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard();

    expectError(await guard.resolveForRead(workspace, 'src\\index.ts\0.txt'), 'INVALID_INPUT');
  });

  it('allows a nonexistent child for a write without creating it', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard();
    const inputPath = path.join('src', 'new-file.ts');

    const result = await guard.resolveForWrite(workspace, inputPath);

    expect(result).toEqual({
      ok: true,
      value: {
        workspaceId: workspace.id,
        relativePath: inputPath,
        absolutePath: path.join(workspace.rootPath, inputPath),
        exists: false,
      },
    });
  });

  it('normalizes a path that differs only by case on Windows', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard();

    const result = await guard.resolveForRead(workspace, 'SRC\\INDEX.TS');

    if (process.platform === 'win32') {
      expect(result.ok).toBe(true);
    } else {
      expectError(result, 'PATH_OUTSIDE_WORKSPACE');
    }
  });

  it('allows secret files outside E:\\ in unrestricted mode', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, '.env'), 'SECRET=1\n', 'utf8');
    const guard = new WorkspacePathGuard(undefined, { unrestricted: true });

    const result = await guard.resolveForRead(workspace, '.env');

    expect(result.ok).toBe(true);
  });

  it('still rejects paths outside the workspace in unrestricted mode', async () => {
    const workspace = await createWorkspace();
    const guard = new WorkspacePathGuard(undefined, { unrestricted: true });

    expectError(await guard.resolveForRead(workspace, '..\\..\\Windows\\System32'), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('allows only explicit absolute outside paths under per-invocation Full Bypass', async () => {
    const workspace = await createWorkspace();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-outside-'));
    temporaryRoots.push(outsideRoot);
    const outsideFile = path.join(outsideRoot, 'proof.txt');
    const outsideNewFile = path.join(outsideRoot, 'new.txt');
    await writeFile(outsideFile, 'proof', 'utf8');
    const guard = new WorkspacePathGuard();
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    const outsideRealFile = await realpath(outsideFile);
    await expect(guard.resolveForRead(workspace, outsideFile, authorization)).resolves.toMatchObject({
      ok: true,
      value: { outsideWorkspace: true, realPath: outsideRealFile },
    });
    await expect(guard.resolveForWrite(workspace, outsideNewFile, authorization)).resolves.toMatchObject({
      ok: true,
      value: { outsideWorkspace: true, absolutePath: outsideNewFile, exists: false },
    });
    expectError(await guard.resolveForRead(workspace, '..' + path.sep + path.basename(outsideRoot) + path.sep + 'proof.txt', authorization), 'PATH_OUTSIDE_WORKSPACE');
  });
});
