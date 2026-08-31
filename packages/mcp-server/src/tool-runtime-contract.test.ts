import { describe, expect, it } from 'vitest';
import { err, type Result } from '@lnwjud/domain';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';
import { ToolRegistry } from './tool-registry.js';
import {
  PHASE_5_TO_18_TOOL_RUNTIME_FIXTURES,
  PHASE_19_TO_33_TOOL_RUNTIME_FIXTURES,
  PHASE_34_TO_46_TOOL_RUNTIME_FIXTURES,
  TOOL_RUNTIME_FIXTURES,
  type ToolRuntimeFixture,
} from './tool-runtime-fixtures.js';
import type { McpApplicationServices } from './tools/tool-types.js';
import { createRuntimeSuccessServices as successServices, runtimeRecord as record } from './tool-runtime-test-harness.js';

const actor = { clientId: 'runtime-contract-test', clientName: 'runtime-contract-test' };

const PHASE_5_TO_18_TOOL_NAMES = UPGRADE_TOOL_CATALOG
  .filter((entry) => entry.phase >= 5 && entry.phase <= 18)
  .map((entry) => entry.name)
  .sort();

const PHASE_19_TO_33_TOOL_NAMES = UPGRADE_TOOL_CATALOG
  .filter((entry) => entry.phase >= 19 && entry.phase <= 33)
  .map((entry) => entry.name)
  .sort();

const PHASE_34_TO_46_TOOL_NAMES = UPGRADE_TOOL_CATALOG
  .filter((entry) => entry.phase >= 34 && entry.phase <= 46)
  .map((entry) => entry.name)
  .sort();

const COMPOUND_CONTEXT_TOOL_NAMES = [
  'debug_context', 'review_context', 'change_context', 'symbol_context',
  'test_context', 'git_context', 'frontend_context', 'backend_context',
] as const;

async function executeDefinition(
  registry: ToolRegistry,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<Result<unknown>> {
  const tool = registry.listAll().find((candidate) => candidate.name === name);
  expect(tool, `missing ${name}`).toBeDefined();
  if (tool === undefined) throw new Error(`missing ${name}`);
  const parsed = tool.parse(input);
  expect(parsed, `${name} representative input`).toMatchObject({ ok: true });
  if (!parsed.ok) throw new Error(`${name} representative input did not parse`);
  return tool.execute(parsed.value, new AbortController().signal);
}

async function preparedInput(
  registry: ToolRegistry,
  name: string,
  fixture: ToolRuntimeFixture,
): Promise<Readonly<Record<string, unknown>>> {
  switch (fixture.prepare) {
    case 'workspace_context': {
      const result = await executeDefinition(registry, 'workspace_context', { workspaceId: 'workspace-1', query: 'smoke', pageSize: 1 });
      if (!result.ok) throw new Error(result.error.message);
      return { continuationToken: record(result.value).continuationToken };
    }
    case 'workspace_full_scan': {
      const result = await executeDefinition(registry, 'workspace_full_scan', { workspaceId: 'workspace-1', pageSize: 1 });
      if (!result.ok) throw new Error(result.error.message);
      return { continuationToken: record(result.value).continuationToken };
    }
    case 'read_file_page': {
      const result = await executeDefinition(registry, 'read_file_page', { workspaceId: 'workspace-1', path: 'paged.txt', pageSize: 1 });
      if (!result.ok) throw new Error(result.error.message);
      return { continuationToken: record(result.value).continuationToken };
    }
    case 'vision_annotated_capture': {
      const result = await executeDefinition(registry, 'vision_annotated_capture', { workspaceId: 'workspace-1', capture: 'display' });
      if (!result.ok) throw new Error(result.error.message);
      const observation = record(result.value);
      return { workspaceId: 'workspace-1', observationId: observation.observationId, observationHash: observation.observationHash, markId: 'm1', action: 'click', userConfirmed: true };
    }
    case 'hook_register':
      await executeDefinition(registry, 'hook_register', { name: 'runtime-contract', event: 'beforeTool' });
      return fixture.input;
    case 'session_checkpoint':
      await executeDefinition(registry, 'session_checkpoint', { summary: 'prepared checkpoint' });
      return fixture.input;
    case 'git_worktree_spawn': {
      const result = await executeDefinition(registry, 'git_worktree_spawn', {
        workspaceId: 'workspace-1', worktreePath: '.worktrees/runtime-contract', ref: 'HEAD', dryRun: false, userConfirmed: true,
      });
      if (!result.ok) throw new Error(result.error.message);
      return fixture.input;
    }
    case 'cache_seed':
      return fixture.input;
    case undefined:
      return fixture.input;
  }
}

async function cacheGeneration(registry: ToolRegistry): Promise<number> {
  const result = await executeDefinition(registry, 'cache_stats', {});
  if (!result.ok) throw new Error(result.error.message);
  const generation = record(result.value).generation;
  return typeof generation === 'number' ? generation : 0;
}

describe('tool runtime delivery contract', () => {
  it('tracks an exact runtime fixture for every first-party definition', () => {
    const registry = new ToolRegistry({}, actor);
    expect(PHASE_5_TO_18_TOOL_NAMES).toHaveLength(53);
    expect(PHASE_19_TO_33_TOOL_NAMES).toHaveLength(46);
    expect(PHASE_34_TO_46_TOOL_NAMES).toHaveLength(39);
    expect(Object.keys(PHASE_5_TO_18_TOOL_RUNTIME_FIXTURES).sort()).toEqual(PHASE_5_TO_18_TOOL_NAMES);
    expect(Object.keys(PHASE_19_TO_33_TOOL_RUNTIME_FIXTURES).sort()).toEqual(PHASE_19_TO_33_TOOL_NAMES);
    expect(Object.keys(PHASE_34_TO_46_TOOL_RUNTIME_FIXTURES).sort()).toEqual(PHASE_34_TO_46_TOOL_NAMES);
    expect(Object.keys(TOOL_RUNTIME_FIXTURES).sort()).toEqual(registry.listAll().map((definition) => definition.name).sort());
    expect(Object.keys(TOOL_RUNTIME_FIXTURES)).toHaveLength(registry.listAll().length);
  });

  it('keeps complete inventory separate from currently advertised tools', () => {
    const registry = new ToolRegistry({}, actor);
    const allNames = registry.listAll().map((tool) => tool.name);
    const advertisedNames = registry.list().map((tool) => tool.name);

    expect(allNames).toEqual(expect.arrayContaining([
      'codex_status', 'codex_run', 'codex_task_list', 'codex_task_status', 'codex_task_logs', 'codex_stop',
      'agent_swarm_run', 'plugin_install', 'plugin_list', 'plugin_enable', 'plugin_disable', 'plugin_remove',
    ]));
    expect(advertisedNames).not.toContain('codex_status');
    expect(advertisedNames).not.toContain('agent_swarm_run');
    for (const pluginName of ['plugin_install', 'plugin_list', 'plugin_enable', 'plugin_disable', 'plugin_remove']) {
      expect(advertisedNames).not.toContain(pluginName);
    }
  });

  it('assigns an explicit delivery state to every upgrade definition', () => {
    expect(UPGRADE_TOOL_CATALOG.every((entry) => (
      entry.deliveryState === 'operational'
      || entry.deliveryState === 'dependency_gated'
      || entry.deliveryState === 'feature_disabled'
      || entry.deliveryState === 'planned'
    ))).toBe(true);
  });

  it('keeps plugin operations disabled until a real validated plugin registry is injected', () => {
    const pluginEntries = UPGRADE_TOOL_CATALOG.filter((entry) => entry.phase === 16);
    expect(pluginEntries).toHaveLength(5);
    expect(pluginEntries.every((entry) => entry.deliveryState === 'feature_disabled')).toBe(true);
    expect(pluginEntries.every((entry) => entry.requirements?.includes('validated injected plugin registry') === true)).toBe(true);
  });

  it.each(COMPOUND_CONTEXT_TOOL_NAMES)('%s reports each missing backing service truthfully', async (name) => {
    for (const [missingService, requirement] of [
      ['search', 'workspace search service'],
      ['file', 'workspace file service'],
      ['git', 'configured Git service'],
    ] as const) {
      const calls: string[] = [];
      const services = { ...successServices(calls), [missingService]: undefined } as McpApplicationServices;
      const registry = new ToolRegistry(services, actor, { codexToolsEnabled: true });
      const result = await executeDefinition(registry, name, { workspaceId: 'workspace-1', query: 'smoke' });
      expect(result, `${name} without ${missingService}`).toMatchObject({
        ok: true,
        value: {
          tool: name,
          status: 'needs_setup',
          available: false,
          ready: false,
          executed: false,
          requirements: [requirement],
        },
      });
    }

    const allMissing = await executeDefinition(
      new ToolRegistry({}, actor, { codexToolsEnabled: true }),
      name,
      { workspaceId: 'workspace-1', query: 'smoke' },
    );
    expect(allMissing).toMatchObject({
      ok: true,
      value: {
        requirements: ['workspace search service', 'workspace file service', 'configured Git service'],
      },
    });
  });

  it('propagates compound-context service failures instead of embedding them in success', async () => {
    const calls: string[] = [];
    const serviceFailure = { code: 'INTERNAL_ERROR' as const, message: 'runtime contract service failure', recoverable: true };
    const failingSearch = {
      async searchText() { calls.push('search.searchText'); return err(serviceFailure); },
      async searchFiles() { calls.push('search.searchFiles'); return err(serviceFailure); },
    } as unknown as NonNullable<McpApplicationServices['search']>;
    const searchRegistry = new ToolRegistry({ ...successServices(calls), search: failingSearch }, actor, { codexToolsEnabled: true });
    await expect(executeDefinition(searchRegistry, 'debug_context', { workspaceId: 'workspace-1', query: 'smoke' }))
      .resolves.toMatchObject({ ok: false, error: serviceFailure });

    const failingGit = {
      async status() { calls.push('git.status'); return err(serviceFailure); },
    } as unknown as NonNullable<McpApplicationServices['git']>;
    const gitRegistry = new ToolRegistry({ ...successServices(calls), git: failingGit }, actor, { codexToolsEnabled: true });
    await expect(executeDefinition(gitRegistry, 'debug_context', { workspaceId: 'workspace-1', query: 'smoke' }))
      .resolves.toMatchObject({ ok: false, error: serviceFailure });
  });

  it.each(Object.entries(TOOL_RUNTIME_FIXTURES))('%s produces its declared runtime evidence', async (name, fixture) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(successServices(calls), actor, { codexToolsEnabled: true });
    const input = await preparedInput(registry, name, fixture);
    const generationBefore = fixture.prepare === 'cache_seed' ? await cacheGeneration(registry) : undefined;
    const callsBefore = calls.length;
    const result = await executeDefinition(registry, name, input);

    expect(result, `${name} runtime result`).toMatchObject({ ok: true });
    if (!result.ok) return;

    if (fixture.evidence.kind === 'service_dispatch') {
      expect(calls.slice(callsBefore), `${name} returned success without ${fixture.evidence.serviceCall}`).toContain(fixture.evidence.serviceCall);
      return;
    }

    const output = record(result.value);
    if (fixture.evidence.kind === 'truthful_unavailable') {
      expect(output).toMatchObject({
        status: fixture.evidence.unavailableStatus,
        available: false,
        ready: false,
        executed: false,
        requirements: expect.any(Array),
      });
      expect(output.requirements).not.toHaveLength(0);
      expect(calls).toHaveLength(callsBefore);
      return;
    }

    const oracle = fixture.oracle;
    expect(oracle, `${name} deterministic fixture lacks an output/state oracle`).toBeDefined();
    if (oracle === undefined) return;
    expect(output, `${name} did not produce its tool-specific deterministic output`).toMatchObject(oracle.expected);
    for (const key of oracle.requiredKeys ?? []) expect(output, `${name} omitted ${key}`).toHaveProperty(key);
    expect(calls, `${name} deterministic operation dispatched a backing service`).toHaveLength(callsBefore);

    if (oracle.alternate !== undefined) {
      const alternate = await executeDefinition(registry, name, oracle.alternate.input);
      expect(alternate).toMatchObject({ ok: true });
      if (alternate.ok) expect(record(alternate.value)).toMatchObject(oracle.alternate.expected);
    }

    if (oracle.state === 'cache_generation') {
      expect(generationBefore).toBeTypeOf('number');
      expect(await cacheGeneration(registry)).toBeGreaterThan(generationBefore ?? -1);
    }
    if (oracle.state === 'hook_registered' || oracle.state === 'hook_removed') {
      const listed = await executeDefinition(registry, 'hook_list', {});
      expect(listed).toMatchObject({ ok: true });
      const hooks = listed.ok && Array.isArray(record(listed.value).hooks) ? record(listed.value).hooks : [];
      if (oracle.state === 'hook_registered') expect(hooks).toEqual(expect.arrayContaining([{ name: 'runtime-contract', event: 'beforeTool' }]));
      else expect(hooks).not.toEqual(expect.arrayContaining([{ name: 'runtime-contract', event: 'beforeTool' }]));
    }
    if (oracle.state === 'session_checkpoint') {
      const history = await executeDefinition(registry, 'session_history', {});
      expect(history).toMatchObject({ ok: true });
      const checkpoints = history.ok && Array.isArray(record(history.value).checkpoints) ? record(history.value).checkpoints : [];
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints.every((checkpoint) => (
        typeof checkpoint === 'object' && checkpoint !== null
        && typeof record(checkpoint).id === 'string'
        && typeof record(checkpoint).summary === 'string'
      ))).toBe(true);
    }
  }, 20_000);

  it.each(Object.entries(PHASE_5_TO_18_TOOL_RUNTIME_FIXTURES).filter(([, fixture]) => fixture.evidence.kind === 'service_dispatch'))(
    '%s reports needs_setup instead of successful placeholder data when its service is absent',
    async (name, fixture) => {
      const registry = new ToolRegistry({}, actor, { codexToolsEnabled: true });
      const result = await executeDefinition(registry, name, fixture.input);
      expect(result).toMatchObject({
        ok: true,
        value: {
          tool: name,
          status: 'needs_setup',
          available: false,
          ready: false,
          executed: false,
          requirements: expect.any(Array),
        },
      });
      if (result.ok) expect(record(result.value).requirements).not.toHaveLength(0);
    },
  );
});
