import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { permissionProfiles } from '@lnwjud/permissions';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@lnwjud/capabilities';
import { STDIO_ALLOWED_ROOTS_SETTING_KEY, STDIO_PERMISSION_PROFILE_SETTING_KEY, STDIO_STRICT_ROOTS_SETTING_KEY, UNRESTRICTED_SETTING_KEY, USER_SETTING_KEYS, serializeToolAvailabilitySnapshot } from '@lnwjud/shared';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';
import { createMcpServer, sharedActivityLeaseDirectoryPath, ToolRegistry, type WorkspaceScope } from '@lnwjud/mcp-server';

const temporaryRoots: string[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');
const STDIO_RUNTIME_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const STDIO_RUNTIME_HOOK_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000;

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: 'E:\fixture',
  realRootPath: 'E:\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

async function waitUntil(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cross-process tool availability refresh');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
}, STDIO_RUNTIME_HOOK_TIMEOUT_MS);

describe('stdio MCP runtime', { timeout: STDIO_RUNTIME_TEST_TIMEOUT_MS }, () => {
  it('defaults Ponytail to OFF and loads a persisted mode for direct STDIO', async () => {
    const defaultDataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-ponytail-default-'));
    const persistedDataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-ponytail-persisted-'));
    temporaryRoots.push(defaultDataPath, persistedDataPath);

    const defaultRuntime = createStdioMcpRuntime(defaultDataPath, workspace);
    try {
      expect(defaultRuntime.ponytailMode).toBe('off');
    } finally {
      await defaultRuntime.close();
    }

    const database = new SqliteDatabase(path.join(persistedDataPath, 'lnwjud.sqlite'));
    new SqliteSettingsRepository(database).set(USER_SETTING_KEYS.ponytailMode, 'ultra');
    database.close();

    const persistedRuntime = createStdioMcpRuntime(persistedDataPath, workspace);
    try {
      expect(persistedRuntime.ponytailMode).toBe('ultra');
    } finally {
      await persistedRuntime.close();
    }
  });

  it('reads the default-off Engineering Harness setting from the same SQLite key as Desktop', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-engineering-harness-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    try {
      expect(runtime.engineeringHarnessSettingsProvider()).toEqual({
        settings: { schemaVersion: 1, enabled: false, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true },
        diagnostic: null,
      });
      const externalDatabase = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
      new SqliteSettingsRepository(externalDatabase).set(USER_SETTING_KEYS.engineeringHarnessSettings, JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        profile: 'strict',
        applyTo: 'all_workspaces',
        autoProjectAssessment: false,
      }));
      externalDatabase.close();
      expect(runtime.engineeringHarnessSettingsProvider()).toEqual({
        settings: { schemaVersion: 1, enabled: true, profile: 'strict', applyTo: 'all_workspaces', autoProjectAssessment: false },
        diagnostic: null,
      });
    } finally {
      await runtime.close();
    }
  });

  it('wires durable goals and scheduled continuation orchestration from the same SQLite repository', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-continuation-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    try {
      expect(runtime.services.goals).toBeDefined();
      expect(runtime.services.scheduledContinuations).toBeDefined();
      expect(runtime.services.automationFactory).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('persists direct checkpoint_goal Engineering fields and leaves storage unchanged after a rejected gate update', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-engineering-checkpoint-'));
    const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-engineering-workspace-')));
    temporaryRoots.push(dataPath, workspaceRoot);
    const durableWorkspace = {
      id: 'engineering-checkpoint-workspace',
      displayName: 'engineering checkpoint',
      rootPath: workspaceRoot,
      realRootPath: workspaceRoot,
      createdAt: '2026-10-13T00:00:00.000Z',
    };
    const seed = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    await new SqliteWorkspaceRepository(seed).insert(durableWorkspace);
    seed.close();

    const runtime = createStdioMcpRuntime(dataPath, durableWorkspace, true, { fullBypassAll: true });
    try {
      const goals = runtime.services.goals;
      if (goals === undefined) throw new Error('durable goal service was not created');
      const started = await goals.runGoal(runtime.actor, {
        workspaceId: durableWorkspace.id,
        goalKey: 'direct-engineering-checkpoint',
        objective: 'Verify direct Engineering checkpoint persistence.',
        plan: { steps: [] },
        leaseSeconds: 600,
        engineering: {
          schemaVersion: 1,
          primaryTaskKind: 'bugfix',
          riskTier: 'high',
          riskReasons: ['The integration test exercises persisted Engineering metadata.'],
          policyDigest: 'direct-mcp-checkpoint-policy',
          deliveryScope: 'local',
          gates: [{
            id: 'diff', title: 'Diff review', applicability: 'required', status: 'pending',
            reason: 'Review the direct MCP checkpoint path.', basedOnUserIntentRevision: 0,
          }],
        },
      });
      if (!started.ok || started.value.leaseToken === undefined) throw new Error('durable goal could not be acquired');

      const server = createMcpServer({
        services: runtime.services,
        actor: runtime.actor,
        authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
        activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: durableWorkspace.id, rootPath: workspaceRoot }),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'stdio-checkpoint-persistence-client', version: '1.0.0' });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const listed = await client.listTools();
        const checkpointTool = listed.tools.find((tool) => tool.name === 'checkpoint_goal');
        expect(checkpointTool?.inputSchema.properties).toHaveProperty('engineeringGateUpdates');
        expect(checkpointTool?.inputSchema.properties).toHaveProperty('engineeringReviewFindings');

        const checkpointInput = {
          goalId: started.value.goalId,
          leaseToken: started.value.leaseToken,
          expectedRevision: started.value.revision,
          expectedUserIntentRevision: started.value.userIntentRevision,
          currentPhase: 'verify',
          summary: 'Record direct MCP checkpoint fields.',
          stepUpdates: [],
          nextAction: 'Read back the persisted goal.',
          blockers: [],
          evidence: [],
          trackedTasks: [],
          engineeringGateUpdates: [{ gateId: 'diff', status: 'failed', reason: 'Direct MCP checkpoint reproduced the reported behavior.' }],
          engineeringReviewFindings: [{
            id: 'review-198', title: 'MCP checkpoint round trip', severity: 'non_blocking', state: 'open',
            reason: 'The direct call must retain this review state after storage reload.',
          }],
        };

        const checkpointed = await client.callTool({ name: 'checkpoint_goal', arguments: checkpointInput });
        expect(checkpointed.isError).not.toBe(true);
        const persisted = await goals.getGoal(runtime.actor, { goalId: started.value.goalId });
        expect(persisted).toMatchObject({
          ok: true,
          value: {
            revision: 1,
            engineering: {
              gates: [{ id: 'diff', status: 'failed', reason: 'Direct MCP checkpoint reproduced the reported behavior.' }],
              reviewFindings: [{ id: 'review-198', state: 'open', reason: 'The direct call must retain this review state after storage reload.' }],
            },
          },
        });

        const rejected = await client.callTool({
          name: 'checkpoint_goal',
          arguments: {
            ...checkpointInput,
            expectedRevision: 1,
            engineeringGateUpdates: [{ gateId: 'unknown-gate', status: 'failed', reason: 'This gate does not exist.' }],
          },
        });
        expect(rejected.isError).toBe(true);
        const afterRejection = await goals.getGoal(runtime.actor, { goalId: started.value.goalId });
        expect(afterRejection).toMatchObject({ ok: true, value: { revision: 1 } });
        if (!persisted.ok || !afterRejection.ok) throw new Error('goal readback failed');
        expect(afterRejection.value.engineering).toEqual(persisted.value.engineering);
      } finally {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    } finally {
      await runtime.close();
    }

    const replacement = createStdioMcpRuntime(dataPath, durableWorkspace, true, { fullBypassAll: true });
    try {
      const restored = await replacement.services.goals?.getGoal(replacement.actor, { goalKey: 'direct-engineering-checkpoint', workspaceId: durableWorkspace.id });
      expect(restored).toMatchObject({
        ok: true,
        value: {
          revision: 1,
          engineering: {
            gates: [{ id: 'diff', status: 'failed', reason: 'Direct MCP checkpoint reproduced the reported behavior.' }],
            reviewFindings: [{ id: 'review-198', state: 'open', reason: 'The direct call must retain this review state after storage reload.' }],
          },
        },
      });
    } finally {
      await replacement.close();
    }
  });

  it.skipIf(process.platform !== 'darwin')('refuses STDIO durable execution on macOS before creating a child', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-denied-macos-'));
    temporaryRoots.push(dataPath);
    const registered = { ...workspace, rootPath: dataPath, realRootPath: dataPath };
    const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(registered);
    database.close();
    // Exercise a policy-permitted executable to reach native containment denial.
    const runtime = createStdioMcpRuntime(dataPath, registered, true);
    try {
      const attempt = await runtime.services.capabilities?.execute('shell', {
        operation: 'run', workspaceId: registered.id, executable: process.execPath,
        arguments: ['--version'],
        cwd: dataPath, execution: 'background', timeout_seconds: 5, userConfirmed: true,
        metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
          clientId: 'cli-mcp-stdio', sessionId: 'macos-denial', workspaceId: registered.id,
        } },
      });
      expect(attempt).toMatchObject({
        ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('macOS durable shell unavailable') },
      });
      const tasks = await runtime.services.capabilities?.execute('shell', {
        operation: 'list', workspaceId: registered.id,
      });
      expect(tasks).toMatchObject({ ok: true, value: { tasks: [] } });
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(process.platform === 'darwin')('persists and completes a verified automation run across a STDIO runtime replacement without creating a schedule', async () => {
    const testDeadline = Date.now() + STDIO_RUNTIME_TEST_TIMEOUT_MS;
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-automation-data-'));
    const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-automation-workspace-')));
    temporaryRoots.push(dataPath, workspaceRoot);
    const durableWorkspace = {
      id: 'automation-workspace',
      displayName: 'automation workspace',
      rootPath: workspaceRoot,
      realRootPath: workspaceRoot,
      createdAt: '2026-09-20T00:00:00.000Z',
    };
    const seeded = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    await new SqliteWorkspaceRepository(seeded).insert(durableWorkspace);
    seeded.close();

    const first = createStdioMcpRuntime(dataPath, durableWorkspace, true, { fullBypassAll: true });
    const started = await first.services.goals?.runGoal(first.actor, {
      workspaceId: durableWorkspace.id,
      goalKey: 'stdio-automation-restart',
      objective: 'Complete one verified durable automation milestone.',
      plan: { steps: [{ id: 'build', title: 'Build' }] },
      leaseSeconds: 600,
    });
    expect(started).toMatchObject({ ok: true, value: { acquired: true, leaseToken: expect.any(String) } });
    if (started === undefined || !started.ok || started.value.leaseToken === undefined) {
      await first.close();
      return;
    }
    const proof = {
      goalId: started.value.goalId,
      leaseToken: started.value.leaseToken,
      leaseGeneration: started.value.leaseGeneration,
    };
    const options = {
      authorizationModeProvider: () => 'full_bypass' as const,
      activeWorkspaceScopeProvider: async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: durableWorkspace.id, rootPath: workspaceRoot }),
    };
    const firstRegistry = new ToolRegistry(first.services, first.actor, options);
    const created = await firstRegistry.invoke('automation_create', {
      workspaceId: durableWorkspace.id,
      goalId: started.value.goalId,
      leaseToken: started.value.leaseToken,
      goalLease: proof,
      plan: {
        milestones: [{
          id: 'build', title: 'Build', goalStepId: 'build', dependsOn: [], provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
          dispatch: {
            executable: process.execPath,
            arguments: ['-e', 'process.exit(0)'],
            cwd: workspaceRoot,
            timeoutSeconds: 30,
            maxOutputBytes: 16 * 1024,
            includeStdout: false,
            includeStderr: true,
          },
          verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
        }],
      },
      userConfirmed: true,
    });
    expect(created.isError).not.toBe(true);
    const runId = String(((created.structuredContent as { run?: { id?: unknown } } | undefined)?.run?.id));
    expect(runId).not.toBe('undefined');
    await first.close();

    const replacement = createStdioMcpRuntime(dataPath, durableWorkspace, true, { fullBypassAll: true });
    try {
      const registry = new ToolRegistry(replacement.services, replacement.actor, options);
      const restored = await registry.invoke('automation_status', { workspaceId: durableWorkspace.id, runId });
      expect(restored.isError).not.toBe(true);
      expect(restored.structuredContent).toMatchObject({ run: { id: runId, status: 'active', revision: 0 } });
      const foreignRead = await new ToolRegistry(replacement.services, { clientId: 'foreign-client', clientName: 'foreign' })
        .invoke('automation_status', { workspaceId: durableWorkspace.id, runId });
      expect(foreignRead).toMatchObject({ isError: true, structuredContent: { error: { code: 'PROCESS_NOT_FOUND' } } });

      let staleRevisionRejected = false;
      for (let boundary = 0; boundary < 10; boundary += 1) {
        const status = await registry.invoke('automation_status', { workspaceId: durableWorkspace.id, runId });
        if (status.isError === true) throw new Error(JSON.stringify(status.structuredContent));
        const snapshot = status.structuredContent as { run: { revision: number }; milestones: Array<{ status: string }> };
        if (snapshot.milestones.every((milestone) => milestone.status === 'completed')) break;
        const advanced = await registry.invoke('automation_run', {
          workspaceId: durableWorkspace.id,
          goalId: started.value.goalId,
          runId,
          leaseToken: started.value.leaseToken,
          expectedRevision: snapshot.run.revision,
          goalLease: proof,
          userConfirmed: true,
        });
        if (advanced.isError === true) throw new Error(JSON.stringify(advanced.structuredContent));
        if (!staleRevisionRejected) {
          const stale = await registry.invoke('automation_run', {
            workspaceId: durableWorkspace.id,
            goalId: started.value.goalId,
            runId,
            leaseToken: started.value.leaseToken,
            expectedRevision: snapshot.run.revision,
            goalLease: proof,
            userConfirmed: true,
          });
          expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
          staleRevisionRejected = true;
        }
        if (boundary === 0) {
          const taskId = (advanced.structuredContent as { taskId?: unknown } | undefined)?.taskId;
          expect(taskId).toEqual(expect.any(String));
          if (typeof taskId !== 'string') throw new Error('Automation dispatch omitted its durable task ID');
          const taskWaitDeadline = testDeadline - 5_000;
          let task: { isError?: boolean; structuredContent?: unknown } | undefined;
          while (Date.now() < taskWaitDeadline) {
            const remainingSeconds = Math.ceil((taskWaitDeadline - Date.now()) / 1_000);
            task = await registry.invoke('shell', {
              workspaceId: durableWorkspace.id,
              operation: 'wait',
              task_id: taskId,
              timeout_seconds: Math.min(5, remainingSeconds),
              goalLease: proof,
              userConfirmed: true,
            });
            expect(task.isError).not.toBe(true);
            const taskState = (task.structuredContent as { state?: unknown } | undefined)?.state;
            if (taskState !== 'running') break;
          }
          expect(task?.structuredContent).toMatchObject({ task_id: taskId, state: 'completed', exit_code: 0 });
        }
      }
      expect(staleRevisionRejected).toBe(true);

      const verified = await registry.invoke('automation_status', { workspaceId: durableWorkspace.id, runId });
      expect(verified.isError).not.toBe(true);
      expect(verified.structuredContent).toMatchObject({ milestones: [{ status: 'completed' }] });
      const revision = (verified.structuredContent as { run: { revision: number } }).run.revision;
      const finalized = await registry.invoke('automation_finalize', {
        workspaceId: durableWorkspace.id,
        goalId: started.value.goalId,
        runId,
        leaseToken: started.value.leaseToken,
        expectedRevision: revision,
        goalLease: proof,
        userConfirmed: true,
      });
      expect(finalized.isError).not.toBe(true);
      expect(finalized.structuredContent).toMatchObject({
        run: { run: { id: runId, status: 'completed' } }, goal: { status: 'completed' },
      });
    } finally {
      await replacement.close();
    }

    const inspected = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    expect(inspected.connection.prepare('SELECT COUNT(*) AS count FROM goal_scheduled_continuations').get()).toEqual({ count: 0 });
    inspected.close();
  });

  it('observes persisted tool availability writes from another SQLite connection without restart or duplicate unrelated notifications', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-tool-availability-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    const externalSettings = new SqliteSettingsRepository(externalDatabase);
    let notifications = 0;
    const unsubscribe = runtime.toolAvailabilityService.subscribe(() => { notifications += 1; });
    try {
      externalSettings.set(USER_SETTING_KEYS.toolAvailability, serializeToolAvailabilitySnapshot({
        version: 1,
        generation: 1,
        overrides: { scheduler: 'disabled' },
      }));
      await waitUntil(() => runtime.toolAvailabilityService.snapshot().overrides.scheduler === 'disabled');
      expect(notifications).toBe(1);

      externalSettings.set(USER_SETTING_KEYS.updateAutoCheck, 'false');
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      externalDatabase.close();
      await runtime.close();
    }
  });

  it('reads current persisted Direct STDIO security settings without restarting the runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-security-policy-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    const externalSettings = new SqliteSettingsRepository(externalDatabase);
    try {
      externalSettings.set(STDIO_PERMISSION_PROFILE_SETTING_KEY, 'safe');
      externalSettings.set(USER_SETTING_KEYS.stdioFullBypassAll, 'true');
      externalSettings.set(STDIO_STRICT_ROOTS_SETTING_KEY, 'true');
      externalSettings.set(STDIO_ALLOWED_ROOTS_SETTING_KEY, 'E:\\one;E:\\two');
      externalSettings.set(UNRESTRICTED_SETTING_KEY, 'false');
      externalSettings.set(USER_SETTING_KEYS.customPermissionProfile, '{"read":"ASK"}');
      expect(runtime.persistedSecurityPolicyProvider()).toEqual({
        profile: 'safe',
        fullBypassAll: true,
        strictRoots: true,
        allowedRoots: ['E:\\one', 'E:\\two'],
        unrestricted: false,
        customPermissionRaw: '{"read":"ASK"}',
      });
    } finally {
      externalDatabase.close();
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

  it.skipIf(process.platform === 'darwin')('keeps a shell background task alive across STDIO runtime replacement', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-durable-'));
    temporaryRoots.push(dataPath);
    const durableWorkspace = { ...workspace, rootPath: dataPath, realRootPath: dataPath };
    const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(durableWorkspace);
    database.close();
    const ownerMetadata = {
      [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
        clientId: 'cli-mcp-stdio',
        sessionId: 'stdio-durable-owner',
        workspaceId: durableWorkspace.id,
      },
    };
    const firstRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    const capabilities = firstRuntime.services.capabilities;
    expect(capabilities).toBeDefined();
    if (capabilities === undefined) return;

    const started = await capabilities.execute('shell', {
      operation: 'run',
      workspaceId: durableWorkspace.id,
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('stdio-durable'), 350)"],
      cwd: dataPath,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
      metadata: ownerMetadata,
    });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    const replacementCapabilities = replacementRuntime.services.capabilities;
    expect(replacementCapabilities).toBeDefined();
    if (replacementCapabilities === undefined) {
      await replacementRuntime.close();
      return;
    }
    const finished = await replacementCapabilities.execute('shell', {
      operation: 'wait', task_id: taskId, timeout_seconds: 5, metadata: ownerMetadata,
    });
    expect(finished).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'stdio-durable', durable: true },
    });
    await replacementRuntime.close();
  });

  it.skipIf(process.platform === 'darwin')('reads durable shell task liveness after STDIO runtime replacement without treating another session as absence', async () => {
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
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, value: { task_id: expect.any(String), state: expect.stringMatching(/^(?:starting|running)$/), durable: true } });
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
  });
});
