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

  it('distinguishes the local Windows scheduler from Native ChatGPT Scheduled Tasks', () => {
    const scheduler = catalogDefinitions.scheduler;
    expect(scheduler).toBeDefined();
    if (scheduler === undefined) return;

    const en = {
      title: resolveCatalogCopy('en', scheduler.titleKey),
      short: resolveCatalogCopy('en', scheduler.shortDescriptionKey),
      long: resolveCatalogCopy('en', scheduler.longDescriptionKey),
    };
    const th = {
      title: resolveCatalogCopy('th', scheduler.titleKey),
      short: resolveCatalogCopy('th', scheduler.shortDescriptionKey),
      long: resolveCatalogCopy('th', scheduler.longDescriptionKey),
    };

    expect(en.title).toContain('Windows Task Scheduler');
    expect(en.short).toContain('not Native ChatGPT Scheduled Tasks');
    expect(en.long).toContain('host-owned');
    expect(th.title).toContain('ภายในเครื่อง');
    expect(th.short).toContain('ไม่ใช่ Native ChatGPT Scheduled Tasks');
    expect(th.long).toContain('ChatGPT host');
  });

  it('keeps Windows-only capability tools on an explicit Windows platform boundary', () => {
    for (const name of ['wsl_exec', 'wsl_fs', 'office_outlook', 'windows_environment', 'registry_context', 'sandbox_exec'] as const) {
      expect(catalogDefinitions[name]?.requirementIds, name).toContain('platform_windows');
    }
    expect(catalogDefinitions.system_info?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.notification?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.file_dialog?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.clipboard?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.audio?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.screen_record?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.office?.requirementIds).toContain('platform_supported');
    expect(catalogDefinitions.scheduler?.requirementIds).toContain('platform_supported');
    expect(catalogDefinitions.shell?.requirementIds).not.toContain('platform_windows');
    expect(catalogDefinitions.web_fetch?.requirementIds).not.toContain('platform_windows');
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
