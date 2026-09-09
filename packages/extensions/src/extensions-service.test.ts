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
        [path.join(bundled, 'ponytail'), 'ponytail'],
        [path.join(bundled, 'ponytail-review'), 'ponytail-review'],
        [path.join(bundled, 'ponytail-audit'), 'ponytail-audit'],
        [path.join(bundled, 'ponytail-debt'), 'ponytail-debt'],
        [path.join(bundled, 'ponytail-gain'), 'ponytail-gain'],
        [path.join(bundled, 'ponytail-help'), 'ponytail-help'],
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
        'ponytail',
        'ponytail-audit',
        'ponytail-debt',
        'ponytail-gain',
        'ponytail-help',
        'ponytail-review',
        'workspace-skill',
      ]);
      for (const skillName of ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'] as const) {
        const skill = listed.value.skills.find((entry) => entry.name === skillName);
        expect(skill).toMatchObject({
          id: `bundled:agent-skills/${skillName}`,
          source: 'bundled:agent-skills',
          trustTier: 'bundled',
        });
        await expect(service.readSkill({ skillId: `bundled:agent-skills/${skillName}` }))
          .resolves.toMatchObject({ ok: true, value: { id: `bundled:agent-skills/${skillName}`, name: skillName, trustTier: 'bundled' } });
      }
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

  it('fingerprints external MCP contracts and surfaces live tool-catalog drift', async (): Promise<void> => {
    let catalog = [{
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } }, additionalProperties: false },
    }];
    const session: McpClientSession = {
      listTools: async () => catalog,
      listResources: async () => [],
      callTool: async () => ({ structuredContent: { answer: 1 }, content: [] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    const first = await service.describeMcpServer({ server: 'mock' });
    expect(first).toMatchObject({
      ok: true,
      value: {
        provenance: {
          trustTier: 'external',
          namespace: 'mcp:mock',
          descriptorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          catalogFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          drift: { detected: false, reasons: [] },
        },
        tools: [expect.objectContaining({ qualifiedName: 'mcp:mock/ping', outputSchema: expect.any(Object) })],
      },
    });
    if (!first.ok) return;
    const initialFingerprint = first.value.provenance.catalogFingerprint;

    catalog = [{
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false },
    }];
    const changed = await service.describeMcpServer({ server: 'mock' });
    expect(changed).toMatchObject({
      ok: true,
      value: {
        provenance: {
          drift: { detected: true, reasons: ['tool_catalog'], previousCatalogFingerprint: initialFingerprint },
        },
      },
    });
    if (changed.ok) expect(changed.value.provenance.catalogFingerprint).not.toBe(initialFingerprint);
    await service.close();
  });

  it('rejects child structured output that violates a declared external output schema', async (): Promise<void> => {
    const session: McpClientSession = {
      listTools: async () => [{
        name: 'ping',
        description: 'Ping tool',
        outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } }, additionalProperties: false },
      }],
      listResources: async () => [],
      callTool: async () => ({ structuredContent: { answer: 'spoofed' }, content: [] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('output schema mismatch') },
    });
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
