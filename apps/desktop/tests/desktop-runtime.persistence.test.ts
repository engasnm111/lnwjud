import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, type DesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

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
    } finally {
      await runtime.close();
    }
  });
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
  }, 30_000);

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
  }, 30_000);
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

      await expect(runtime.services.setStdioPolicy({ profile: 'safe', strictRoots: true, allowedRoots: [workspaceRoot] }))
        .resolves.toMatchObject({ profile: 'safe', strictRoots: true, allowedRoots: [workspaceRoot] });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        allowAiDelete: true, destructiveDeletePolicy: { approvals: { delete_file: true, git_rm: false } }, stdioPermissionProfile: 'safe', stdioStrictRoots: true, stdioAllowedRoots: [workspaceRoot],
      });
    } finally {
      await runtime.close();
    }

    const restarted = createDesktopRuntime(dataRoot);
    try {
      await expect(restarted.services.getDashboard()).resolves.toMatchObject({
        allowAiDelete: true, stdioPermissionProfile: 'safe', stdioStrictRoots: true, stdioAllowedRoots: [workspaceRoot],
      });
    } finally {
      await restarted.close();
    }
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  it('persists user-configurable runtime settings and custom MCP server definitions', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-user-settings-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    try {
      const initial = firstRuntime.getUserSettings();
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
        updateAutoCheck: false,
        updateCheckOnStartup: false,
        updateIntervalMinutes: 120,
        updateAutoDownload: false,
        closeBehavior: 'quit' as const,
        launchAtStartup: true,
        startMinimized: true,
        tunnelAutoReconnect: false,
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
          updateAutoCheck: false,
          updateCheckOnStartup: false,
          updateIntervalMinutes: 120,
          updateAutoDownload: false,
          closeBehavior: 'quit',
          launchAtStartup: true,
          startMinimized: true,
          tunnelAutoReconnect: false,
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
          expect(windowHealth.structuredContent).toMatchObject({ tool: 'window', availability: 'windows', available: true });

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
  }, 60_000);
});

async function closeRuntime(runtime: DesktopRuntime): Promise<void> {
  await runtime.close();
}
