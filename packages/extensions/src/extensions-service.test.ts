import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { LocalExtensionsService } from './extensions-service.js';
import type { McpClientFactory, McpClientSession } from './mcp-session-manager.js';

function settingsWithMockServer(): typeof DEFAULT_EXTENSIONS_SETTINGS {
  return {
    ...DEFAULT_EXTENSIONS_SETTINGS,
    extraMcpServers: {
      mock: { command: 'node', args: ['mock-server.js'] },
    },
  };
}

describe('LocalExtensionsService MCP bridge', () => {
  it('includes a packaged bundled-skill root without hiding global or workspace skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-bundled-skills-'));
    try {
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const bundled = path.join(root, 'agent-skills');
      for (const [skillRoot, name] of [
        [path.join(home, '.agents', 'skills', 'global-skill'), 'global-skill'],
        [path.join(workspace, '.agents', 'skills', 'workspace-skill'), 'workspace-skill'],
        [path.join(bundled, 'lnwjud-scheduled-continuation'), 'lnwjud-scheduled-continuation'],
      ] as const) {
        await mkdir(skillRoot, { recursive: true });
        await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when testing ${name}\n---\n# ${name}\n`, 'utf8');
      }
      const service = new LocalExtensionsService({
        settings: DEFAULT_EXTENSIONS_SETTINGS,
        homeDir: home,
        workspaceRootProvider: async () => workspace,
        bundledSkillRoots: [bundled],
      } as never);

      const listed = await service.listSkills({});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.skills.map((skill) => skill.name).sort()).toEqual([
        'global-skill',
        'lnwjud-scheduled-continuation',
        'workspace-skill',
      ]);
      await expect(service.readSkill({ skillId: 'lnwjud-scheduled-continuation' }))
        .resolves.toMatchObject({ ok: true, value: { name: 'lnwjud-scheduled-continuation' } });
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists, describes, and calls child MCP tools through the session manager', async () => {
    const calls: string[] = [];
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool', inputSchema: { type: 'object' } }],
      listResources: async () => [{ uri: 'file:///docs/readme.md', name: 'README', description: 'Project docs', mimeType: 'text/markdown' }],
      callTool: async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return { content: [{ type: 'text', text: 'pong' }] };
      },
      close: async () => undefined,
    };
    const factory: McpClientFactory = {
      connect: async () => session,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });

    const listed = await service.listMcpServers();
    expect(listed).toMatchObject({ ok: true, value: { servers: [expect.objectContaining({ name: 'mock', enabled: true })] } });

    const described = await service.describeMcpServer({ server: 'mock' });
    expect(described).toMatchObject({
      ok: true,
      value: {
        server: 'mock',
        tools: [{ name: 'ping', description: 'Ping tool' }],
      },
    });

    const resources = await service.listMcpResources({ server: 'mock' });
    expect(resources).toMatchObject({
      ok: true,
      value: { server: 'mock', connected: true, resources: [{ uri: 'file:///docs/readme.md', name: 'README', mimeType: 'text/markdown' }] },
    });

    const called = await service.callMcpTool({ server: 'mock', tool: 'ping', arguments: { n: 1 } });
    expect(called.ok).toBe(true);
    expect(calls).toEqual(['ping:{"n":1}']);

    await service.close();
  });

  it('does not connect a child MCP server when the request is already cancelled', async () => {
    let connects = 0;
    const factory: McpClientFactory = {
      connect: async () => {
        connects += 1;
        throw new Error('must not connect');
      },
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(service.describeMcpServer({ server: 'mock' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(connects).toBe(0);

    await service.close();
  });

  it('aborts an in-flight child MCP call and closes its managed session', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async (_name, _args, signal) => {
        observedSignal = signal;
        releaseStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('child call cancelled');
      },
      close: async () => { closes += 1; },
    };
    const factory: McpClientFactory = { connect: async () => session };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });
    const controller = new AbortController();

    const pending = service.callMcpTool({ server: 'mock', tool: 'ping' }, controller.signal);
    await started;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(observedSignal?.aborted).toBe(true);
    expect(closes).toBe(1);
    await service.close();
  });
});
