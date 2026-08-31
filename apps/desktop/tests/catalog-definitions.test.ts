import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@lnwjud/mcp-server';
import { catalogDefinitions, KNOWN_TOOL_REQUIREMENT_IDS } from '../src/main/tool-catalog/catalog-definitions.js';
import { resolveCatalogCopy } from '../src/main/tool-catalog/catalog-copy.js';

const actor = { clientId: 'catalog-contract-test', clientName: 'catalog-contract-test' };
const registryNames = new ToolRegistry({}, actor, { codexToolsEnabled: true }).listAll().map((definition) => definition.name).sort();
const metadataNames = Object.keys(catalogDefinitions).sort();
const knownRequirementIds = new Set<string>(KNOWN_TOOL_REQUIREMENT_IDS);

const categories = new Set([
  'workspace', 'files', 'search_context', 'git', 'process', 'browser_desktop', 'system', 'office_media', 'automation', 'agent_goals', 'extensions',
]);

describe('canonical bilingual tool catalog', () => {
  it('is an exact one-to-one set with every first-party definition', () => {
    expect(metadataNames).toEqual(registryNames);
    expect(new Set(metadataNames).size).toBe(metadataNames.length);
  });

  it('uses only declared categories and requirement ids', () => {
    for (const definition of Object.values(catalogDefinitions)) {
      expect(categories.has(definition.category), `${definition.name} category`).toBe(true);
      for (const requirementId of definition.requirementIds) {
        expect(knownRequirementIds.has(requirementId), `${definition.name} -> ${requirementId}`).toBe(true);
      }
    }
  });

  it('has non-empty English and Thai title, short, and long copy for every tool', () => {
    for (const definition of Object.values(catalogDefinitions)) {
      for (const locale of ['en', 'th'] as const) {
        for (const key of [definition.titleKey, definition.shortDescriptionKey, definition.longDescriptionKey]) {
          expect(resolveCatalogCopy(locale, key).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps provider-specific tools on their real prerequisites', () => {
    expect(catalogDefinitions.inspect_pdf?.requirementIds).toContain('local_pdf_provider');
    expect(catalogDefinitions.pdf_extract_tables?.requirementIds).toContain('local_pdf_provider');
    expect(catalogDefinitions.inspect_pdf?.requirementIds).not.toContain('office_desktop');
    expect(catalogDefinitions.lsp_diagnostics?.requirementIds).toContain('configured_lsp');
    expect(catalogDefinitions.db_query?.requirementIds).toContain('database_target');
    expect(catalogDefinitions.sandbox_exec?.requirementIds).toContain('windows_sandbox');
    expect(catalogDefinitions.network_context?.requirementIds).toContain('browser_event_stream');
    expect(catalogDefinitions.console_context?.requirementIds).toContain('browser_event_stream');
  });
});
