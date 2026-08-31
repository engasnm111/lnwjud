import { describe, expect, it } from 'vitest';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';
import { ToolRegistry } from './tool-registry.js';
import { CORE_TOOL_SMOKE_INPUTS } from './tool-runtime-fixtures.js';
import { createRuntimeSuccessServices as successServices, runtimeRecord as record } from './tool-runtime-test-harness.js';

const actor = { clientId: 'core-readiness-test', clientName: 'core-readiness-test' };
const workspaceId = 'workspace-1';

const STATEFUL_CORE_SUCCESS_TOOLS = new Set([
  'workspace_context_continue',
  'workspace_full_scan_continue',
  'read_file_page_continue',
  'ui_target_action',
]);

function coreRegistry(): ToolRegistry {
  return new ToolRegistry({}, actor, { codexToolsEnabled: true });
}

function successRegistry(calls: string[]): ToolRegistry {
  return new ToolRegistry(successServices(calls), actor, { codexToolsEnabled: true });
}

async function executeParsed(registry: ToolRegistry, name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
  const tool = registry.list().find((candidate) => candidate.name === name);
  expect(tool, `missing ${name}`).toBeDefined();
  if (tool === undefined) throw new Error(`missing ${name}`);
  const parsed = tool.parse(input);
  expect(parsed, `${name} representative input`).toMatchObject({ ok: true });
  if (!parsed.ok) throw new Error(`${name} representative input did not parse`);
  const result = await tool.execute(parsed.value, new AbortController().signal);
  expect(result, `${name} success-dispatch result`).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`${name} did not reach a successful implementation: ${result.error.message}`);
  return result.value;
}

function coreToolNames(registry: ToolRegistry): string[] {
  const upgrade = new Set(UPGRADE_TOOL_CATALOG.map((entry) => entry.name));
  return registry.listAll().map((tool) => tool.name).filter((name) => !upgrade.has(name)).sort();
}

describe('core tool readiness', () => {
  it('tracks one representative contract for every core tool in the complete 231-tool inventory', () => {
    const registry = coreRegistry();
    expect(registry.listAll()).toHaveLength(231);
    const advertisedUpgradeCount = UPGRADE_TOOL_CATALOG.filter((entry) => entry.deliveryState !== 'feature_disabled' && entry.deliveryState !== 'planned').length;
    expect(registry.list()).toHaveLength(coreToolNames(registry).length + advertisedUpgradeCount);
    expect(UPGRADE_TOOL_CATALOG).toHaveLength(138);
    expect(coreToolNames(registry)).toHaveLength(93);
    expect(Object.keys(CORE_TOOL_SMOKE_INPUTS).sort()).toEqual(coreToolNames(registry));
  });

  it.each(Object.entries(CORE_TOOL_SMOKE_INPUTS))('%s accepts its representative input and fails closed without backing services', async (name, input) => {
    const registry = coreRegistry();
    const tool = registry.list().find((candidate) => candidate.name === name);
    expect(tool, `missing ${name}`).toBeDefined();
    if (tool === undefined) return;

    const parsed = tool.parse(input);
    expect(parsed, `${name} representative input`).toMatchObject({ ok: true });
    if (!parsed.ok) return;

    const result = await tool.execute(parsed.value, new AbortController().signal);
    expect(result).toHaveProperty('ok');
    if (!result.ok) {
      expect(result.error.message).not.toMatch(/not implemented/i);
      expect(result.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it.each(Object.entries(CORE_TOOL_SMOKE_INPUTS).filter(([name]) => !STATEFUL_CORE_SUCCESS_TOOLS.has(name)))('%s reaches a real backing service on the success path', async (name, input) => {
    const calls: string[] = [];
    const registry = successRegistry(calls);
    const before = calls.length;
    await executeParsed(registry, name, input);
    expect(calls.length, `${name} returned success without dispatching to an application/capability service`).toBeGreaterThan(before);
  });

  it('covers every stateful core continuation/action success path with real primitives', async () => {
    const calls: string[] = [];
    const registry = successRegistry(calls);

    const context = record(await executeParsed(registry, 'workspace_context', { workspaceId, query: 'smoke', pageSize: 1 }));
    expect(context.continuationToken).toEqual(expect.any(String));
    const contextBefore = calls.length;
    await executeParsed(registry, 'workspace_context_continue', { continuationToken: context.continuationToken as string });
    expect(calls.length).toBeGreaterThan(contextBefore);

    const scan = record(await executeParsed(registry, 'workspace_full_scan', { workspaceId, pageSize: 1 }));
    expect(scan.continuationToken).toEqual(expect.any(String));
    await executeParsed(registry, 'workspace_full_scan_continue', { continuationToken: scan.continuationToken as string });

    const page = record(await executeParsed(registry, 'read_file_page', { workspaceId, path: 'paged.txt', pageSize: 1 }));
    expect(page.continuationToken).toEqual(expect.any(String));
    const pageBefore = calls.length;
    await executeParsed(registry, 'read_file_page_continue', { continuationToken: page.continuationToken as string });
    expect(calls.length).toBeGreaterThan(pageBefore);

    const observation = record(await executeParsed(registry, 'vision_annotated_capture', { workspaceId, capture: 'display' }));
    expect(observation.observationId).toEqual(expect.any(String));
    expect(observation.observationHash).toEqual(expect.any(String));
    const actionBefore = calls.length;
    await executeParsed(registry, 'ui_target_action', {
      workspaceId,
      observationId: observation.observationId as string,
      observationHash: observation.observationHash as string,
      markId: 'm1',
      action: 'click',
      userConfirmed: true,
    });
    expect(calls.length).toBeGreaterThan(actionBefore);
    expect(calls).toContain('capabilities.accessibility');
  });

  it('keeps the exhaustive success matrix aligned with all 93 core tools', () => {
    const registry = coreRegistry();
    const generic = Object.keys(CORE_TOOL_SMOKE_INPUTS).filter((name) => !STATEFUL_CORE_SUCCESS_TOOLS.has(name));
    expect([...generic, ...STATEFUL_CORE_SUCCESS_TOOLS].sort()).toEqual(coreToolNames(registry));
  });
});
