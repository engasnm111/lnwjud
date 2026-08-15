import { mkdtemp, rm } from 'node:fs/promises';
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
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DesktopRuntime persistence', () => {
  it('restores workspaces and permission settings without restoring an MCP listener', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-data-'));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-workspace-'));
    temporaryRoots.push(dataRoot, workspaceRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    let firstClosed = false;
    try {
      const workspace = await firstRuntime.services.addWorkspace({ rootPath: workspaceRoot });
      await firstRuntime.services.setPermissionProfile({ profile: 'balanced' });
      await expect(firstRuntime.services.startMcp({ workspaceId: workspace.id })).resolves.toMatchObject({ running: true });
      await firstRuntime.close();
      firstClosed = true;

      const restartedRuntime = createDesktopRuntime(dataRoot);
      try {
        const listed = await restartedRuntime.services.listWorkspaces();
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: workspace.id, realRootPath: workspaceRoot }),
        ]));
        await expect(restartedRuntime.services.getDashboard()).resolves.toMatchObject({
          permissionProfile: 'full',
          mcp: { running: false, url: null, workspaceId: null },
        });
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      if (!firstClosed) await closeRuntime(firstRuntime);
    }
  });

  it('serves the local capability health tool through the desktop MCP listener', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-data-'));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-workspace-'));
    temporaryRoots.push(dataRoot, workspaceRoot);
    const runtime = createDesktopRuntime(dataRoot);
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      const connection = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (connection.url === null) return;
      const client = new Client({ name: 'desktop-capability-test', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(connection.url));
      try {
        await client.connect(transport);
        const response = await client.callTool({ name: 'health', arguments: { operation: 'check_tool', tool: 'shell' } });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ tool: 'shell', available: true });
        const shellResponse = await client.callTool({
          name: 'shell',
          arguments: {
            executable: process.execPath,
            arguments: ['-e', "process.stdout.write('local-shell')"],
            cwd: workspaceRoot,
            execution: 'foreground',
          },
        });
        expect(shellResponse.isError).not.toBe(true);
        expect(shellResponse.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'local-shell' });
        if (process.platform === 'win32') {
          const windows = await client.callTool({ name: 'window', arguments: { operation: 'list' } });
          expect(windows.isError).not.toBe(true);
          expect(windows.structuredContent).toMatchObject({ windows: expect.any(Array) });
          const accessibility = await client.callTool({ name: 'accessibility', arguments: { action: 'status' } });
          expect(accessibility.isError).not.toBe(true);
          expect(accessibility.structuredContent).toMatchObject({ available: true });
          const input = await client.callTool({ name: 'input_event', arguments: { operation: 'click', parameters: { x: 0, y: 0 }, dry_run: true } });
          expect(input.isError).not.toBe(true);
          expect(input.structuredContent).toMatchObject({ dry_run: true, capability: 'input_event' });
          const vision = await client.callTool({ name: 'vision', arguments: { action: 'capture_region', region: { x: 0, y: 0, width: 64, height: 64 } } });
          expect(vision.isError).not.toBe(true);
          expect(vision.structuredContent).toMatchObject({ format: 'png', width: 64, height: 64 });
        }
      } finally {
        await client.close();
      }
    } finally {
      await runtime.close();
    }
  });
});

async function closeRuntime(runtime: DesktopRuntime): Promise<void> {
  await runtime.close();
}
