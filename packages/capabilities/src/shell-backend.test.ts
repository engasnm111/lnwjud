import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { ShellCapabilityBackend } from './shell-backend.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ShellCapabilityBackend', () => {
  it.each([
    ['ordinary executable', process.execPath, ['--version']],
    ['PowerShell encoded command', 'pwsh.exe', ['-EncodedCommand', 'VwByAGkAdABlAC0ATwB1AHQAcAB1AHQA']],
    ['PowerShell dynamic command', 'powershell.exe', ['-Command', "& ('Remove'+'-Item') x"]],
    ['Node script', 'node.exe', ['cleanup.js']],
  ])('classifies unconfirmed run appropriately: %s', async (label, executable, args) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let resolutions = 0;
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      executableResolver: {
        async resolve(): Promise<Result<string>> {
          resolutions += 1;
          return ok(process.execPath);
        },
      },
    });

    const result = await backend.execute({ operation: 'run', executable, arguments: args, cwd: root, execution: 'foreground' });
    const risky = label === 'PowerShell encoded command' || label === 'PowerShell dynamic command';
    if (risky) {
      expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      expect(resolutions).toBe(0);
    } else {
      expect(result.ok).toBe(true);
      expect(resolutions).toBe(1);
    }
  });

  it('allows an unconfirmed dry run without resolving or spawning the executable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });
    const canonicalRoot = await realpath(root);
    await expect(backend.execute({
      operation: 'run', executable: 'missing-command', arguments: [], cwd: root, dry_run: true,
    })).resolves.toMatchObject({ ok: true, value: { dry_run: true, executable: 'missing-command', cwd: canonicalRoot } });
  });

  it.each([
    ['direct delete utility', 'rm', ['victim.txt']],
    ['inline PowerShell command', 'powershell.exe', ['-NoProfile', '-Command', 'Remove-Item victim.txt']],
    ['inline Node program', 'node.exe', ['-e', "process.stdout.write('inline')"]],
    ['Git purge', 'git.exe', ['clean', '-fd']],
    ['direct replacing copy', 'cp', ['source.txt', 'destination.txt']],
  ] as const)('allows risky command after explicit confirmation: %s', async (_label, executable, args) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let resolutions = 0;
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      executableResolver: {
        async resolve(): Promise<Result<string>> {
          resolutions += 1;
          return ok(process.execPath);
        },
      },
    });

    const result = await backend.execute({ operation: 'run', executable, arguments: args, cwd: root, execution: 'foreground', userConfirmed: true, metadata: { 'lnwjud.activeWorkspaceRoot.v1': root } });
    expect(result.ok).toBe(true);
    expect(resolutions).toBe(1);
  });

  it('rejects another configured root when host metadata binds the active workspace root', async () => {
    const activeRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-active-'));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-other-'));
    temporaryRoots.push(activeRoot, otherRoot);
    const backend = new ShellCapabilityBackend({ allowedRoots: [activeRoot, otherRoot], unrestricted: true });

    await expect(backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['--version'], cwd: otherRoot, dry_run: true,
      metadata: { 'lnwjud.activeWorkspaceRoot.v1': activeRoot },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('rejects a junction that is lexically inside the active workspace but resolves outside it', async () => {
    const activeRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-active-'));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-other-'));
    temporaryRoots.push(activeRoot, otherRoot);
    const escape = path.join(activeRoot, 'escape');
    await symlink(otherRoot, escape, process.platform === 'win32' ? 'junction' : 'dir');
    const backend = new ShellCapabilityBackend({ allowedRoots: [activeRoot, otherRoot] });

    await expect(backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['--version'], cwd: escape, dry_run: true,
      metadata: { 'lnwjud.activeWorkspaceRoot.v1': activeRoot },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('runs an executable with separate arguments and returns bounded output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('hello')"],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 10,
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'hello' } });
  });

  it('keeps the backend foreground wait independent from the MCP 5-second poll policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-five-seconds'), 5500)"],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 10,
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-five-seconds' } });
  }, 10_000);

  it('applies a live synchronous-wait provider without changing the backend default contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let waitSeconds = 0.05;
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], maxSynchronousWaitSecondsProvider: (): number => waitSeconds });

    const first = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', "setTimeout(() => process.stdout.write('late'), 300)"],
      cwd: root, execution: 'foreground', timeout_seconds: 5, userConfirmed: true,
    });
    expect(first).toMatchObject({ ok: true, value: { state: 'running', task_id: expect.any(String) } });
    if (first.ok) await backend.execute({ operation: 'cancel', task_id: first.value.task_id, userConfirmed: true });

    waitSeconds = 1;
    const second = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', "setTimeout(() => process.stdout.write('done'), 80)"],
      cwd: root, execution: 'foreground', timeout_seconds: 5, userConfirmed: true,
    });
    expect(second).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'done' } });
  }, 10_000);

  it('rejects a working directory outside configured local roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-outside-'));
    temporaryRoots.push(root, outside);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'process.exit(0)'],
      cwd: outside,
      execution: 'foreground',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('supports a background task handle followed by wait and result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('done'), 20)"],
      cwd: root,
      execution: 'background',
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), state: 'running' } });

    if (!started.ok) return;
    const waited = await backend.execute({ operation: 'wait', task_id: started.value.task_id, timeout_seconds: 10 });
    expect(waited).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'done' } });
    const result = await backend.execute({ operation: 'result', task_id: started.value.task_id });
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'done' } });
  });

  it('returns a running task instead of blocking an MCP call past the synchronous wait budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], maxSynchronousWaitSeconds: 0.05 });

    const startedAt = Date.now();
    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('late'), 2000)"],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 5,
    });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result).toMatchObject({ ok: true, value: { state: 'running', task_id: expect.any(String) } });
    if (result.ok) await backend.execute({ operation: 'cancel', task_id: result.value.task_id, userConfirmed: true });
  });

  it('cancels a foreground process when its caller aborts the request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let stops = 0;
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      maxSynchronousWaitSeconds: 1,
      terminator: {
        async stop(child): Promise<void> {
          stops += 1;
          if (child.exitCode !== null) return;
          const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await exited;
        },
      },
    });
    const controller = new AbortController();
    const startedAt = Date.now();

    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 300)'],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 5,
    }, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(stops).toBe(1);
  });

  it('does not spawn after cancellation wins during executable resolution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let releaseResolver!: () => void;
    let resolverStarted!: () => void;
    const resolverEntered = new Promise<void>((resolve) => { resolverStarted = resolve; });
    const resolverReleased = new Promise<void>((resolve) => { releaseResolver = resolve; });
    let stops = 0;
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      executableResolver: {
        async resolve(): Promise<Result<string>> {
          resolverStarted();
          await resolverReleased;
          return ok(process.execPath);
        },
      },
      terminator: {
        async stop(child): Promise<void> {
          stops += 1;
          if (child.exitCode !== null) return;
          const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await exited;
        },
      },
    });
    const controller = new AbortController();

    const pending = backend.execute({
      operation: 'run',
      executable: 'delayed-fixture',
      arguments: ['-e', 'process.exit(0)'],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 5,
    }, controller.signal);
    await resolverEntered;
    controller.abort();
    releaseResolver();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(stops).toBe(0);
  });

  it('retains an explicit unverified state when the root closes after termination rejection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      terminator: {
        async stop(child): Promise<void> {
          setTimeout(() => child.kill(), 20);
          throw new Error('termination not verified');
        },
      },
    });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 300)'],
      cwd: root,
      execution: 'background',
      userConfirmed: true,
      timeout_seconds: 5,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const cancelling = backend.execute({ operation: 'cancel', task_id: started.value.task_id, userConfirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(backend.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { tasks: [expect.objectContaining({ task_id: started.value.task_id, state: 'termination_unverified' })] },
    });
    const statusAfterFailure = await backend.execute({ operation: 'status', task_id: started.value.task_id });
    expect(statusAfterFailure).toMatchObject({
      ok: true,
      value: {
        state: 'termination_unverified',
        error: 'Process termination could not be verified',
      },
    });
    if (statusAfterFailure.ok) expect(statusAfterFailure.value).not.toHaveProperty('finished_at');
    await expect(Promise.race([cancelling.then(() => 'settled'), delayForTest(30).then(() => 'pending')])).resolves.toBe('pending');
  });

  it('retains an explicit unverified state when the root closes before termination rejection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      terminator: {
        async stop(child): Promise<void> {
          const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await closed;
          throw new Error('tree verification failed after root exit');
        },
      },
    });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 2000)'],
      cwd: root,
      execution: 'background',
      userConfirmed: true,
      timeout_seconds: 5,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const cancelling = backend.execute({ operation: 'cancel', task_id: started.value.task_id, userConfirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusAfterFailure = await backend.execute({ operation: 'status', task_id: started.value.task_id });
    expect(statusAfterFailure).toMatchObject({
      ok: true,
      value: { state: 'termination_unverified', error: 'Process termination could not be verified' },
    });
    if (statusAfterFailure.ok) expect(statusAfterFailure.value).not.toHaveProperty('finished_at');
    await expect(Promise.race([cancelling.then(() => 'settled'), delayForTest(30).then(() => 'pending')])).resolves.toBe('pending');
  });

  it('allows a termination-unverified task to be safely re-verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    let attempts = 0;
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      terminator: {
        async stop(child): Promise<void> {
          attempts += 1;
          if (attempts === 1) {
            const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
            child.kill();
            await closed;
            throw new Error('first verification failed');
          }
        },
      },
    });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 2000)'],
      cwd: root,
      execution: 'background',
      userConfirmed: true,
      timeout_seconds: 5,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const firstCancellation = backend.execute({ operation: 'cancel', task_id: started.value.task_id, userConfirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(backend.execute({ operation: 'status', task_id: started.value.task_id })).resolves.toMatchObject({
      ok: true,
      value: { state: 'termination_unverified' },
    });
    await expect(backend.execute({ operation: 'cancel', task_id: started.value.task_id, userConfirmed: true })).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled' },
    });
    await expect(firstCancellation).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(attempts).toBe(2);
  });

  it('caps shell wait calls so polling cannot hold the MCP connection open indefinitely', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], maxSynchronousWaitSeconds: 0.05 });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('late'), 2000)"],
      cwd: root,
      execution: 'background',
      userConfirmed: true,
      timeout_seconds: 5,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const waitStartedAt = Date.now();
    const waited = await backend.execute({ operation: 'wait', task_id: started.value.task_id, timeout_seconds: 5 });

    expect(Date.now() - waitStartedAt).toBeLessThan(200);
    expect(waited).toMatchObject({ ok: true, value: { state: 'running' } });
    await backend.execute({ operation: 'cancel', task_id: started.value.task_id, userConfirmed: true });
  });

  it('runs a Windows .cmd shim whose path contains spaces', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud shell shim-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'lnwjud-shim.cmd'), '@echo off\r\necho shell-shim-marker\r\n', 'utf8');
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: path.join(root, 'lnwjud-shim.cmd'),
      arguments: [],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
      timeout_seconds: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', exit_code: 0, stdout: expect.stringContaining('shell-shim-marker') },
    });
  });
});

function delayForTest(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('ShellCapabilityBackend unrestricted', () => {
  it('allows a working directory outside configured local roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-outside-'));
    temporaryRoots.push(root, outside);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], unrestricted: true });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('outside-ok')"],
      cwd: outside,
      execution: 'foreground',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'outside-ok' } });
  });

  it('passes the full environment through in unrestricted mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], unrestricted: true });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write(process.env.LNWJUD_ENV_PROBE ?? 'missing')"],
      cwd: root,
      execution: 'foreground',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { stdout: 'missing' } });
  });

  it('still blocks delete-like commands in unrestricted mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], unrestricted: true });

    const result = await backend.execute({
      operation: 'run',
      executable: 'del',
      arguments: ['file.txt'],
      cwd: root,
      execution: 'foreground',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
  });

  it('allows git rm and git reset as dry-run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      unrestricted: true,
      executableResolver: { async resolve(executable: string): Promise<Result<string>> { return ok(executable); } },
    });

    const rm = await backend.execute({
      operation: 'run',
      executable: 'git',
      arguments: ['rm', 'file.txt'],
      cwd: root,
      dry_run: true,
      execution: 'foreground',
    });
    const reset = await backend.execute({
      operation: 'run',
      executable: 'git.exe',
      arguments: ['reset', '--hard'],
      cwd: root,
      dry_run: true,
      execution: 'foreground',
    });

    expect(rm).toMatchObject({ ok: true, value: { dry_run: true } });
    expect(reset).toMatchObject({ ok: true, value: { dry_run: true } });
  });

  it('does not treat powershell git rm as a filesystem delete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      unrestricted: true,
      executableResolver: { async resolve(executable: string): Promise<Result<string>> { return ok(executable); } },
    });

    const result = await backend.execute({
      operation: 'run',
      executable: 'powershell',
      arguments: ['-NoProfile', '-Command', 'git rm file.txt'],
      cwd: root,
      dry_run: true,
      execution: 'foreground',
    });

    expect(result).toMatchObject({ ok: true, value: { dry_run: true } });
  });

  it('persists durable task ownership and rejects another session in the same workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-owner-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const owner = (sessionId: string): { metadata: Record<string, unknown> } => ({
      metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId, workspaceId: 'workspace-1' } },
    });
    const backendA = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await backendA.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: root, execution: 'background', timeout_seconds: 10, userConfirmed: true, ...owner('session-a'),
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String) } });
    if (!started.ok) return;
    const taskId = String(started.value.task_id);

    const backendB = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await expect(backendB.execute({ operation: 'status', task_id: taskId, ...owner('session-b') })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(backendB.execute({ operation: 'list', ...owner('session-b') })).resolves.toMatchObject({ ok: true, value: { tasks: [] } });
    await expect(backendB.execute({ operation: 'status', task_id: taskId, ...owner('session-a') })).resolves.toMatchObject({ ok: true });
    await expect(backendB.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true, ...owner('session-a') })).resolves.toMatchObject({ ok: true });
  });
});
