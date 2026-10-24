import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableShellTaskIndex } from './durable-shell-task-index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('DurableShellTaskIndex', () => {
  it('upgrades mixed legacy markers in place while baseline readers fail closed to current records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-v2-migration-'));
    temporaryRoots.push(root);
    const active = path.join(root, '.index', 'v1', 'active');
    const oldTaskId = 'legacy-import';
    const oldPath = path.join(active, createHash('sha256').update(oldTaskId).digest('hex') + '.json');
    await mkdir(path.dirname(oldPath), { recursive: true });
    await mkdir(path.join(root, oldTaskId));
    const oldMarker = {
      version: 1, taskId: oldTaskId, requestDigest: 'a'.repeat(64), mutationKind: 'repository_import',
      ownerClientId: 'legacy-owner', ownerWorkspaceId: 'legacy-workspace', reservedAt: new Date().toISOString(),
    };
    await writeFile(oldPath, JSON.stringify(oldMarker));
    await writeFile(path.join(root, '.index', 'v1', 'ready.json'), JSON.stringify({ version: 1, readyAt: new Date().toISOString() }));
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'unknown'> => 'unknown' });
    await index.initialize();

    const upgraded = JSON.parse(await readFile(oldPath, 'utf8')) as Record<string, unknown>;
    expect(upgraded).toMatchObject({ ...oldMarker, version: 2 });
    expect(JSON.parse(await readFile(path.join(root, '.index', 'v1', 'ready.json'), 'utf8')))
      .toMatchObject({ version: 1, markerFormatVersion: 2 });
    expect(upgraded.version).not.toBe(1);

    const legacyReaderAccepts = (marker: Record<string, unknown>): boolean => marker.version === 1 && typeof marker.taskId === 'string';
    expect(legacyReaderAccepts(upgraded)).toBe(false);
    expect(await index.reserve({ taskId: 'new-import', requestDigest: 'b'.repeat(64), ownerClientId: 'new-owner', mutationKind: 'repository_import' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('rebuilds an absent index with v2 quarantine markers for legacy tasks whose status is insufficient', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-rebuild-v2-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'legacy-terminal'));
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'unknown'> => 'unknown' });
    await index.initialize();
    const marker = path.join(root, '.index', 'v1', 'active', createHash('sha256').update('legacy-terminal').digest('hex') + '.json');
    expect(JSON.parse(await readFile(marker, 'utf8')))
      .toMatchObject({ version: 2, taskId: 'legacy-terminal', requestDigest: null, legacy: true });
  });

  it('keeps a vanished task root reserved until an independent terminal observation exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-vanished-root-'));
    temporaryRoots.push(root);
    const taskId = 'vanished-task';
    const active = path.join(root, '.index', 'v1', 'active');
    await mkdir(active, { recursive: true });
    const marker = path.join(active, createHash('sha256').update(taskId).digest('hex') + '.json');
    await writeFile(marker, JSON.stringify({ version: 1, taskId, requestDigest: 'c'.repeat(64), mutationKind: 'opaque',
      reservedAt: new Date(Date.now() - 60_000).toISOString(), launcherPid: 2_147_483_646, launcherStartedAt: '2020-01-01T00:00:00.000Z' }));
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'missing'> => 'missing' });
    expect(await index.reserve({ taskId: 'import', requestDigest: 'd'.repeat(64), ownerClientId: 'owner', mutationKind: 'repository_import' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ version: 2, taskId, requestDigest: 'c'.repeat(64) });
  });

  it('treats malformed JSON paths as active unknown reservations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-malformed-path-'));
    temporaryRoots.push(root);
    const active = path.join(root, '.index', 'v1', 'active');
    await mkdir(active, { recursive: true });
    await mkdir(path.join(active, 'malformed.json'));
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'terminal'> => 'terminal' });
    expect(await index.reserve({ taskId: 'new-import', requestDigest: 'e'.repeat(64), ownerClientId: 'owner', mutationKind: 'repository_import' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('retains a contained writer after restart when only a shape-valid legacy receipt exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-untrusted-native-receipt-'));
    temporaryRoots.push(root);
    const nativeReceiptPath = path.join(root, 'copied.receipt.json');
    const options = { maxConcurrentTasks: 10, inspectTask: async (): Promise<'terminal'> => 'terminal' };
    const first = new DurableShellTaskIndex(root, options);
    expect(await first.reserve({
      taskId: 'native-writer', requestDigest: 'a'.repeat(64), ownerClientId: 'owner', ownerWorkspaceId: 'workspace',
      mutationKind: 'opaque_contained_process', nativeReceiptPath,
    })).toMatchObject({ ok: true });
    await writeFile(nativeReceiptPath, JSON.stringify({ kind: 'windows_job_v1', activeProcesses: 0, exitCode: 0, outcome: 'completed' }));
    const restarted = new DurableShellTaskIndex(root, options);
    expect(await restarted.reserve({
      taskId: 'import', requestDigest: 'b'.repeat(64), ownerClientId: 'owner', ownerWorkspaceId: 'workspace',
      mutationKind: 'repository_import',
    })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await restarted.hasReservation('native-writer', 'a'.repeat(64))).toBe(true);
  });

  it('does not release a contained writer from a caller notification without authenticated proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-native-release-proof-'));
    temporaryRoots.push(root);
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'terminal'> => 'terminal' });
    expect(await index.reserve({
      taskId: 'native-writer', requestDigest: 'a'.repeat(64), ownerClientId: 'owner', ownerWorkspaceId: 'workspace',
      mutationKind: 'opaque_contained_process', nativeReceiptPath: path.join(root, 'missing.receipt.json'),
    })).toMatchObject({ ok: true });
    await index.release('native-writer', 'a'.repeat(64));
    expect(await index.hasReservation('native-writer', 'a'.repeat(64))).toBe(true);
  });

  it('does not allow a different client or workspace to attach to another import reservation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-owner-'));
    temporaryRoots.push(root);
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'active'> => 'active' });
    const owned = {
      taskId: 'same-request', requestDigest: 'f'.repeat(64),
      mutationKind: 'repository_import' as const,
      ownerClientId: 'owner-client', ownerWorkspaceId: 'owner-workspace',
    };
    expect(await index.reserve(owned)).toMatchObject({ ok: true, value: { created: true } });
    expect(await index.reserve(owned)).toMatchObject({ ok: true, value: { created: false } });
    expect(await index.reserve({ ...owned, ownerClientId: 'other-client' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await index.reserve({ ...owned, ownerWorkspaceId: 'other-workspace' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it.each(['active', 'unknown', 'missing'] as const)('blocks import across workspaces while an opaque writer is %s', async (state) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-admission-'));
    temporaryRoots.push(root);
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<typeof state> => state });
    expect(await index.reserve({ taskId: 'opaque', requestDigest: 'a'.repeat(64), ownerClientId: 'other-client', ownerWorkspaceId: 'other-workspace' })).toMatchObject({ ok: true });
    const restarted = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<typeof state> => state });
    expect(await restarted.reserve({ taskId: 'import', requestDigest: 'b'.repeat(64), ownerClientId: 'import-client', ownerWorkspaceId: 'import-workspace', mutationKind: 'repository_import' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('atomically excludes import and opaque launches across index instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-race-'));
    temporaryRoots.push(root);
    const options = { maxConcurrentTasks: 10, inspectTask: async (): Promise<'unknown'> => 'unknown' };
    const first = new DurableShellTaskIndex(root, options);
    const second = new DurableShellTaskIndex(root, options);
    const results = await Promise.all([
      first.reserve({ taskId: 'import', requestDigest: 'a'.repeat(64), ownerClientId: 'a', mutationKind: 'repository_import' }),
      second.reserve({ taskId: 'opaque', requestDigest: 'b'.repeat(64), ownerClientId: 'b' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('retains import exclusion across restart and permits writers after verified terminal observation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-lifetime-'));
    temporaryRoots.push(root);
    let terminal = false;
    const options = { maxConcurrentTasks: 10, inspectTask: async (): Promise<'terminal' | 'unknown'> => terminal ? 'terminal' : 'unknown' };
    const first = new DurableShellTaskIndex(root, options);
    const reservation = { taskId: 'import', requestDigest: 'a'.repeat(64), ownerClientId: 'a', mutationKind: 'repository_import' as const };
    expect(await first.reserve(reservation)).toMatchObject({ ok: true, value: { created: true } });
    const restarted = new DurableShellTaskIndex(root, options);
    expect(await restarted.reserve(reservation)).toMatchObject({ ok: true, value: { created: false } });
    expect(await restarted.reserve({ ...reservation, mutationKind: 'opaque' })).toMatchObject({ ok: false });
    const writer = { taskId: 'writer', requestDigest: 'b'.repeat(64), ownerClientId: 'b' };
    expect(await restarted.reserve(writer)).toMatchObject({ ok: false });
    terminal = true;
    expect(await restarted.reserve(writer)).toMatchObject({ ok: true });
  });

  it('bootstraps legacy terminal and active history once, then reinspects only active markers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-bootstrap-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'history-terminal'));
    await mkdir(path.join(root, 'history-running'));
    await mkdir(path.join(root, 'history-unverified'));
    const firstInspector = vi.fn(async (taskId: string) => taskId === 'history-terminal' ? 'terminal' as const : 'active' as const);

    const first = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 3,
      inspectTask: firstInspector,
    });
    await first.initialize();

    expect(firstInspector.mock.calls.map(([taskId]) => taskId).sort()).toEqual([
      'history-running',
      'history-terminal',
      'history-unverified',
    ]);

    const warmInspector = vi.fn(async () => 'active' as const);
    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 3,
      inspectTask: warmInspector,
    });
    await replacement.initialize();
    const reserved = await replacement.reserve({
      taskId: 'new-task',
      requestDigest: 'a'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(reserved).toMatchObject({ ok: true, value: { activeTasks: 3 } });
    expect(warmInspector.mock.calls.map(([taskId]) => taskId).sort()).toEqual([
      'history-running',
      'history-unverified',
    ]);
    await replacement.release('new-task', 'a'.repeat(64));
  });

  it('retries transient lock-file deletion before another store instance acquires the index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-lock-release-'));
    temporaryRoots.push(root);
    let lockRemovalAttempts = 0;
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      removeFile: async (filename, options): Promise<void> => {
        if (path.basename(filename.toString()) === 'index.lock' && lockRemovalAttempts++ === 0) {
          throw Object.assign(new Error('lock is still busy'), { code: 'EPERM' });
        }
        await rm(filename, options);
      },
    });

    await index.initialize();
    expect(lockRemovalAttempts).toBeGreaterThanOrEqual(2);

    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
    });
    await expect(replacement.reserve({
      taskId: 'next-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    })).resolves.toMatchObject({ ok: true, value: { activeTasks: 1, created: true } });
    await replacement.release('next-task', 'b'.repeat(64));
  });

  it('serializes reservations across store instances so the active limit cannot be raced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-limit-'));
    temporaryRoots.push(root);
    const inspectTask = vi.fn(async () => 'active' as const);
    const first = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask });
    const second = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask });
    await first.initialize();
    await second.initialize();

    const results = await Promise.all([
      first.reserve({
        taskId: 'task-one',
        requestDigest: '1'.repeat(64),
        ownerClientId: 'chatgpt',
        ownerWorkspaceId: 'workspace-a',
      }),
      second.reserve({
        taskId: 'task-two',
        requestDigest: '2'.repeat(64),
        ownerClientId: 'chatgpt',
        ownerWorkspaceId: 'workspace-a',
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'CONFLICT', recoverable: true }) }),
    ]);

    const successfulTaskId = results[0]?.ok ? 'task-one' : 'task-two';
    const successfulDigest = successfulTaskId === 'task-one' ? '1'.repeat(64) : '2'.repeat(64);
    await first.release(successfulTaskId, successfulDigest);
  });

  it('counts an unreadable active marker as active instead of freeing capacity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-unknown-'));
    temporaryRoots.push(root);
    const owner = {
      taskId: 'uncertain-task',
      requestDigest: 'a'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    } as const;
    const first = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'unknown'> => 'unknown',
    });
    await first.initialize();
    expect(await first.reserve(owner)).toMatchObject({ ok: true });
    const activeDirectory = path.join(root, '.index', 'v1', 'active');
    const [markerName] = await readdir(activeDirectory);
    expect(markerName).toBeDefined();
    await writeFile(path.join(activeDirectory, markerName!), '{not-json', 'utf8');

    const inspectTask = vi.fn(async () => 'terminal' as const);
    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask,
    });
    const blocked = await replacement.reserve({
      taskId: 'next-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', recoverable: true },
    });
    expect(inspectTask).not.toHaveBeenCalled();
    expect(await replacement.hasReservation(owner.taskId, owner.requestDigest)).toBe(true);
  });

  it('keeps a missing pre-metadata reservation until independent terminal proof exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-abandoned-'));
    temporaryRoots.push(root);
    const now = new Date('2026-09-20T10:00:00.000Z');
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'missing'> => 'missing',
      now: (): Date => now,
    });
    await index.initialize();
    const abandonedTaskId = 'abandoned-before-metadata';
    const markerName = `${createHash('sha256').update(abandonedTaskId).digest('hex')}.json`;
    await writeFile(path.join(root, '.index', 'v1', 'active', markerName), JSON.stringify({
      version: 1,
      taskId: abandonedTaskId,
      requestDigest: 'a'.repeat(64),
      reservedAt: '2026-09-20T09:58:00.000Z',
      launcherPid: 2_147_483_647,
      launcherStartedAt: '2026-09-20T09:00:00.000Z',
    }), 'utf8');

    const reserved = await index.reserve({
      taskId: 'replacement-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(reserved).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(path.join(root, '.index', 'v1', 'active', markerName), 'utf8')).toContain('abandoned-before-metadata');
  });

  it('bootstraps and pages the compact launch journal without hydrating filtered histories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-journal-'));
    temporaryRoots.push(root);
    const records = new Map(Array.from({ length: 5 }, (_, offset) => {
      const ordinal = offset + 1;
      const taskId = `task-${ordinal}`;
      return [taskId, {
        version: 1 as const,
        taskId,
        startedAt: `2026-09-20T10:00:0${ordinal}.000Z`,
        ownerClientId: ordinal % 2 === 0 ? 'client-b' : 'client-a',
        ownerSessionId: ordinal % 2 === 0 ? 'session-b' : 'session-a',
        ownerWorkspaceId: 'workspace-a',
      }];
    }));
    await Promise.all([...records.keys()].map((taskId) => mkdir(path.join(root, taskId))));
    const loadLaunchRecord = vi.fn(async (taskId: string) => records.get(taskId));
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 2,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      loadLaunchRecord,
    });
    await index.initialize();
    expect(loadLaunchRecord).toHaveBeenCalledTimes(5);
    loadLaunchRecord.mockClear();

    const first = await index.listLaunches({
      limit: 2,
      accept: (record) => record.ownerClientId === 'client-a',
    });
    expect(first).toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-5' }, { taskId: 'task-3' }], nextCursor: expect.any(String) },
    });
    if (!first.ok || first.value.nextCursor === undefined) return;
    const second = await index.listLaunches({
      limit: 2,
      cursor: first.value.nextCursor,
      accept: (record) => record.ownerClientId === 'client-a',
    });
    expect(second).toMatchObject({ ok: true, value: { records: [{ taskId: 'task-1' }] } });
    expect(loadLaunchRecord).not.toHaveBeenCalled();

    await expect(index.listLaunches({ limit: 2, cursor: 'malformed' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rebuilds a missing or corrupt launch journal under the index lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-index-journal-rebuild-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'task-a'));
    const record = {
      version: 1 as const,
      taskId: 'task-a',
      startedAt: '2026-09-20T10:00:00.000Z',
      ownerClientId: 'client-a',
      ownerSessionId: 'session-a',
      ownerWorkspaceId: 'workspace-a',
    };
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      loadLaunchRecord: async (): Promise<typeof record> => record,
    });
    await index.initialize();
    const journalPath = path.join(root, '.index', 'v1', 'launches.jsonl');
    await rm(journalPath);
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-a' }] },
    });

    await writeFile(journalPath, '{corrupt}\n', 'utf8');
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', recoverable: true },
    });
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-a' }] },
    });
  });
});
