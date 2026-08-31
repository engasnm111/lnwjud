import { describe, expect, it } from 'vitest';
import type { ToolCatalogItem } from '@lnwjud/ipc-contracts';
import { catalogStatusCounts, filterAndSortTools } from '../src/renderer/features/tools/tool-catalog-view.js';

function item(name: string, readiness: ToolCatalogItem['readiness'], origin: ToolCatalogItem['origin'] = 'lnwjud'): ToolCatalogItem {
  return {
    name, origin, category: 'files', title: name, shortDescription: `${name} short`, longDescription: `${name} long`,
    declaredPermission: origin === 'external_mcp' ? 'UNKNOWN' : 'READ', profileDecision: origin === 'external_mcp' ? 'UNKNOWN' : 'ALLOW',
    riskMode: origin === 'external_mcp' ? 'external_unknown' : 'fixed', readiness, stale: false, checkedAt: null,
    supportsCancel: origin === 'external_mcp' ? null : true, supportsDryRun: origin === 'external_mcp' ? null : false,
    requirements: [], remediationIds: [], inputSchema: null, searchText: [name], ...(origin === 'external_mcp' ? { serverName: 'demo' } : {}),
  };
}

const baseFilters = { origin: 'lnwjud' as const, query: '', readiness: 'all' as const, category: 'all' as const, permission: 'all' as const, profileDecision: 'all' as const };

describe('tool catalog renderer model', () => {
  it('sorts issues before ready tools and filters without hard-coded inventory counts', () => {
    const items = [item('ready-one', 'ready'), item('blocked-one', 'blocked'), item('setup-one', 'needs_setup')];
    expect(filterAndSortTools(items, baseFilters).map((entry) => entry.name)).toEqual(['blocked-one', 'setup-one', 'ready-one']);
    expect(catalogStatusCounts(items)).toMatchObject({ ready: 1, blocked: 1, needs_setup: 1 });
  });
  it('keeps external MCP tools separate and searchable', () => {
    const items = [item('read_file', 'ready'), item('remote_search', 'unknown', 'external_mcp')];
    expect(filterAndSortTools(items, { ...baseFilters, origin: 'external_mcp', query: 'remote' }).map((entry) => entry.name)).toEqual(['remote_search']);
    expect(filterAndSortTools(items, { ...baseFilters, origin: 'lnwjud' }).map((entry) => entry.name)).toEqual(['read_file']);
  });
});
