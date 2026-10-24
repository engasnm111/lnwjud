import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellCapabilityBackend as BaseShellCapabilityBackend, type ShellCapabilityOptions } from './shell-backend.js';
import { DurableShellTaskStore as BaseDurableShellTaskStore, durableShellRequestDigest, parsePosixProcessProbe } from './durable-shell-task-store.js';
import { nativeFixture } from '../../process/test/native-fixture.js';
import type { WindowsNativeAuthority } from '@lnwjud/process';
import type { InvocationAuthorization } from '@lnwjud/domain';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { PosixProcessGroupObservation } from '@lnwjud/process';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const temporaryRoots: string[] = [];
let nativeAuthority: WindowsNativeAuthority | undefined;

beforeEach(async () => {
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-authority-'));
  temporaryRoots.push(root);
  nativeAuthority = (await nativeFixture(root)).authority;
});

class DurableShellTaskStore extends BaseDurableShellTaskStore {
  constructor(directory: string, options: NonNullable<ConstructorParameters<typeof BaseDurableShellTaskStore>[1]> = {}) {
    super(directory, { ...options, ...(nativeAuthority === undefined ? {} : { windowsNativeAuthority: nativeAuthority }) });
  }
}

class ShellCapabilityBackend extends BaseShellCapabilityBackend {
  constructor(options: ShellCapabilityOptions) {
    super({ ...options, ...(nativeAuthority === undefined ? {} : { windowsNativeAuthority: nativeAuthority }) });
  }

  override execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): ReturnType<BaseShellCapabilityBackend['execute']> {
    return super.execute({
      ...(input as Record<string, unknown>),
      metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'legacy', sessionId: 'legacy', workspaceId: 'test-workspace' } },
    }, signal, authorization);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 50 : 0,
    retryDelay: 200,
  })));
});

describe('durable shell background tasks', () => {
  it('preserves a just-reserved POSIX worker during identity capture but fails closed after grace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-bootstrap-'));
    temporaryRoots.push(root);
    const taskId = 'bootstrap-admission';
    const directory = path.join(root, taskId);
    await mkdir(directory);
    const started = new Date().toISOString();
    const metadata = {
      version: 2, task_id: taskId, state: 'running',
      request_digest: 'a'.repeat(64), containment: 'posix_group_v1',
      started_at: started, deadline_at: new Date(Date.now() + 60_000).toISOString(),
      include_stdout: false, include_stderr: false, max_output_bytes: 1024,
    };
    const file = path.join(directory, 'task.json');
    await writeFile(file, JSON.stringify(metadata));
    const store = new DurableShellTaskStore(root, { platform: 'linux' });
    expect(await store.snapshot(taskId)).toMatchObject({ ok: true, value: { state: 'running' } });
    await writeFile(file, JSON.stringify({ ...metadata, started_at: new Date(Date.now() - 15_000).toISOString() }));
    expect(await store.snapshot(taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
  });


  it('keeps waiting through provisional termination-unverified state until a canonical terminal write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wait-reconcile-'));
    temporaryRoots.push(root);
    const taskId = 'worker-still-reconciling';
    const directory = path.join(root, taskId);
    await mkdir(directory);
    const record = {
      version: 1, task_id: taskId, state: 'termination_unverified',
      started_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 10000).toISOString(),
      include_stdout: false, include_stderr: false, max_output_bytes: 1024,
    };
    const metadataPath = path.join(directory, 'task.json');
    await writeFile(metadataPath, JSON.stringify(record));
    const finalize = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(metadataPath, JSON.stringify({
          ...record, state: 'completed', exit_code: 0, finished_at: new Date().toISOString(),
        })).then(resolve, reject);
      }, 160);
    });
    const result = await new DurableShellTaskStore(root).wait(taskId, 1);
    await finalize;
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
  });

  it('keeps POSIX orphaned and unknown group reservations across restart, then recovers once without replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-recovery-'));
    temporaryRoots.push(root);
    const owner = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' };
    const request = { taskId: 'orphaned-group', executable: process.execPath, arguments: ['-e', 'process.exit(0)'],
      cwd: root, timeoutSeconds: 10, maxOutputBytes: 1024, includeStdout: true, includeStderr: false, owner };
    const digest = durableShellRequestDigest(request);
    const taskDirectory = path.join(root, request.taskId);
    const markerDirectory = path.join(root, '.index', 'v1', 'active');
    await mkdir(taskDirectory, { recursive: true });
    await mkdir(markerDirectory, { recursive: true });
    const marker = path.join(markerDirectory, createHash('sha256').update(request.taskId).digest('hex') + '.json');
    await writeFile(marker, JSON.stringify({ version: 1, taskId: request.taskId, requestDigest: digest, mutationKind: 'opaque',
      reservedAt: new Date().toISOString(), ownerClientId: owner.clientId, ownerWorkspaceId: owner.workspaceId }));
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1, task_id: request.taskId, request_digest: digest, containment: 'posix_group_v1', state: 'running',
      child_pid: 4242, child_started_at: '2026-10-18T00:00:00.000Z',
      started_at: new Date(Date.now() - 60_000).toISOString(), deadline_at: new Date().toISOString(),
      include_stdout: true, include_stderr: false, max_output_bytes: 1024,
      owner_client_id: owner.clientId, owner_session_id: owner.sessionId, owner_workspace_id: owner.workspaceId,
    }));
    let observation: PosixProcessGroupObservation = { state: 'live', livePids: [4243] };
    const options = { platform: 'linux' as const, posixGroupInspector: async (): Promise<PosixProcessGroupObservation> => observation };
    const store = new DurableShellTaskStore(root, options);
    expect(await store.snapshot(request.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await store.inspectForWriterAdmission(request.taskId)).toBe('unknown');
    expect(await readFile(marker, 'utf8')).toContain(digest);
    observation = { state: 'unknown', reason: 'root_identity_changed' };
    const restarted = new DurableShellTaskStore(root, options);
    expect(await restarted.snapshot(request.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await readFile(marker, 'utf8')).toContain(digest);
    observation = { state: 'empty' };
    const mac = new DurableShellTaskStore(root, { ...options, platform: 'darwin' });
    expect(await mac.snapshot(request.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await readFile(marker, 'utf8')).toContain(digest);
    expect(await restarted.snapshot(request.taskId)).toMatchObject({ ok: true, value: { state: 'failed' } });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await restarted.launch(request)).toMatchObject({ ok: true, value: { state: 'failed' } });
    expect(await readdir(taskDirectory)).toEqual(['task.json']);
  });

  it('rejects macOS durable shell commands before launch when escaped descendants cannot be fenced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-macos-failclosed-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(root, { platform: 'darwin' });
    const request = {
      taskId: 'no-macos-shell', executable: process.execPath, arguments: ['--version'], cwd: root,
      timeoutSeconds: 10, maxOutputBytes: 1024, includeStdout: true, includeStderr: false,
      owner: { clientId: 'owner', sessionId: 'session', workspaceId: 'workspace' },
    };
    expect(await store.launch(request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(readdir(path.join(root, request.taskId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses legacy active POSIX PID-only recovery and cancellation even when tracked roots are missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-legacy-'));
    temporaryRoots.push(root);
    const taskDirectory = path.join(root, 'legacy-active');
    await mkdir(taskDirectory);
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1, task_id: 'legacy-active', state: 'running', child_pid: 2147483646, worker_pid: 2147483645,
      started_at: new Date(Date.now() - 60_000).toISOString(), deadline_at: new Date().toISOString(),
      include_stdout: false, include_stderr: false, max_output_bytes: 1024,
    }));
    const inspect = vi.fn(async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }));
    const store = new DurableShellTaskStore(root, { platform: 'linux', posixGroupInspector: inspect });
    expect(await store.inspectForWriterAdmission('legacy-active')).toBe('unknown');
    expect(await store.cancel('legacy-active')).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(inspect).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(taskDirectory, 'task.json'), 'utf8')).state).toBe('running');
  });

  it.skipIf(process.platform !== 'linux').each([false, true])('holds durable POSIX admission until inherited-pipe writer finishes (detached descendant: %s)', async (detached) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-posix-descendant-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, 'tasks'));
    const childScript = "setTimeout(() => process.stdout.write('descendant-finished'), 2000)";
    const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: ${detached}, stdio: ['ignore', 1, 2] }).unref();`;
    const request = { taskId: 'posix-parent', executable: process.execPath, arguments: ['-e', parentScript], cwd: root,
      timeoutSeconds: 10, maxOutputBytes: 1024, includeStdout: true, includeStderr: false,
      owner: { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' } };
    expect(await store.launch(request)).toMatchObject({ ok: true });
    await waitUntil(async () => (await store.inspectForWriterAdmission(request.taskId)) === 'unknown', 5000);
    expect(await store.launch({ ...request, taskId: 'overlapping-import', mutationKind: 'repository_import' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const restarted = new DurableShellTaskStore(path.join(root, 'tasks'));
    expect(await restarted.wait(request.taskId, 5, undefined, request.owner))
      .toMatchObject({ ok: true, value: { state: 'completed', stdout: 'descendant-finished' } });
  }, 15000);

  it.skipIf(process.platform !== 'win32')('holds foreground shell admission until explicit cancellation has native proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-foreground-admission-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, 'tasks');
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const controller = new AbortController();
    const foreground = backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root, execution: 'foreground', timeout_seconds: 40, userConfirmed: true,
    }, controller.signal);
    const store = new DurableShellTaskStore(taskStateDirectory);
    let taskId = '';
    await waitUntil(async () => {
      for (const entry of await readdir(taskStateDirectory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name === '.index') continue;
        const metadata = await readFile(path.join(taskStateDirectory, entry.name, 'task.json'), 'utf8').then((value) => JSON.parse(value)).catch(() => undefined);
        if (metadata?.state === 'running') { taskId = entry.name; return true; }
      }
      return false;
    }, 10000);
    const importRequest = {
      taskId: 'import-after-foreground-' + randomUUID(), mutationKind: 'repository_import' as const,
      executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: root,
      timeoutSeconds: 10, maxOutputBytes: 1024, includeStdout: false, includeStderr: false,
      owner: { clientId: 'other-client', sessionId: 'other-session', workspaceId: 'other-workspace' },
    };
    expect(await store.launch(importRequest)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    controller.abort();
    expect(await foreground).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
    expect(await store.launch(importRequest)).toMatchObject({ ok: true });
    expect(await store.wait(importRequest.taskId, 15, undefined, importRequest.owner)).toMatchObject({ ok: true, value: { state: 'completed' } });
  }, 45000);

  it('does not expose a matching task to a different transient session through ordinary launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-launch-owner-'));
    temporaryRoots.push(root);
    const directory = path.join(root, 'existing');
    await mkdir(directory);
    const owner = { clientId: 'client', sessionId: 'original-session', workspaceId: 'workspace' };
    const request = {
      taskId: 'existing', executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: root,
      timeoutSeconds: 10, maxOutputBytes: 1024, includeStdout: true, includeStderr: false, owner,
    };
    await writeFile(path.join(directory, 'task.json'), JSON.stringify({
      version: 1, task_id: request.taskId, state: 'completed', request_digest: durableShellRequestDigest(request),
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), exit_code: 0,
      include_stdout: true, include_stderr: false, max_output_bytes: 1024, deadline_at: new Date().toISOString(),
      owner_client_id: owner.clientId, owner_session_id: owner.sessionId, owner_workspace_id: owner.workspaceId,
    }));
    await writeFile(path.join(directory, 'stdout.log'), 'private session output');
    expect(await new DurableShellTaskStore(root).launch({ ...request, owner: { ...owner, sessionId: 'other-session' } })).toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
    expect(await new DurableShellTaskStore(root).launchReserved({ ...request, owner: { ...owner, sessionId: 'automation-recovery' } }, durableShellRequestDigest(request))).toMatchObject({
      ok: true, value: { state: 'completed', stdout: 'private session output' },
    });
  });

  it('keeps legacy native terminal history unverified without changing its bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-legacy-native-proof-'));
    temporaryRoots.push(root);
    const directory = path.join(root, 'legacy');
    await mkdir(directory);
    const metadata = JSON.stringify({
      version: 1, task_id: 'legacy', state: 'completed', containment: 'windows_job_v1',
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), exit_code: 0,
      include_stdout: false, include_stderr: false, max_output_bytes: 1024,
      deadline_at: new Date().toISOString(),
    });
    await writeFile(path.join(directory, 'task.json'), metadata);
    await writeFile(path.join(directory, 'containment.receipt.json'), JSON.stringify({ kind: 'windows_job_v1', activeProcesses: 0, exitCode: 0 }));
    const snapshot = await new DurableShellTaskStore(root).snapshot('legacy');
    expect(snapshot).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await readFile(path.join(directory, 'task.json'), 'utf8')).toBe(metadata);
  });

  it.each((['win32', 'linux'] as const).flatMap((platform) =>
    (['starting', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'termination_unverified'] as const)
      .map((state) => ({ platform, state }))))('keeps $state history without containment unverified for Goals on $platform', async ({ platform, state }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-legacy-uncontained-terminal-'));
    temporaryRoots.push(root);
    const taskId = `legacy-${platform}`;
    const directory = path.join(root, taskId);
    const active = path.join(root, '.index', 'v1', 'active');
    await mkdir(directory, { recursive: true });
    await mkdir(active, { recursive: true });
    const digest = 'f'.repeat(64);
    const marker = path.join(active, createHash('sha256').update(taskId).digest('hex') + '.json');
    await writeFile(marker, JSON.stringify({ version: 1, taskId, requestDigest: digest, mutationKind: 'opaque',
      ownerClientId: 'legacy-owner', ownerWorkspaceId: 'legacy-workspace', reservedAt: new Date().toISOString() }));
    const metadata = JSON.stringify({
      version: 1, task_id: taskId, request_digest: digest, state,
      started_at: '2026-10-18T00:00:00.000Z', finished_at: '2026-10-18T00:00:01.000Z', exit_code: 0,
      worker_pid: 2_147_483_646, child_pid: 2_147_483_645,
      owner_client_id: 'legacy-owner', owner_session_id: 'legacy-session', owner_workspace_id: 'legacy-workspace',
      include_stdout: true, include_stderr: false, max_output_bytes: 1024, deadline_at: '2026-10-18T00:01:00.000Z',
    });
    await writeFile(path.join(directory, 'task.json'), metadata);
    await writeFile(path.join(directory, 'stdout.log'), 'legacy output\n');
    const store = new DurableShellTaskStore(root, { platform });
    const cancel = vi.spyOn(store, 'cancel');
    const originalFiles = await readdir(directory);
    const originalMarker = await readFile(marker, 'utf8');
    expect(await store.inspectForWriterAdmission(taskId)).toBe('unknown');
    const history = await store.snapshot(taskId);
    expect(history).toMatchObject({ ok: true, value: { state, exit_code: 0, finished_at: '2026-10-18T00:00:01.000Z', stdout: 'legacy output\n' } });
    vi.mocked(open).mockClear();
    expect(await store.snapshotForGoalLiveness(taskId, 'another-workspace')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await store.snapshotForGoalEvidence(taskId, 'another-workspace')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await store.cancelForGoal(taskId, 'another-owner', 'legacy-workspace')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await store.cancelForGoal(taskId, 'legacy-owner', 'another-workspace')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const liveness = await store.snapshotForGoalLiveness(taskId, 'legacy-workspace');
    expect(liveness).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    if (!liveness.ok) throw new Error(liveness.error.message);
    expect(liveness.value).not.toHaveProperty('exit_code');
    expect(liveness.value).not.toHaveProperty('finished_at');
    expect(liveness.value).not.toHaveProperty('stdout');
    expect(await store.snapshotForGoalEvidence(taskId, 'legacy-workspace')).toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('authenticated containment proof') },
    });
    expect(await store.cancelForGoal(taskId, 'legacy-owner', 'legacy-workspace')).toMatchObject({
      ok: true, value: { matched: true, state: 'termination_unverified' },
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await store.inspectForWriterAdmission(taskId)).toBe('unknown');
    expect(await store.snapshot(taskId)).toEqual(history);
    expect(await readFile(path.join(directory, 'stdout.log'), 'utf8')).toBe('legacy output\n');
    expect(await readFile(path.join(directory, 'task.json'), 'utf8')).toBe(metadata);
    expect(await readFile(marker, 'utf8')).toBe(originalMarker);
    expect(await readdir(directory)).toEqual(originalFiles);
  });

  it.skipIf(process.platform !== 'win32')('rejects unverifiable native proof after restart and recovers without replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-late-native-proof-'));
    temporaryRoots.push(root);
    const state = path.join(root, 'tasks');
    const output = path.join(root, 'once.txt');
    const taskId = 'late-' + randomUUID();
    const owner = { clientId: 'late-owner', sessionId: 'late-session', workspaceId: 'late-workspace' };
    const request = {
      taskId, executable: process.execPath,
      arguments: ['-e', "require('node:fs').appendFileSync(process.argv[1], 'once\\n')", output], cwd: root,
      timeoutSeconds: 30, maxOutputBytes: 1024, includeStdout: true, includeStderr: true, owner,
    };
    const first = new DurableShellTaskStore(state);
    expect((await first.launch(request)).ok).toBe(true);
    await waitUntil(async () => {
      const metadata = JSON.parse(await readFile(path.join(state, taskId, 'task.json'), 'utf8'));
      return metadata.state === 'completed';
    }, 30000);
    const recorded = JSON.parse(await readFile(path.join(state, taskId, 'task.json'), 'utf8'));
    const replacement = new DurableShellTaskStore(state);
    const inspector = vi.spyOn(nativeAuthority!, 'inspect').mockResolvedValue({
      state: 'termination_unknown', binding: recorded.containmentBinding, reason: 'SIMULATED_NATIVE_PROOF_UNAVAILABLE',
    });
    try {
      expect(await replacement.snapshot(taskId, undefined, owner)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
      expect(await replacement.launch(request)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
      expect(await replacement.launch({ ...request, arguments: ['-e', 'process.exit(0)'] }))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await readFile(output, 'utf8')).toBe('once\n');
    } finally {
      inspector.mockRestore();
    }
    expect(await replacement.wait(taskId, 15, undefined, owner)).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    expect(await replacement.launch(request)).toMatchObject({ ok: true, value: { state: 'completed' } });
    expect(await readFile(output, 'utf8')).toBe('once\n');
  }, 45000);


  it.skipIf(process.platform === 'darwin')('isolates repository import child environment without changing ordinary shell behavior', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-env-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'env-owner', sessionId: 'env-session', workspaceId: 'env-workspace' };
    const key = 'LNWJUD_IMPORT_CANARY_SECRET';
    const previous = process.env[key];
    process.env[key] = 'should-not-leak-to-repository-import';
    try {
      for (const kind of ['repository_import', 'opaque'] as const) {
        const id = (kind === 'repository_import' ? 'isolated-import-' : 'ordinary-shell-') + randomUUID();
        const launched = await store.launch({
          mutationKind: kind, taskId: id, executable: process.execPath,
          arguments: ['-e', 'process.stdout.write(process.env.LNWJUD_IMPORT_CANARY_SECRET ? "leaked" : "isolated")'],
          cwd: root, timeoutSeconds: process.env.CI ? 100 : 15, maxOutputBytes: 256,
          includeStdout: true, includeStderr: false, owner,
        });
        expect(launched.ok).toBe(true);
        await expect.poll(async () => {
          const observation = await store.snapshot(id);
          return observation.ok ? observation.value.state : 'unknown';
        }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
        const evidence = await store.snapshotForGoalEvidence(id, owner.workspaceId);
        expect(evidence).toMatchObject({
          ok: true, value: { stdout: kind === 'repository_import' ? 'isolated' : 'leaked' },
        });
      }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }, process.env.CI ? 160000 : 30000);

  it.skipIf(process.platform === 'darwin')('holds an import-exclusive reservation through real contained worker lifetime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-worker-lifetime-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const first = new DurableShellTaskStore(state);
    const second = new DurableShellTaskStore(state);
    const importId = 'secure-import-' + randomUUID();
    const opaqueId = 'opaque-worker-' + randomUUID();
    const afterId = 'after-' + randomUUID();
    const importRequest = {
      taskId: importId, mutationKind: 'repository_import' as const,
      executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 2500)'],
      cwd: root, timeoutSeconds: process.env.CI ? 110 : 12, maxOutputBytes: 1024, includeStdout: false, includeStderr: false,
      owner: { clientId: 'owner', sessionId: 'session', workspaceId: 'workspace-1' },
    };
    const launched = await first.launch(importRequest);
    expect(launched.ok).toBe(true);
    const conflicting = await second.launch({
      ...importRequest, taskId: opaqueId, mutationKind: 'opaque',
      owner: { clientId: 'other-owner', sessionId: 'other-session', workspaceId: 'workspace-2' },
    });
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect.poll(async () => {
      const status = await first.snapshot(importId);
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
    const after = await second.launch({
      ...importRequest, taskId: afterId, mutationKind: 'opaque',
      arguments: ['-e', 'process.exit(0)'],
    });
    expect(after.ok).toBe(true);
    await expect.poll(async () => {
      const status = await second.snapshot(afterId);
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
  }, process.env.CI ? 160000 : 30000);

  it.skipIf(process.platform !== 'win32')('keeps durable ownership until detached descendants finish and persists native zero-active proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-contained-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const taskId = 'contained-' + randomUUID();
    const store = new DurableShellTaskStore(state);
    const marker = path.join(root, 'finished.txt');
    const childScript = path.join(root, 'child.cjs');
    await writeFile(childScript, [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),1500)\",process.argv[2]],{detached:true,stdio:'ignore'}).unref();",
    ].join('\n'));
    const result = await store.launch({
      taskId, executable: process.execPath, arguments: [childScript, marker], cwd: root,
      timeoutSeconds: 15, maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
      owner: { clientId: 'a', sessionId: 'a', workspaceId: 'a' },
    });
    expect(result.ok).toBe(true);
    await expect.poll(async () => {
      const status = await store.snapshot(taskId);
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: 10000 }).toBe('completed');
    expect(await readFile(marker, 'utf8').catch(() => 'not finished')).toBe('done');
    const metadata = JSON.parse(await readFile(path.join(state, taskId, 'task.json'), 'utf8'));
    expect(await nativeAuthority?.inspect({ directory: path.join(state, taskId), binding: metadata.containmentBinding })).toMatchObject({ state: 'terminal_verified', activeProcesses: 0 });
  }, 15000);

  it.skipIf(process.platform === 'darwin')('keeps liveness output-free but returns bounded terminal CI proof only to its workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-evidence-proof-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const taskId = 'proof-' + randomUUID();
    const owner = { clientId: 'proof-client', sessionId: 'proof-session', workspaceId: 'workspace-evidence' };
    const output = JSON.stringify({ headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success' });
    const start = await store.launch({
      taskId, commandFingerprint: 'a'.repeat(64), executable: process.execPath,
      arguments: ['-e', `process.stdout.write(${JSON.stringify(output)})`], cwd: root,
      timeoutSeconds: 30, maxOutputBytes: 4096, includeStdout: true, includeStderr: true, owner,
    });
    expect(start.ok).toBe(true);
    await expect.poll(async () => {
      const current = await store.snapshotForGoalLiveness(taskId, owner.workspaceId);
      return current.ok ? current.value.state : 'error';
    }, { timeout: 30000 }).toBe('completed');
    const alive = await store.snapshotForGoalLiveness(taskId, owner.workspaceId);
    expect(alive).toMatchObject({ ok: true, value: { state: 'completed', command_fingerprint: 'a'.repeat(64) } });
    if (alive.ok) expect(alive.value).not.toHaveProperty('stdout');
    const verified = await store.snapshotForGoalEvidence(taskId, owner.workspaceId);
    expect(verified).toMatchObject({ ok: true, value: { stdout: output, state: 'completed', exit_code: 0 } });
    const foreign = await store.snapshotForGoalEvidence(taskId, 'another-workspace');
    expect(foreign).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  }, 45000);

  it.skipIf(process.platform === 'darwin')('fails closed for truncated terminal stdout evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-evidence-truncated-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const taskId = 'proof-truncated-' + randomUUID();
    const owner = { clientId: 'proof', sessionId: 'proof', workspaceId: 'workspace-evidence' };
    const start = await store.launch({
      taskId, executable: process.execPath,
      arguments: ['-e', "process.stdout.write('X'.repeat(2048))"], cwd: root,
      timeoutSeconds: 15, maxOutputBytes: 64, includeStdout: true, includeStderr: true, owner,
    });
    expect(start.ok).toBe(true);
    await expect.poll(async () => {
      const status = await store.snapshot(taskId);
      return status.ok ? status.value.state : 'error';
    }, { timeout: 10000 }).toBe('completed');
    expect(await store.snapshotForGoalEvidence(taskId, owner.workspaceId)).toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    });
  }, 15000);

  it('treats an exited POSIX zombie as terminated without trusting a reused live PID', () => {
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Z+')).toEqual({ state: 'gone' });
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Ssl')).toMatchObject({
      state: 'live',
      processStartedAt: expect.any(String),
    });
    expect(parsePosixProcessProbe('not-a-valid-ps-row')).toEqual({ state: 'unverifiable', reason: 'invalid_probe_response' });
  });

  it.skipIf(process.platform !== 'linux')('cancels the detached child group before retiring its durable worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-groups-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks') });
    const started = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root, execution: 'background', timeout_seconds: 40, userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);
    let childPid: number | undefined;
    let childStartedAt: string | undefined;
    try {
      await expect.poll(async () => {
        const status = await backend.execute({ operation: 'status', task_id: taskId });
        if (status.ok) {
          const value = status.value as Record<string, unknown>;
          if (typeof value.child_pid === 'number' && typeof value.child_started_at === 'string') {
            childPid = value.child_pid;
            childStartedAt = value.child_started_at;
            return true;
          }
        }
        return false;
      }, { timeout: 5000 }).toBe(true);
      const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      // Red-phase cleanup is restricted to the exact fixture child identity.
      if (childPid !== undefined && childStartedAt !== undefined) {
        const probe = await promisify(execFile)('ps', ['-p', String(childPid), '-o', 'lstart=']).catch(() => null);
        if (probe && new Date(probe.stdout.trim()).toISOString() === childStartedAt) process.kill(-childPid, 'SIGKILL');
      }
    }
  }, 15000);

  it.skipIf(process.platform === 'darwin')('survives a backend/runtime replacement and returns logs and result by task id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });

    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('durable-done'), 300)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const waited = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(waited).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'durable-done', durable: true },
    });
    await expect(replacementRuntime.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]) },
    });
  }, 15_000);

  it('does not overwrite terminal metadata when Windows-style PID reuse is observed during reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-pid-reuse-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'pid-reused-finalizing';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const metadataPath = path.join(taskDirectory, 'task.json');
    const runningMetadata = {
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      worker_pid: process.pid,
      // The live PID belongs to this Vitest process, not the original durable worker.
      worker_started_at: '2000-01-01T00:00:00.000Z',
    } as const;
    await writeFile(metadataPath, JSON.stringify(runningMetadata), 'utf8');

    const finalized = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(metadataPath, JSON.stringify({
          ...runningMetadata,
          state: 'completed',
          exit_code: 0,
          finished_at: new Date().toISOString(),
        }), 'utf8').then(() => resolve(), reject);
      }, 100);
    });

    const store = new DurableShellTaskStore(taskStateDirectory);
    const result = await store.snapshot(taskId);
    await finalized;
    expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
    expect(await store.snapshot(taskId)).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
  }, 15_000);

  it('does not overwrite a concurrent completion when worker identity probing is unverifiable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-probe-race-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'probe-unverifiable-finalizing';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const metadataPath = path.join(taskDirectory, 'task.json');
    const runningMetadata = {
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      // Invalid for an OS process probe, which deterministically models an
      // unverifiable worker identity without depending on the host platform.
      worker_pid: 2_147_483_648,
      worker_started_at: '2000-01-01T00:00:00.000Z',
    } as const;
    await writeFile(metadataPath, JSON.stringify(runningMetadata), 'utf8');

    const finalized = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(metadataPath, JSON.stringify({
          ...runningMetadata,
          state: 'completed',
          exit_code: 0,
          finished_at: new Date().toISOString(),
        }), 'utf8').then(() => resolve(), reject);
      }, 100);
    });

    const store = new DurableShellTaskStore(taskStateDirectory);
    const result = await store.snapshot(taskId);
    await finalized;
    expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
    await expect(readFile(metadataPath, 'utf8').then((value) => JSON.parse(value))).resolves.toMatchObject({
      state: 'completed',
      exit_code: 0,
    });
    expect(await store.snapshot(taskId)).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
  }, 15_000);

  it.skipIf(process.platform === 'darwin')('does not overwrite a very fast durable completion back to running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      autoWaitSeconds: 1,
    });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('fast')"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!result.ok) return;
    const taskId = String((result.value as Record<string, unknown>).task_id);
    const terminal = ['starting', 'running'].includes(String((result.value as Record<string, unknown>).state))
      ? await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 })
      : result;
    expect(terminal).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true } });
    if (!terminal.ok) return;
    const workerPid = Number((terminal.value as Record<string, unknown>).worker_pid);
    expect(Number.isInteger(workerPid)).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(workerPid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 2000, interval: 50 }).toBe(false);

    await expect(backend.execute({ operation: 'status', task_id: taskId })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true },
    });
  }, 15_000);

  it.skipIf(process.platform === 'darwin')('retains Windows containment until a detached descendant closes inherited stdio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
    });
    const script = [
      "const { spawn } = require('node:child_process');",
      "const os = require('node:os');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2200)'], {",
      "cwd: os.tmpdir(), detached: true, stdio: ['ignore', process.stdout, process.stderr] });",
      "grandchild.unref();",
      "process.stdout.write('parent-done');",
    ].join('');

    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', script],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    try {
      const beforeDescendantExit = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 0.25 });
      if (process.platform === 'win32') {
        expect(beforeDescendantExit).toMatchObject({ ok: true, value: { state: expect.stringMatching(/^(starting|running)$/), durable: true } });
      }
      const terminal = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 6 });
      expect(terminal).toMatchObject({
        ok: true,
        value: { state: 'completed', exit_code: 0, stdout: 'parent-done', durable: true },
      });
    } finally {
      const current = await backend.execute({ operation: 'status', task_id: taskId });
      if (current.ok && (current.value as Record<string, unknown>).state === 'running') {
        await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
      }
    }
  }, 20000);

  // Replacement cancellation probes worker identity and may invoke taskkill;
  // PowerShell startup can exceed Vitest's 5s default on a busy Windows host.
  it.skipIf(process.platform === 'darwin')('cancels a durable task from a replacement backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 60,
      userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await waitUntil(async () => {
      const status = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
      if (!status.ok) return false;
      const value = status.value as Record<string, unknown>;
      return typeof value.worker_pid === 'number'
        && typeof value.worker_started_at === 'string'
        && typeof value.child_pid === 'number'
        && typeof value.child_started_at === 'string';
    }, 15_000);
    const cancelled = await replacementRuntime.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });

    expect(cancelled).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
  }, 45_000);

  it.skipIf(process.platform === 'darwin')('keeps a durable auto task running when the original MCP caller aborts after submission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory,
      autoWaitSeconds: 0.3,
      maxSynchronousWaitSeconds: 0.3,
    });
    const controller = new AbortController();
    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-abort'), 600)"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const submitted = await running;
    // A fast host may complete the durable child before the auto response is observed.
    // Either state must retain a durable identity and the successful terminal receipt.
    expect(submitted).toMatchObject({ ok: true, value: { state: expect.stringMatching(/^(starting|running|completed)$/), task_id: expect.any(String), durable: true } });
    if (!submitted.ok) return;
    const taskId = String((submitted.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const finished = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 20 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-abort', durable: true } });
  }, 45000);

  it.skipIf(process.platform === 'darwin')('caps concurrent durable workers so many chats cannot exhaust a Windows 10/11 machine with child consoles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-cap-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(taskStateDirectory, { maxConcurrentTasks: 1 });
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const common = {
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;

    const first = await store.launch({ taskId: 'task-one', ...common });
    expect(first).toMatchObject({ ok: true, value: { task_id: 'task-one', state: process.platform === 'win32' ? 'starting' : 'running' } });

    try {
      const second = await store.launch({ taskId: 'task-two', ...common });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: 'CONFLICT',
          recoverable: true,
        },
      });
    } finally {
      if (first.ok) await store.cancel('task-one', owner);
    }
  }, 15_000);
  it.skipIf(process.platform === 'darwin')('does not hydrate historical durable output while enforcing the concurrency limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-memory-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const historicalId = 'historical-completed';
    const historicalDirectory = path.join(taskStateDirectory, historicalId);
    await mkdir(historicalDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(historicalDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: historicalId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const historicalOutputPath = path.join(historicalDirectory, 'stdout.log');
    await writeFile(historicalOutputPath, Buffer.alloc(2 * 1024 * 1024, 0x61));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const launched = await store.launch({
      taskId: 'new-task',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('ok')"],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(launched.ok).toBe(true);

    const historicalOutputReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename) === historicalOutputPath,
    );
    expect(historicalOutputReads).toEqual([]);

    if (launched.ok) await store.wait('new-task', 5, undefined, owner);
  }, 15_000);

  it.skipIf(process.platform === 'darwin')('uses the persisted active index on warm launch without rescanning terminal task sidecars', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-warm-index-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const request = {
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('ok')"],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;
    const terminalSidecars = new Set<string>();
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const taskId = `historical-${String(index).padStart(3, '0')}`;
      const taskDirectory = path.join(taskStateDirectory, taskId);
      await mkdir(taskDirectory, { recursive: true });
      const startedAt = new Date(Date.now() - 10_000 - index).toISOString();
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'completed',
        started_at: startedAt,
        finished_at: new Date(Date.now() - 5_000 - index).toISOString(),
        exit_code: 0,
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
      }), 'utf8');
      terminalSidecars.add(path.join(taskDirectory, 'task.json'));
      terminalSidecars.add(path.join(taskDirectory, 'worker.pid'));
      terminalSidecars.add(path.join(taskDirectory, 'worker.started'));
    }));

    const indexDirectory = path.join(taskStateDirectory, '.index', 'v1');
    await mkdir(path.join(indexDirectory, 'active'), { recursive: true });
    await writeFile(path.join(indexDirectory, 'ready.json'), JSON.stringify({
      version: 1, markerFormatVersion: 2, readyAt: new Date().toISOString(),
    }));
    await writeFile(path.join(indexDirectory, 'launches.jsonl'), '');

    const firstId = 'first-terminal-' + randomUUID();
    const secondId = 'second-running-' + randomUUID();
    const firstStore = new DurableShellTaskStore(taskStateDirectory);
    const first = await firstStore.launch({ taskId: firstId, ...request });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    await expect(firstStore.wait(firstId, 5, undefined, owner)).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed' },
    });

    const terminalDirectory = path.join(taskStateDirectory, firstId);
    terminalSidecars.add(path.join(terminalDirectory, 'task.json'));
    terminalSidecars.add(path.join(terminalDirectory, 'worker.pid'));
    terminalSidecars.add(path.join(terminalDirectory, 'worker.started'));
    vi.mocked(readFile).mockClear();

    const replacementStore = new DurableShellTaskStore(taskStateDirectory);
    const second = await replacementStore.launch({ taskId: secondId, ...request });
    expect(second.ok).toBe(true);
    const terminalReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => terminalSidecars.has(String(filename)),
    );
    expect(terminalReads).toEqual([]);

    if (second.ok) await replacementStore.wait(secondId, 5, undefined, owner);
  }, 20_000);

  it('hydrates only one owner-scoped journal page instead of all durable histories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-page-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const ownerA = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await Promise.all(Array.from({ length: 20 }, async (_, offset) => {
      const ordinal = offset + 1;
      const taskId = `history-${String(ordinal).padStart(2, '0')}`;
      const taskDirectory = path.join(taskStateDirectory, taskId);
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'completed',
        started_at: `2026-09-20T10:00:${String(ordinal).padStart(2, '0')}.000Z`,
        finished_at: `2026-09-20T10:01:${String(ordinal).padStart(2, '0')}.000Z`,
        exit_code: 0,
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: '2026-09-20T11:00:00.000Z',
        owner_client_id: ordinal % 2 === 0 ? 'other' : ownerA.clientId,
        owner_session_id: ordinal % 2 === 0 ? 'session-b' : ownerA.sessionId,
        owner_workspace_id: ownerA.workspaceId,
      }), 'utf8');
    }));
    const store = new DurableShellTaskStore(taskStateDirectory);
    const first = await store.listPage(ownerA, 3);
    expect(first).toMatchObject({
      ok: true,
      value: {
        tasks: [{ task_id: 'history-19' }, { task_id: 'history-17' }, { task_id: 'history-15' }],
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || first.value.nextCursor === undefined) return;

    vi.mocked(readFile).mockClear();
    const second = await store.listPage(ownerA, 3, first.value.nextCursor);
    expect(second).toMatchObject({
      ok: true,
      value: { tasks: [{ task_id: 'history-13' }, { task_id: 'history-11' }, { task_id: 'history-09' }] },
    });
    const metadataReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename).endsWith(`${path.sep}task.json`),
    );
    expect(metadataReads).toHaveLength(3);
  });

  it('lists durable task metadata without hydrating historical output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-list-memory-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'listed-completed';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const outputPath = path.join(taskDirectory, 'stdout.log');
    await writeFile(outputPath, Buffer.alloc(2 * 1024 * 1024, 0x63));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const listed = await store.list();
    expect(listed).toEqual([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]);
    expect(listed[0]).not.toHaveProperty('stdout');
    expect(listed[0]).not.toHaveProperty('stderr');
  });
  it('reads oversized legacy task output without whole-file readFile allocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-bounded-read-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'legacy-oversized';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const legacyOutputPath = path.join(taskDirectory, 'stdout.log');
    await writeFile(legacyOutputPath, Buffer.alloc(2 * 1024 * 1024, 0x62));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const snapshot = await store.snapshot(taskId);
    expect(snapshot).toMatchObject({ ok: true, value: { stdout: 'b'.repeat(1024) } });
    const wholeFileReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename) === legacyOutputPath,
    );
    expect(wholeFileReads).toEqual([]);
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}
