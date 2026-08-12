import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ToolRegistry } from '../tool-registry.js';
import type { ExtensionsService } from '@lnwjud/extensions';

describe('skills and mcp bridge tools', () => {
  it('registers full-access meta-tools and dispatches to ExtensionsService', async () => {
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [{ id: 'a/b', name: 'b', description: 'd', source: 'a', rootPath: '/', skillPath: '/SKILL.md' }] }),
      readSkill: async () => ok({ id: 'a/b', name: 'b', description: 'd', source: 'a', path: '/SKILL.md', content: '# b' }),
      listMcpServers: async () => ok({ servers: [{ name: 'mock', source: 'test', enabled: true, connected: false, excluded: false, command: 'node' }] }),
      describeMcpServer: async () => ok({ server: 'mock', enabled: true, connected: true, tools: [{ name: 'ping', description: 'Ping' }] }),
      callMcpTool: async () => ok({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'test', clientName: 'test' });
    const names = registry.list().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call']));
    for (const name of ['skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call']) {
      const tool = registry.list().find((entry) => entry.name === name);
      expect(tool?.permission).toBe('DANGEROUS');
      expect(tool?.annotations.readOnlyHint).toBe(false);
    }

    await expect(registry.invoke('skills_list', {})).resolves.toMatchObject({
      structuredContent: { skills: [expect.objectContaining({ id: 'a/b' })] },
    });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {} })).resolves.toMatchObject({
      structuredContent: { content: [{ type: 'text', text: 'pong' }] },
    });
  });
});
