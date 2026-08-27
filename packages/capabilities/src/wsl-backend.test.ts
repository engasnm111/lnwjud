import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { WslCapabilityBackend, WslFilesystemCapabilityBackend } from './wsl-backend.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WslCapabilityBackend', () => {
  it('allows an ordinary unconfirmed WSL run and forwards it', async () => {
    const calls: unknown[] = [];
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({}); } },
      allowedRoots: ['C:\\workspace'],
    });

    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'node', arguments: ['cleanup.js'], cwd: 'C:\\workspace',
    })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'rm', arguments: ['victim.txt'], cwd: 'C:\\workspace',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toHaveLength(1);
  });

  it('rejects another registered root when host metadata binds the active workspace root', async () => {
    if (process.platform !== 'win32') return;
    const activeRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wsl-active-'));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wsl-other-'));
    temporaryRoots.push(activeRoot, otherRoot);
    const calls: unknown[] = [];
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({}); } },
      allowedRoots: [activeRoot, otherRoot],
    });

    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-active', executable: 'node', arguments: ['script.js'], cwd: otherRoot,
      dry_run: true, metadata: { 'lnwjud.activeWorkspaceRoot.v1': activeRoot },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['direct delete utility', 'rm', ['victim.txt']],
    ['Git purge', 'git', ['clean', '-fd']],
  ] as const)('requires confirmation for risky WSL command: %s', async (_label, executable, args) => {
    const calls: unknown[] = [];
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({ task_id: 'task-1' }); } },
      allowedRoots: ['C:\\workspace'],
    });

    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable, arguments: args, cwd: 'C:\\workspace',
      metadata: { 'lnwjud.activeWorkspaceRoot.v1': 'C:\\workspace' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toEqual([]);
  });

  it('allows ordinary WSL copy without confirmation', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wsl-copy-'));
    temporaryRoots.push(root);
    const calls: unknown[] = [];
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({ task_id: 'task-1' }); } },
      allowedRoots: [root],
    });

    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'cp', arguments: ['source.txt', 'destination.txt'], cwd: root,
      metadata: { 'lnwjud.activeWorkspaceRoot.v1': root },
    })).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('maps a scoped Windows workspace to WSL argv without creating a shell string', async () => {
    const calls: unknown[] = [];
    const runner: CapabilityBackend = {
      execute: async (input): Promise<Result<unknown>> => {
        calls.push(input);
        return ok({ task_id: 'task-1', state: 'running' });
      },
    };
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner,
      allowedRoots: ['C:\\workspace'],
    });

    const result = await backend.execute({
      operation: 'run',
      workspaceId: 'ws-1',
      distro: 'Ubuntu',
      executable: 'node',
      arguments: ['--version'],
      cwd: 'C:\\workspace\\src',
      environment: { CI: '1' },
      execution: 'background',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: {
      task_id: 'task-1',
      backend: 'wsl',
      distro: 'Ubuntu',
      workspace_id: 'ws-1',
      linux_cwd: '/mnt/c/workspace/src',
    } });
    expect(calls).toEqual([{
      operation: 'run',
      executable: 'wsl.exe',
      arguments: ['--distribution', 'Ubuntu', '--cd', '/mnt/c/workspace/src', '--exec', 'env', 'CI=1', 'node', '--version'],
      cwd: 'C:\\workspace\\src',
      execution: 'background',
      privilege: 'user',
      workspace_id: 'ws-1',
      timeout_seconds: 3_600,
      max_output_bytes: 2 * 1024 * 1024,
      include_stdout: true,
      include_stderr: true,
      dry_run: false,
      userConfirmed: true,
    }]);
  });

  it('rejects shell-string flags, workspace escapes, and cross-workspace task access', async () => {
    const runner: CapabilityBackend = { execute: async (): Promise<Result<unknown>> => ok({ task_id: 'task-1', state: 'running' }) };
    const backend = new WslCapabilityBackend({ platform: 'win32', runner, allowedRoots: ['C:\\workspace'] });

    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'bash', arguments: ['-lc', 'echo unsafe'], cwd: 'C:\\workspace',
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'node', arguments: [], cwd: 'C:\\outside',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });

    await backend.execute({
      operation: 'run', workspaceId: 'ws-1', executable: 'node', arguments: [], cwd: 'C:\\workspace', execution: 'background', userConfirmed: true,
    });
    await expect(backend.execute({ operation: 'status', workspaceId: 'ws-2', task_id: 'task-1' })).resolves.toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
  });

  it('reports missing or stopped WSL state without pretending it is ready', async () => {
    const backend = new WslCapabilityBackend({
      platform: 'win32',
      runner: { execute: async (): Promise<Result<unknown>> => ok({}) },
      allowedRoots: ['C:\\workspace'],
      availabilityProbe: async (): Promise<Result<unknown>> => ok({ available: false, ready: false, reason: 'distro_missing' }),
    });

    await expect(backend.execute({ operation: 'status' })).resolves.toMatchObject({ ok: true, value: {
      available: false,
      ready: false,
      reason: 'distro_missing',
    } });
  });

  it('rejects same-workspace WSL task access from another session', async () => {
    const runner: CapabilityBackend = { execute: async (): Promise<Result<unknown>> => ok({ task_id: 'task-session', state: 'running' }) };
    const backend = new WslCapabilityBackend({ platform: 'win32', runner, allowedRoots: ['C:\\workspace'] });
    const metadata = (sessionId: string): Record<string, unknown> => ({ [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId, workspaceId: 'ws-1' } });
    await backend.execute({ operation: 'run', workspaceId: 'ws-1', executable: 'node', arguments: [], cwd: 'C:\\workspace', execution: 'background', userConfirmed: true, metadata: metadata('session-a') });
    await expect(backend.execute({ operation: 'status', workspaceId: 'ws-1', task_id: 'task-session', metadata: metadata('session-b') })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(backend.execute({ operation: 'status', workspaceId: 'ws-1', task_id: 'task-session', metadata: metadata('session-a') })).resolves.toMatchObject({ ok: true });
  });
});

describe('WslFilesystemCapabilityBackend', () => {
  it('translates registered Windows paths and never exposes raw WSL filesystem access', async () => {
    const backend = new WslFilesystemCapabilityBackend({ platform: 'win32', allowedRoots: ['C:\\workspace'] });

    await expect(backend.execute({
      operation: 'translate', workspaceId: 'ws-1', direction: 'windows_to_wsl', distro: 'Ubuntu', path: 'C:\\workspace\\src',
    })).resolves.toMatchObject({ ok: true, value: { path: '/mnt/c/workspace/src', raw_access: false } });
    await expect(backend.execute({
      operation: 'translate', workspaceId: 'ws-1', direction: 'wsl_to_windows', distro: 'Ubuntu', path: '/home/user/project',
    })).resolves.toMatchObject({ ok: true, value: { path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\project', raw_access: false } });
    await expect(backend.execute({
      operation: 'translate', workspaceId: 'ws-1', direction: 'windows_to_wsl', path: 'C:\\outside',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
