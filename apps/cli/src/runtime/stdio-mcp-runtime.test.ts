import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { permissionProfiles } from '@lnwjud/permissions';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@lnwjud/capabilities';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';
import { sharedActivityLeaseDirectoryPath } from '@lnwjud/mcp-server';

const temporaryRoots: string[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: 'E:\fixture',
  realRootPath: 'E:\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

beforeEach(() => {
  process.env.LNWJUD_CHECKPOINT_KEY_BASE64 = TEST_CHECKPOINT_KEY;
});

afterEach(async () => {
  delete process.env.TUNNEL_CLIENT_PROFILE_DIR;
  delete process.env.LNWJUD_CHECKPOINT_KEY_BASE64;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('stdio MCP runtime', () => {
  it('wires durable goals and scheduled continuation orchestration from the same SQLite repository', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-continuation-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    try {
      expect(runtime.services.goals).toBeDefined();
      expect(runtime.services.scheduledContinuations).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('does not overwrite the Desktop permission profile when using full tunnel access', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-profile-'));
    temporaryRoots.push(dataPath);
    const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    new SqliteSettingsRepository(database).set('permission_profile', 'balanced');
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.close();

    const verificationDatabase = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    const profile = new SqliteSettingsRepository(verificationDatabase).get('permission_profile');
    verificationDatabase.close();
    expect(profile).toBe('balanced');
  });

  it('owns and cleans the tunnel-profile activity snapshot for the direct STDIO runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-activity-'));
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-profile-'));
    temporaryRoots.push(dataPath, profileDirectory);
    process.env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.activityReady;
    const leaseDirectory = sharedActivityLeaseDirectoryPath(profileDirectory);
    const [leaseFile] = await readdir(leaseDirectory);
    expect(leaseFile).toBeDefined();
    const leasePath = path.join(leaseDirectory, leaseFile!);
    const initialized = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    expect(initialized).toMatchObject({ version: 2, activeCount: 0, revision: 0, owner: { pid: process.pid } });

    const callId = await runtime.activityTracker.begin('read_file', { path: 'E:\\fixture.txt' });
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 1, revision: 1 });
    await runtime.activityTracker.end(callId, 'SUCCESS', 1);
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 0, revision: 2 });

    await runtime.close();
    expect((await readdir(leaseDirectory)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('uses the selected stdio profile and hides broad workspaces when strict roots are enabled', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-strict-data-'));
    const allowedRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-strict-allowed-'));
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-strict-outside-'));
    temporaryRoots.push(dataPath, allowedRaw, outsideRaw);
    const allowed = await realpath(allowedRaw);
    const outside = await realpath(outsideRaw);
    await writeFile(path.join(outside, 'outside.txt'), 'outside', 'utf8');
    const allowedWorkspace = { id: 'allowed-workspace', displayName: 'allowed', rootPath: allowed, realRootPath: allowed, createdAt: '2026-08-22T00:00:00.000Z' };
    const outsideWorkspace = { id: 'outside-workspace', displayName: 'outside', rootPath: outside, realRootPath: outside, createdAt: '2026-08-22T00:00:01.000Z' };
    const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    const repo = new SqliteWorkspaceRepository(database);
    await repo.insert(allowedWorkspace);
    await repo.insert(outsideWorkspace);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, allowedWorkspace, true, { permissionProfile: 'safe', strictAllowedRoots: [allowed] });
    try {
      expect(runtime.profileProvider()).toEqual(permissionProfiles.safe);
      const listed = await runtime.services.workspaceInfo?.list?.(runtime.actor);
      expect(listed).toMatchObject({ ok: true, value: [expect.objectContaining({ id: 'allowed-workspace' })] });
      const readOutside = await runtime.services.file?.readFile(runtime.actor, undefined, { path: path.join(outside, 'outside.txt') });
      expect(readOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      const shellOutside = await runtime.services.capabilities?.execute('shell', {
        operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: outside, execution: 'foreground',
      });
      expect(shellOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally {
      await runtime.close();
    }
  });

  it('keeps a shell background task alive across STDIO runtime replacement', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-durable-'));
    temporaryRoots.push(dataPath);
    const firstRuntime = createStdioMcpRuntime(dataPath, workspace, true);
    const capabilities = firstRuntime.services.capabilities;
    expect(capabilities).toBeDefined();
    if (capabilities === undefined) return;

    const started = await capabilities.execute('shell', {
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('stdio-durable'), 350)"],
      cwd: dataPath,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, workspace, true);
    const replacementCapabilities = replacementRuntime.services.capabilities;
    expect(replacementCapabilities).toBeDefined();
    if (replacementCapabilities === undefined) {
      await replacementRuntime.close();
      return;
    }
    const finished = await replacementCapabilities.execute('shell', { operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'stdio-durable', durable: true },
    });
    await replacementRuntime.close();
  }, 15_000);

  it('reads durable shell task liveness after STDIO runtime replacement without treating another session as absence', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-goal-liveness-data-'));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-goal-liveness-workspace-'));
    temporaryRoots.push(dataPath, workspaceRoot);
    const durableWorkspace = {
      id: 'goal-liveness-workspace',
      displayName: 'goal liveness',
      rootPath: workspaceRoot,
      realRootPath: workspaceRoot,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(durableWorkspace);
    database.close();

    const ownerMetadata = {
      [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
        clientId: 'cli-mcp-stdio',
        sessionId: 'predecessor-session',
        workspaceId: durableWorkspace.id,
      },
    };
    const firstRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    const started = await firstRuntime.services.capabilities?.execute('shell', {
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => process.exit(0), 10000)'],
      cwd: workspaceRoot,
      workspaceId: durableWorkspace.id,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
      metadata: ownerMetadata,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), state: 'running', durable: true } });
    if (started === undefined || !started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    const runGoal = await firstRuntime.services.goals?.runGoal(firstRuntime.actor, {
      workspaceId: durableWorkspace.id,
      goalKey: 'runtime-task-state-reader',
      objective: 'Verify task liveness survives a transport replacement.',
      plan: { steps: [] },
      leaseSeconds: 600,
    });
    expect(runGoal).toMatchObject({ ok: true, value: { acquired: true, leaseToken: expect.any(String) } });
    if (runGoal === undefined || !runGoal.ok || runGoal.value.leaseToken === undefined) {
      await firstRuntime.close();
      return;
    }
    const checkpointed = await firstRuntime.services.goals?.checkpointGoal(firstRuntime.actor, {
      goalId: runGoal.value.goalId,
      leaseToken: runGoal.value.leaseToken,
      expectedRevision: runGoal.value.revision,
      currentPhase: 'worker-running',
      summary: 'A durable task is still running.',
      stepUpdates: [],
      nextAction: 'Wait for the task.',
      blockers: [],
      evidence: [],
      activeTaskIds: [taskId],
    });
    expect(checkpointed).toMatchObject({ ok: true, value: { activeTaskIds: [taskId] } });
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    try {
      const liveness = await replacementRuntime.services.goalMutationFence?.observe(runGoal.value.goalId, [taskId]);
      expect(liveness).toMatchObject({
        trustworthy: true,
        activeTaskStates: [{ taskId, state: 'running' }],
      });
    } finally {
      await replacementRuntime.services.capabilities?.execute('shell', {
        operation: 'cancel',
        task_id: taskId,
        workspaceId: durableWorkspace.id,
        userConfirmed: true,
        metadata: ownerMetadata,
      });
      await replacementRuntime.close();
    }
  }, 15_000);
});
