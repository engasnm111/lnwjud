import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@lnwjud/mcp-server';
import { catalogDefinitions, KNOWN_TOOL_REQUIREMENT_IDS } from './catalog-definitions.js';
import { resolveCatalogCopy } from './catalog-copy.js';

const actor = { clientId: 'catalog-test', clientName: 'Catalog Test' };
const liveDefinitions = new ToolRegistry({}, actor, { codexToolsEnabled: true }).listAll();
const validCategories = new Set([
  'workspace', 'files', 'search_context', 'git', 'process', 'browser_desktop', 'system', 'office_media',
  'automation', 'agent_goals', 'extensions',
]);
const knownRequirementIds = new Set(KNOWN_TOOL_REQUIREMENT_IDS);

describe('canonical bilingual tool catalog', () => {
  it('matches every first-party ToolRegistry definition exactly in both directions', () => {
    const liveNames = liveDefinitions.map((definition) => definition.name).sort();
    const catalogNames = Object.keys(catalogDefinitions).sort();
    expect(catalogNames).toEqual(liveNames);
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
  });

  it('uses only approved categories and requirement IDs', () => {
    for (const definition of Object.values(catalogDefinitions)) {
      expect(validCategories.has(definition.category)).toBe(true);
      expect(['fixed', 'input_dependent']).toContain(definition.riskMode);
      for (const requirementId of definition.requirementIds) {
        expect(knownRequirementIds.has(requirementId as typeof KNOWN_TOOL_REQUIREMENT_IDS[number])).toBe(true);
      }
    }
  });

  it('resolves non-empty Thai and English title/short/long copy for every definition', () => {
    for (const definition of Object.values(catalogDefinitions)) {
      for (const locale of ['th', 'en'] as const) {
        for (const key of [definition.titleKey, definition.shortDescriptionKey, definition.longDescriptionKey]) {
          const copy = resolveCatalogCopy(locale, key);
          expect(copy.trim(), `${locale}:${key}`).not.toBe('');
        }
      }
    }
  });

  it('does not resolve unknown renderer-controlled catalog keys', () => {
    expect(resolveCatalogCopy('en', 'tool.not_real.title')).toBe('');
    expect(resolveCatalogCopy('th', 'https://example.com')).toBe('');
  });
});
