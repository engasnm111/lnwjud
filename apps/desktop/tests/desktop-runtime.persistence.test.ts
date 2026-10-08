import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CodexDiscovery } from '@lnwjud/codex';
import { ToolRegistry } from '@lnwjud/mcp-server';
import { USER_SETTING_KEYS } from '@lnwjud/shared';
import { SqliteAuditRepository, SqliteDatabase, SqliteSettingsRepository } from '@lnwjud/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, type DesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];
const isWindowsGitHubActions = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
const FAST_RUNTIME_TEST_TIMEOUT_MS = isWindowsGitHubActions ? 60_000 : 15_000;
const RUNTIME_TEST_TIMEOUT_MS = isWindowsGitHubActions ? 90_000 : 30_000;
const LONG_RUNTIME_TEST_TIMEOUT_MS = isWindowsGitHubActions ? 120_000 : 60_000;

beforeEach(() => {
  vi.stubEnv('LNWJUD_UNRESTRICTED', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Ignore transient cleanup locks on Windows
    }
  }));
});

describe('DesktopRuntime persistence', () => {
  it('defaults Local MCP HTTP to an automatically assigned free port', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-auto-mcp-port-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      expect(runtime.getUserSettings().mcpHttpPort).toBe(0);
      const status = await runtime.autoStartMcp();
      expect(status.running).toBe(true);
      expect(new URL(status.url ?? '').port).not.toBe('0');
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('reports real Desktop main-process memory even with no attributable Goal tasks', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-resources-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-resources-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(rawWorkspaceRoot) });
      const measured = await runtime.services.getResourceSnapshot({ workspaceId: workspace.id });
      expect(measured.desktopMain?.rssBytes).toBeGreaterThan(0);
      expect(measured.desktopMain?.cpuAveragePercent === null
        || (measured.desktopMain?.cpuAveragePercent ?? -1) >= 0).toBe(true);
      expect(measured.contextScope).toBe('transport');
      expect(measured.resources).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('migrates the legacy 18765 default to Auto once and preserves a later explicit 18765 pin', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-mcp-port-migration-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const database = new SqliteDatabase(path.join(dataRoot, 'lnwjud.sqlite'));
    const settings = new SqliteSettingsRepository(database);
    settings.set(USER_SETTING_KEYS.mcpHttpPort, '18765');
    database.close();

    const migrated = createDesktopRuntime(dataRoot);
    try {
      expect(migrated.getUserSettings().mcpHttpPort).toBe(0);
      const next = { ...migrated.getUserSettings(), mcpHttpPort: 18_765 };
      await migrated.services.setUserSettings({ settings: next });
    } finally {
      await migrated.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      expect(restarted.getUserSettings().mcpHttpPort).toBe(18_765);
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('defaults unset recovery retention to 30 days while preserving an explicit Never choice', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-recovery-retention-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const initial = await runtime.services.getDashboard();
      expect(initial.settings.recoveryRetentionDays).toBe(30);
      await runtime.services.setUserSettings({ settings: { ...initial.settings, recoveryRetentionDays: 0 } });
      expect((await runtime.services.getDashboard()).settings.recoveryRetentionDays).toBe(0);
    } finally {
      await runtime.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      expect((await restarted.services.getDashboard()).settings.recoveryRetentionDays).toBe(0);
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('persists Engineering Harness, signals reconnect for connection-time instructions, and preserves legacy-client writes', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-engineering-harness-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      expect(runtime.getUserSettings()).toMatchObject({
        engineeringHarness: { schemaVersion: 1, enabled: false, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true },
        engineeringHarnessDiagnostic: null,
      });
      const enabled = await runtime.services.setUserSettings({
        settings: {
          ...runtime.getUserSettings(),
          engineeringHarness: { schemaVersion: 1, enabled: true, profile: 'strict', applyTo: 'all_workspaces', autoProjectAssessment: false },
          engineeringHarnessWorkspaceOverrides: {
            'workspace-disabled': { mode: 'off' },
            'workspace-enabled': { mode: 'on', profile: 'senior' },
          },
        },
      });
      expect(enabled.restartRequired).toBe(true);
      expect(enabled.settings.engineeringHarness?.enabled).toBe(true);
      expect(enabled.settings.engineeringHarnessWorkspaceOverrides).toMatchObject({ 'workspace-disabled': { mode: 'off' }, 'workspace-enabled': { mode: 'on', profile: 'senior' } });

      const {
        engineeringHarness: _engineeringHarness,
        engineeringHarnessWorkspaceOverrides: _engineeringHarnessWorkspaceOverrides,
        engineeringHarnessDiagnostic: _engineeringHarnessDiagnostic,
        ...legacySettings
      } = runtime.getUserSettings();
      void _engineeringHarness;
      void _engineeringHarnessWorkspaceOverrides;
      void _engineeringHarnessDiagnostic;
      await runtime.services.setUserSettings({ settings: legacySettings });
      expect(runtime.getUserSettings().engineeringHarness).toMatchObject({ enabled: true, profile: 'strict' });
      expect(runtime.getUserSettings().engineeringHarnessWorkspaceOverrides).toMatchObject({ 'workspace-disabled': { mode: 'off' }, 'workspace-enabled': { mode: 'on', profile: 'senior' } });
    } finally {
      await runtime.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      expect(restarted.getUserSettings().engineeringHarness).toMatchObject({ enabled: true, profile: 'strict' });
      expect(restarted.getUserSettings().engineeringHarnessWorkspaceOverrides).toMatchObject({ 'workspace-disabled': { mode: 'off' }, 'workspace-enabled': { mode: 'on', profile: 'senior' } });
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('does not execute Codex discovery for the default-disabled Codex tools on dashboard refresh', async () => {
    const discover = vi.spyOn(CodexDiscovery.prototype, 'discover');
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-codex-disabled-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      await runtime.services.getDashboard();
      expect(discover).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('finishes the startup database backup before an immediate shutdown closes SQLite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-backup-close-'));
    temporaryRoots.push(root);
    const runtime = createDesktopRuntime(await realpath(root));
    await runtime.close();
    const directory = path.join(root, 'backups');
    const manifests = await Promise.all((await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .map(async (name): Promise<{ reason: string }> => JSON.parse(await readFile(path.join(directory, name), 'utf8')) as { reason: string }));
    expect(manifests).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'daily' })]));
  });

  it('tolerates concurrent and repeated close() calls without re-closing SQLite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-double-close-'));
    temporaryRoots.push(root);
    const runtime = createDesktopRuntime(await realpath(root));

    await expect(Promise.all([runtime.close(), runtime.close()])).resolves.toBeDefined();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('builds the production dashboard audit summary without parsing large started metadata', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-audit-summary-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    const maximumLengthPath = `E:\\${'x'.repeat(4_093)}`;
    const callId = await runtime.activityTracker.begin('read_files', {
      files: Array.from({ length: 500 }, () => ({ path: maximumLengthPath })),
    });
    const originalParse = JSON.parse.bind(JSON);
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text.includes('"activityTargetDetail"')) throw new Error('dashboard parsed full audit metadata');
      return originalParse(text, reviver);
    });
    try {
      const dashboard = await runtime.services.getDashboard();
      expect(dashboard.recentAuditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'mcp_tool:read_files', resultCode: 'STARTED' }),
      ]));
      expect(JSON.stringify(dashboard.recentAuditEvents)).not.toContain('activityTargetDetail');
    } finally {
      parseSpy.mockRestore();
      await runtime.activityTracker.end(callId, 'SUCCESS', 1);
      await runtime.close();
    }
  }, FAST_RUNTIME_TEST_TIMEOUT_MS);

  it('starts with no automatically registered drive roots even when unrestricted mode is enabled', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-no-auto-drives-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      await expect(runtime.services.listWorkspaces()).resolves.toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('wires durable goals and scheduled continuation orchestration into desktop MCP services', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-continuation-data-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      expect(runtime.mcpServices.goals).toBeDefined();
      expect(runtime.mcpServices.scheduledContinuations).toBeDefined();
      expect(runtime.mcpServices.automationFactory).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('restores owner-scoped automation state through the Desktop MCP composition after restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-automation-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-automation-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);

    const first = createDesktopRuntime(dataRoot);
    const workspace = await first.services.addWorkspace({ rootPath: workspaceRoot });
    const started = await first.mcpServices.goals?.runGoal(first.mcpActor, {
      workspaceId: workspace.id,
      goalKey: 'desktop-automation-restart',
      objective: 'Persist one Desktop automation run.',
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
    const registry = new ToolRegistry(first.mcpServices, first.mcpActor, {
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      activeWorkspaceScopeProvider: async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: workspace.id, rootPath: workspaceRoot }),
    });
    const created = await registry.invoke('automation_create', {
      workspaceId: workspace.id,
      goalId: started.value.goalId,
      leaseToken: started.value.leaseToken,
      goalLease: proof,
      plan: {
        milestones: [{
          id: 'build', title: 'Build', goalStepId: 'build', dependsOn: [], provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
          dispatch: {
            executable: process.execPath,
            arguments: ['--version'],
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
    await first.close();

    const restarted = createDesktopRuntime(dataRoot);
    try {
      const restored = await new ToolRegistry(restarted.mcpServices, restarted.mcpActor)
        .invoke('automation_status', { workspaceId: workspace.id, runId });
      expect(restored.isError).not.toBe(true);
      expect(restored.structuredContent).toMatchObject({
        run: { id: runId, goalId: started.value.goalId, workspaceId: workspace.id, ownerClientId: restarted.mcpActor.clientId, status: 'active' },
        milestones: [{ id: 'build', status: 'pending' }],
      });
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);
  it('updates one connected Desktop MCP client immediately when in-process tool availability changes', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-tool-availability-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-tool-availability-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      const status = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (status.url === null) return;

      const client = new Client({ name: 'desktop-tool-availability-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(status.url));
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('read_file');

        runtime.toolAvailabilityService.setToolEnabled('read_file', false);

        await vi.waitFor(async () => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('read_file');
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('publishes Agent Swarm to an already connected MCP client when Codex opt-in changes', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-live-codex-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-live-codex-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(rawWorkspaceRoot) });
      const status = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (status.url === null) return;

      const client = new Client({ name: 'desktop-live-codex-test', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(status.url)));
        runtime.toolAvailabilityService.setToolEnabled('agent_swarm_run', true);
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_swarm_run');

        const saved = await runtime.services.setUserSettings({
          settings: { ...runtime.getUserSettings(), codexToolsEnabled: true },
        });
        await vi.waitFor(async () => {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toContain('agent_swarm_run');
          expect(names).toContain('codex_run');
        });
        const swarmList = await client.callTool({ name: 'agent_swarm_run', arguments: { operation: 'list', workspaceId: workspace.id } });
        expect(swarmList.isError).not.toBe(true);
        expect(saved.restartRequired).toBe(false);

        await runtime.services.setUserSettings({
          settings: { ...runtime.getUserSettings(), codexToolsEnabled: false },
        });
        await vi.waitFor(async () => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_swarm_run');
        });
        await expect(runtime.services.getDashboard()).resolves.toMatchObject({ mcp: { url: status.url } });
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('publishes Agent Swarm when Codex is enabled before the MCP client connects', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-start-codex-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-start-codex-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      await runtime.services.setUserSettings({ settings: { ...runtime.getUserSettings(), codexToolsEnabled: true } });
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(rawWorkspaceRoot) });
      expect(runtime.getUserSettings().codexToolsEnabled).toBe(true);
      expect(runtime.mcpServices.agentSwarm).toBeDefined();
      expect(new ToolRegistry(runtime.mcpServices, runtime.mcpActor, { codexToolsEnabled: true }).list().map((tool) => tool.name)).toContain('agent_swarm_run');
      const status = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(status.url).not.toBeNull();
      if (status.url === null) return;
      const client = new Client({ name: 'desktop-start-codex-test', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(status.url)));
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('agent_swarm_run');
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('updates a long-lived MCP process when another process changes Codex opt-in', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-external-codex-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-external-codex-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const runtime = createDesktopRuntime(dataRoot, { watchToolAvailability: true });
    const externalDatabase = new SqliteDatabase(path.join(dataRoot, 'lnwjud.sqlite'));
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(rawWorkspaceRoot) });
      const status = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(status.url).not.toBeNull();
      if (status.url === null) return;
      const client = new Client({ name: 'desktop-external-codex-test', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(status.url)));
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_swarm_run');

        const externalSettings = new SqliteSettingsRepository(externalDatabase);
        externalSettings.set(USER_SETTING_KEYS.codexToolsEnabled, 'true');
        await vi.waitFor(async () => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('agent_swarm_run');
        });

        externalSettings.set(USER_SETTING_KEYS.codexToolsEnabled, 'false');
        await vi.waitFor(async () => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_swarm_run');
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      externalDatabase.close();
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('persists user tool availability across a Desktop runtime restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-tool-availability-restart-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    await firstRuntime.services.setToolAvailability({ locale: 'en', name: 'read_file', enabled: false });
    await firstRuntime.close();

    const secondRuntime = createDesktopRuntime(dataRoot);
    try {
      const catalog = await secondRuntime.services.getToolCatalog({ locale: 'en' });
      expect(catalog.items.find((item) => item.name === 'read_file')).toMatchObject({
        userPreference: 'disabled',
        effectiveExposed: false,
      });
      expect(secondRuntime.toolAvailabilityService.snapshot().overrides.read_file).toBe('disabled');
    } finally {
      await secondRuntime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('keeps completed MCP work-log sessions visible across a Desktop runtime restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-worklog-restart-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-worklog-restart-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);

    const firstRuntime = createDesktopRuntime(dataRoot, { logSessionId: 'desktop-launch-a' });
    let priorSessionId: string | null = null;
    try {
      const workspace = await firstRuntime.services.addWorkspace({ rootPath: workspaceRoot });
      const status = await firstRuntime.services.startMcp({ workspaceId: workspace.id });
      if (status.url === null) throw new Error('MCP listener did not expose a URL');
      const client = new Client({ name: 'desktop-worklog-restart-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(status.url));
      try {
        await client.connect(transport);
        const info = await client.callTool({ name: 'workspace_info', arguments: { workspaceId: workspace.id } });
        expect(info.isError).not.toBe(true);
        const previousRows = (await firstRuntime.services.getDashboard()).workLog.filter((entry) => entry.toolName === 'workspace_info');
        expect(previousRows.length).toBeGreaterThan(0);
        priorSessionId = previousRows.find((entry) => entry.sessionId !== null)?.sessionId ?? null;
        expect(priorSessionId).toBe('desktop-launch-a');
        await expect(readFile(path.join(dataRoot, 'mcp-activity.log'), 'utf8')).resolves.toContain('"sessionId":"desktop-launch-a"');
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await firstRuntime.close();
    }

    const restartedRuntime = createDesktopRuntime(dataRoot, { logSessionId: 'desktop-launch-b' });
    try {
      const restoredRows = (await restartedRuntime.services.getDashboard()).workLog.filter((entry) => entry.toolName === 'workspace_info');
      expect(restoredRows.some((entry) => entry.sessionId === priorSessionId)).toBe(true);
      const restoredWorkspace = (await restartedRuntime.services.listWorkspaces()).find((entry) => entry.rootPath === workspaceRoot);
      if (restoredWorkspace === undefined) throw new Error('Workspace registration was not restored');
      const status = await restartedRuntime.services.startMcp({ workspaceId: restoredWorkspace.id });
      if (status.url === null) throw new Error('Restarted MCP listener did not expose a URL');
      const client = new Client({ name: 'desktop-worklog-restart-test-b', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(status.url));
      try {
        await client.connect(transport);
        const info = await client.callTool({ name: 'workspace_info', arguments: { workspaceId: restoredWorkspace.id } });
        expect(info.isError).not.toBe(true);
      } finally {
        await client.close().catch(() => undefined);
      }
      const allRows = (await restartedRuntime.services.getDashboard()).workLog.filter((entry) => entry.toolName === 'workspace_info');
      expect(allRows.some((entry) => entry.sessionId === 'desktop-launch-a')).toBe(true);
      expect(allRows.some((entry) => entry.sessionId === 'desktop-launch-b')).toBe(true);
    } finally {
      await restartedRuntime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('discovers and loads a session older than the 500-row dashboard window', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-old-session-data-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const database = new SqliteDatabase(path.join(dataRoot, 'lnwjud.sqlite'));
    const repository = new SqliteAuditRepository(database);
    const insertActivity = async (id: string, timestamp: string, workspaceId: string, sessionId: string): Promise<void> => {
      await repository.insert({
        id, timestamp, actorId: 'test', actorName: 'test', workspaceId, sessionId,
        action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
        metadata: { toolName: 'read_file', callId: id, phase: 'completed', targetDetail: { detailRef: null, itemCount: 0, preview: [], legacyIncomplete: false } },
      });
    };
    await insertActivity('old-event', '2026-08-20T00:00:00.000Z', 'workspace-old', 'session-old');
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    for (let index = 0; index < 520; index += 1) {
      await insertActivity(`new-${index}`, new Date(base + index * 1_000).toISOString(), 'workspace-new', 'session-new');
    }
    database.close();

    const runtime = createDesktopRuntime(dataRoot);
    try {
      const dashboard = await runtime.services.getDashboard() as Awaited<ReturnType<typeof runtime.services.getDashboard>> & {
        readonly workLogSessions?: readonly { readonly sessionId: string; readonly workspaceId: string | null; readonly startedAt: string; readonly lastActivityAt: string }[];
      };
      expect(dashboard.workLog.some((entry) => entry.sessionId === 'session-old')).toBe(false);
      expect(dashboard.workLogSessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'session-old', workspaceId: 'workspace-old' })]));

      const historyServices = runtime.services as typeof runtime.services & {
        loadLogSessionHistory(request: { readonly sessionId: string; readonly workspaceId?: string; readonly limit?: number }): Promise<{ readonly workLog: readonly { readonly sessionId: string | null; readonly id: string }[] }>;
      };
      const history = await historyServices.loadLogSessionHistory({ sessionId: 'session-old', workspaceId: 'workspace-old' });
      expect(history.workLog).toEqual([expect.objectContaining({ id: 'old-event', sessionId: 'session-old' })]);
    } finally {
      await runtime.close();
    }
  }, LONG_RUNTIME_TEST_TIMEOUT_MS);

  it('applies and restores permission settings without restoring an MCP listener', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    let firstClosed = false;
    try {
      const workspace = await firstRuntime.services.addWorkspace({ rootPath: workspaceRoot });

      await expect(firstRuntime.services.setPermissionProfile({ profile: 'safe' })).resolves.toEqual({ profile: 'safe' });
      const deniedWrite = await firstRuntime.mcpServices.file.writeFile(firstRuntime.mcpActor, workspace.id, {
        path: 'permission-check.txt',
        content: 'safe must require approval',
      });
      expect(deniedWrite).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });

      await expect(firstRuntime.services.setPermissionProfile({ profile: 'balanced' })).resolves.toEqual({ profile: 'balanced' });
      const allowedWrite = await firstRuntime.mcpServices.file.writeFile(firstRuntime.mcpActor, workspace.id, {
        path: 'permission-check.txt',
        content: 'balanced allows writes',
      });
      expect(allowedWrite).toMatchObject({ ok: true });
      await expect(firstRuntime.services.getDashboard()).resolves.toMatchObject({ permissionProfile: 'balanced' });
      await expect(firstRuntime.services.startMcp({ workspaceId: workspace.id })).resolves.toMatchObject({ running: true });
      await firstRuntime.close();
      firstClosed = true;

      const restartedRuntime = createDesktopRuntime(dataRoot);
      try {
        const listed = await restartedRuntime.services.listWorkspaces();
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: workspace.id, rootPath: workspace.rootPath }),
        ]));
        await expect(restartedRuntime.services.getDashboard()).resolves.toMatchObject({
          permissionProfile: 'balanced',
          mcp: { running: false, url: null, workspaceId: null },
        });
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      if (!firstClosed) await closeRuntime(firstRuntime);
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('keeps one desktop MCP listener alive while selecting and serving different workspaces', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-multi-data-'));
    const rawWorkspaceA = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-multi-a-'));
    const rawWorkspaceB = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-multi-b-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceA, rawWorkspaceB);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRootA = await realpath(rawWorkspaceA);
    const workspaceRootB = await realpath(rawWorkspaceB);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const workspaceA = await runtime.services.addWorkspace({ rootPath: workspaceRootA });
      const first = await runtime.services.startMcp({ workspaceId: workspaceA.id });
      expect(first).toMatchObject({ running: true, workspaceId: null });
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (first.url === null) return;

      const client = new Client({ name: 'desktop-multi-workspace-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(first.url));
      try {
        await client.connect(transport);
        const workspaceB = await runtime.services.addWorkspace({ rootPath: workspaceRootB });
        await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
        const afterSwitch = await runtime.services.startMcp({ workspaceId: workspaceB.id });
        expect(afterSwitch).toEqual(first);

        const [infoA, infoB] = await Promise.all([
          client.callTool({ name: 'workspace_info', arguments: { workspaceId: workspaceA.id } }),
          client.callTool({ name: 'workspace_info', arguments: { workspaceId: workspaceB.id } }),
        ]);
        expect(infoA.isError, JSON.stringify(infoA.structuredContent)).not.toBe(true);
        expect(infoB.isError, JSON.stringify(infoB.structuredContent)).not.toBe(true);
        expect(infoA.structuredContent).toMatchObject({ id: workspaceA.id });
        expect(infoB.structuredContent).toMatchObject({ id: workspaceB.id });
        const scopedWorkLog = (await runtime.services.getDashboard()).workLog.filter((entry) => entry.toolName === 'workspace_info');
        expect(scopedWorkLog.some((entry) => entry.workspaceId === workspaceA.id && entry.sessionId !== null)).toBe(true);
        expect(scopedWorkLog.some((entry) => entry.workspaceId === workspaceB.id && entry.sessionId !== null)).toBe(true);

        await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
        const infoBAfterSwitch = await client.callTool({ name: 'workspace_info', arguments: { workspaceId: workspaceB.id } });
        expect(infoBAfterSwitch.isError).not.toBe(true);
        expect((await runtime.services.startMcp({ workspaceId: workspaceA.id })).url).toBe(first.url);
      } finally {
        await transport.close();
      }
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);
  it('persists AI delete and STDIO security policy settings and applies scoped delete dynamically', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-policy-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-policy-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'delete-policy.txt'), 'payload', 'utf8');
      await expect(runtime.mcpServices.file.deleteFile(runtime.mcpActor, workspace.id, { path: 'delete-policy.txt' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      await expect(runtime.services.setAiDeletePolicy({ enabled: true })).resolves.toMatchObject({
        enabled: true,
        policy: { protectCriticalFiles: true, recoverableDelete: true, approvals: { delete_file: true, git_rm: false } },
      });
      await expect(runtime.mcpServices.file.deleteFile(runtime.mcpActor, workspace.id, { path: 'delete-policy.txt' }))
        .resolves.toMatchObject({ ok: true });
      await expect(readFile(path.join(workspaceRoot, 'delete-policy.txt'), 'utf8')).rejects.toThrow();

      const recoveryDashboard = await runtime.services.getDashboard();
      expect(recoveryDashboard.recovery.trashRoot).toBe(path.join(dataRoot, 'recovery-trash'));
      expect(recoveryDashboard.recovery.trashItems).toEqual([
        expect.objectContaining({ workspaceId: workspace.id, relativePath: 'delete-policy.txt', payloadAvailable: true }),
      ]);
      const recoveryId = recoveryDashboard.recovery.trashItems[0]?.recoveryId;
      expect(recoveryId).toEqual(expect.any(String));
      if (recoveryId === undefined) throw new Error('Recovery item was not created');
      await expect(runtime.services.restoreRecoveryItem({ workspaceId: workspace.id, recoveryId }))
        .resolves.toMatchObject({ restored: true, path: 'delete-policy.txt' });
      await expect(readFile(path.join(workspaceRoot, 'delete-policy.txt'), 'utf8')).resolves.toBe('payload');

      await expect(runtime.services.setPermissionProfile({ profile: 'full' })).resolves.toEqual({ profile: 'full' });
      const fullSettings = (await runtime.services.getDashboard()).settings;
      if (fullSettings === undefined) throw new Error('User settings were not available');
      await expect(runtime.services.setUserSettings({ settings: { ...fullSettings, desktopFullBypassAll: true, stdioFullBypassAll: true } }))
        .resolves.toMatchObject({ settings: { desktopFullBypassAll: true, stdioFullBypassAll: true } });
      await expect(runtime.services.setPermissionProfile({ profile: 'balanced' })).resolves.toEqual({ profile: 'balanced' });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({ settings: { desktopFullBypassAll: false, stdioFullBypassAll: true } });

      await expect(runtime.services.setStdioPolicy({ profile: 'safe', strictRoots: true, allowedRoots: [workspaceRoot] }))
        .resolves.toMatchObject({ profile: 'safe', strictRoots: true, allowedRoots: [workspaceRoot] });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        allowAiDelete: true, destructiveDeletePolicy: { approvals: { delete_file: true, git_rm: false } }, stdioPermissionProfile: 'safe', stdioStrictRoots: true, stdioAllowedRoots: [workspaceRoot],
        settings: { desktopFullBypassAll: false, stdioFullBypassAll: false },
      });
      await expect(runtime.services.setPermissionProfile({ profile: 'full' })).resolves.toEqual({ profile: 'full' });
      await expect(runtime.services.setStdioPolicy({ profile: 'full', strictRoots: false, allowedRoots: [] })).resolves.toMatchObject({ profile: 'full' });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({ settings: { desktopFullBypassAll: false, stdioFullBypassAll: false } });
    } finally {
      await runtime.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      await expect(restarted.services.getDashboard()).resolves.toMatchObject({
        allowAiDelete: true, stdioPermissionProfile: 'full', stdioStrictRoots: false, stdioAllowedRoots: [],
      });
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('archives, restores, and deletes project registrations without deleting the project folder', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-project-lifecycle-data-'));
    const rawWorkspaceA = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-project-lifecycle-a-'));
    const rawWorkspaceB = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-project-lifecycle-b-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceA, rawWorkspaceB);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRootA = await realpath(rawWorkspaceA);
    const workspaceRootB = await realpath(rawWorkspaceB);
    const markerPath = path.join(workspaceRootA, 'keep-me.txt');
    await writeFile(markerPath, 'project data must survive registration deletion', 'utf8');

    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async () => true });
    try {
      const workspaceA = await runtime.services.addWorkspace({ rootPath: workspaceRootA });
      const workspaceB = await runtime.services.addWorkspace({ rootPath: workspaceRootB });
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });

      await expect(runtime.services.setWorkspaceArchived({ workspaceId: workspaceA.id, archived: true })).resolves.toMatchObject({
        id: workspaceA.id,
        archivedAt: expect.any(String),
        kind: 'project',
      });
      await expect(runtime.mcpServices.file.readFile(runtime.mcpActor, workspaceA.id, { path: 'keep-me.txt' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
      const archivedList = await runtime.services.listWorkspaces();
      expect(archivedList).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspaceA.id, archivedAt: expect.any(String) })]));
      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).not.toBe(workspaceA.id);

      await expect(runtime.services.addWorkspace({ rootPath: workspaceRootA })).resolves.toMatchObject({
        id: workspaceA.id,
        archivedAt: null,
      });
      expect((await runtime.services.listWorkspaces()).filter((entry) => entry.rootPath === workspaceRootA)).toHaveLength(1);
      await runtime.services.setWorkspaceArchived({ workspaceId: workspaceA.id, archived: true });
      await expect(runtime.services.setWorkspaceArchived({ workspaceId: workspaceA.id, archived: false })).resolves.toMatchObject({
        id: workspaceA.id,
        archivedAt: null,
      });
      await expect(runtime.mcpServices.file.readFile(runtime.mcpActor, workspaceA.id, { path: 'keep-me.txt' }))
        .resolves.toMatchObject({ ok: true });

      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      await expect(runtime.services.deleteWorkspace({ workspaceId: workspaceA.id, userConfirmed: false }))
        .rejects.toThrow(/confirmation/i);
      const deleted = await runtime.services.deleteWorkspace({ workspaceId: workspaceA.id, userConfirmed: true });
      expect(deleted).toEqual({
        deleted: true,
        workspaceId: workspaceA.id,
        rootPath: workspaceRootA,
        backupId: expect.stringMatching(/^backup-/),
      });
      expect((await runtime.services.getDashboard()).backups).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: deleted.backupId, reason: 'manual' }),
      ]));
      expect((await runtime.services.listWorkspaces()).some((entry) => entry.id === workspaceA.id)).toBe(false);
      await expect(readFile(markerPath, 'utf8')).resolves.toBe('project data must survive registration deletion');
      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).not.toBe(workspaceA.id);
      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).toBeDefined();
      expect(workspaceB.id).not.toBe(workspaceA.id);

      expect((await runtime.services.listWorkspaces()).some((entry) => entry.kind === 'machine_root')).toBe(false);
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('restores the persisted UI locale for native tray startup', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-locale-data-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    try {
      expect(firstRuntime.getLocale()).toBe('th');
      await expect(firstRuntime.services.setLocale({ locale: 'en' })).resolves.toEqual({ locale: 'en' });
      expect(firstRuntime.getLocale()).toBe('en');
    } finally {
      await firstRuntime.close();
    }

    const restartedRuntime = createDesktopRuntime(dataRoot);
    try {
      expect(restartedRuntime.getLocale()).toBe('en');
      await expect(restartedRuntime.services.getDashboard()).resolves.toMatchObject({ locale: 'en' });
    } finally {
      await restartedRuntime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('persists user-configurable runtime settings and custom MCP server definitions', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-user-settings-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    try {
      const initial = firstRuntime.getUserSettings();
      expect(initial.eccEnabled).toBe(false);
      expect(initial.tunnelAutoReconnect).toBe(false);
      const next = {
        ...initial,
        mcpCallTimeoutMs: 120_000,
        mcpIdleTimeoutMs: 10 * 60_000,
        processTimeoutMs: 90 * 60_000,
        mcpPollWaitSeconds: 25,
        shellSynchronousWaitSeconds: 45,
        capabilityRoots: ['D:\\Projects', 'E:\\Work'],
        pdfProviderPath: 'C:\\Tools\\pdftotext.exe',
        lspCommands: { typescript: '["typescript-language-server","--stdio"]', python: '["pyright-langserver","--stdio"]' },
        codexToolsEnabled: true,
        eccEnabled: true,
        updateAutoCheck: false,
        updateCheckOnStartup: false,
        updateIntervalMinutes: 120,
        updateAutoDownload: false,
        closeBehavior: 'quit' as const,
        launchAtStartup: true,
        startMinimized: true,
        tunnelAutoReconnect: true,
        tunnelMaxAutoRestarts: 2,
        customPermission: {
          read: 'ALLOW' as const,
          write: 'ALLOW' as const,
          execute: 'ASK' as const,
          dangerous: 'DENY' as const,
          allowedExecutables: ['python.exe', 'docker.exe'],
        },
        extensions: {
          ...initial.extensions,
          mode: 'allowlist' as const,
          enabledServers: ['demo'],
          extraSkillRoots: ['D:\\Skills'],
          extraMcpServers: [{
            name: 'demo',
            command: 'node.exe',
            args: ['server.js'],
            cwd: 'D:\\Mcp',
            type: 'stdio',
            env: { DEMO_MODE: '1' },
          }],
        },
      };

      await expect(firstRuntime.services.setUserSettings({ settings: next })).resolves.toMatchObject({
        restartRequired: true,
        settings: next,
      });
      await expect(firstRuntime.services.getDashboard()).resolves.toMatchObject({ settings: next });
    } finally {
      await firstRuntime.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      await expect(restarted.services.getDashboard()).resolves.toMatchObject({
        settings: {
          mcpCallTimeoutMs: 120_000,
          mcpIdleTimeoutMs: 10 * 60_000,
          processTimeoutMs: 90 * 60_000,
          mcpPollWaitSeconds: 25,
          shellSynchronousWaitSeconds: 45,
          capabilityRoots: ['D:\\Projects', 'E:\\Work'],
          pdfProviderPath: 'C:\\Tools\\pdftotext.exe',
          lspCommands: { typescript: '["typescript-language-server","--stdio"]', python: '["pyright-langserver","--stdio"]' },
          codexToolsEnabled: true,
          eccEnabled: true,
          updateAutoCheck: false,
          updateCheckOnStartup: false,
          updateIntervalMinutes: 120,
          updateAutoDownload: false,
          closeBehavior: 'quit',
          launchAtStartup: true,
          startMinimized: true,
          tunnelAutoReconnect: true,
          tunnelMaxAutoRestarts: 2,
          customPermission: { allowedExecutables: ['python.exe', 'docker.exe'] },
          extensions: {
            mode: 'allowlist',
            enabledServers: ['demo'],
            extraSkillRoots: ['D:\\Skills'],
            extraMcpServers: [{ name: 'demo', command: 'node.exe', args: ['server.js'], cwd: 'D:\\Mcp', type: 'stdio', env: { DEMO_MODE: '1' } }],
          },
        },
      });
    } finally {
      await restarted.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('installs and configures the PDF provider through the desktop service without requiring restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-pdf-provider-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const providerPath = path.join(dataRoot, 'runtime-tools', 'pdf-provider', 'fixture', 'Library', 'bin', 'pdftotext.exe');
    const runtime = createDesktopRuntime(dataRoot, {
      pdfProviderInstaller: async () => ({
        providerPath,
        version: 'fixture',
        sourceUrl: 'https://example.invalid/poppler.zip',
        archiveSha256: 'a'.repeat(64),
        reused: false,
      }),
    });
    try {
      if (process.platform !== 'win32') {
        await expect(runtime.services.installPdfProvider()).rejects.toThrow('supports only win32/x64');
        expect(runtime.getUserSettings().pdfProviderPath).not.toBe(providerPath);
        return;
      }
      await expect(runtime.services.installPdfProvider()).resolves.toMatchObject({
        providerPath,
        version: 'fixture',
        reused: false,
        restartRequired: false,
      });
      expect(runtime.getUserSettings().pdfProviderPath).toBe(providerPath);
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('applies MCP poll and foreground wait settings live without requiring a runtime restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-live-waits-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const initial = runtime.getUserSettings();
      expect(initial).toMatchObject({ mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60 });
      const next = { ...initial, mcpPollWaitSeconds: 20, shellSynchronousWaitSeconds: 40 };
      await expect(runtime.services.setUserSettings({ settings: next })).resolves.toMatchObject({
        restartRequired: false,
        settings: { mcpPollWaitSeconds: 20, shellSynchronousWaitSeconds: 40 },
      });
      expect(runtime.getUserSettings()).toMatchObject({ mcpPollWaitSeconds: 20, shellSynchronousWaitSeconds: 40 });
    } finally {
      await runtime.close();
    }
  }, RUNTIME_TEST_TIMEOUT_MS);

  it('serves the local capability health tool through the desktop MCP listener', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async () => true });
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      const connection = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (connection.url === null) return;
      const client = new Client({ name: 'desktop-capability-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(connection.url));
      try {
        await client.connect(transport);
        const response = await client.callTool({ name: 'health', arguments: { operation: 'check_tool', tool: 'shell' } });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ tool: 'shell', available: true });
        await writeFile(
          path.join(workspaceRoot, 'local-shell-task.mjs'),
          "setTimeout(() => process.stdout.write('local-shell'), 5500);",
          'utf8',
        );
        const shellStartedAt = Date.now();
        const shellResponse = await client.callTool({
          name: 'shell',
          arguments: {
            workspaceId: workspace.id,
            executable: process.execPath,
            arguments: ['local-shell-task.mjs'],
            cwd: workspaceRoot,
            execution: 'foreground',
            userConfirmed: true,
          },
        });
        expect(Date.now() - shellStartedAt).toBeLessThan(4_000);
        expect(shellResponse.isError).not.toBe(true);
        expect(shellResponse.structuredContent).toMatchObject({ state: 'running', task_id: expect.any(String) });
        const shellTaskId = (shellResponse.structuredContent as { task_id: string }).task_id;
        let shellResult = shellResponse;
        for (let attempt = 0; attempt < 140 && shellResult.structuredContent?.state === 'running'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          shellResult = await client.callTool({ name: 'shell', arguments: { operation: 'result', task_id: shellTaskId } });
        }
        expect(shellResult.isError).not.toBe(true);
        expect(shellResult.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'local-shell' });
        if (process.platform === 'win32') {
          const windowHealth = await client.callTool({ name: 'health', arguments: { operation: 'check_tool', tool: 'window' } });
          expect(windowHealth.isError).not.toBe(true);
          expect(windowHealth.structuredContent).toMatchObject({ tool: 'window', availability: 'optional', available: true });

          const input = await client.callTool({ name: 'input_event', arguments: { operation: 'click', parameters: { x: 0, y: 0 }, dry_run: true } });
          expect(input.isError).not.toBe(true);
          expect(input.structuredContent).toMatchObject({ dry_run: true, capability: 'input_event' });

          const windows = await client.callTool({ name: 'window', arguments: { operation: 'list' } });
          if (windows.isError) {
            // Hosted Windows runners can be headless even though the capability is valid for win32.
            expect(windows.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'Operation failed' } });
          } else {
            expect(windows.structuredContent).toMatchObject({ windows: expect.any(Array) });
            const accessibility = await client.callTool({ name: 'accessibility', arguments: { action: 'status' } });
            expect(accessibility.isError).not.toBe(true);
            expect(accessibility.structuredContent).toMatchObject({ available: true });
            const vision = await client.callTool({ name: 'vision', arguments: { action: 'capture_region', region: { x: 0, y: 0, width: 64, height: 64 } } });
            if (!vision.isError) {
              expect(vision.structuredContent).toMatchObject({ format: 'png', width: 64, height: 64 });
            }
          }
        }
      } finally {
        await client.close();
      }
    } finally {
      await runtime.close();
    }
  }, LONG_RUNTIME_TEST_TIMEOUT_MS);
});

async function closeRuntime(runtime: DesktopRuntime): Promise<void> {
  await runtime.close();
}
