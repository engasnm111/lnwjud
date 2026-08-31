import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ok } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';
import { ToolRegistry } from './tool-registry.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor: FileActor = { clientId: 'test', clientName: 'test' };
const fullBypassAuthorization = {
  mode: 'full_bypass',
  applicationApproved: true,
  bypassApplicationAuthorization: true,
  source: 'full_bypass',
} as const;

describe('upgrade runtime', () => {
  it('has deterministic coverage for the roadmap tool catalog', () => {
    expect(UPGRADE_TOOL_CATALOG.length).toBeGreaterThan(100);
    expect(new Set(UPGRADE_TOOL_CATALOG.map((entry) => entry.name)).size).toBe(UPGRADE_TOOL_CATALOG.length);
    expect(UPGRADE_TOOL_CATALOG.some((entry) => entry.name === 'dev_context')).toBe(true);
    expect(UPGRADE_TOOL_CATALOG.some((entry) => entry.name === 'handoff_context')).toBe(true);
    expect(UPGRADE_TOOL_CATALOG.some((entry) => entry.name === 'context_economy_stats')).toBe(true);
  });

  // The registry smoke invokes the complete phase catalog through every normal
  // boundary. Keep enough headroom for slower Windows/CI runners while still
  // failing a genuinely stuck registry invocation.
  it('smoke-invokes every phase tool through the normal registry boundary', async () => {
    const registry = new ToolRegistry({}, actor);
    for (const entry of UPGRADE_TOOL_CATALOG) {
      const response = await registry.invoke(entry.name, {});
      expect(response).toBeDefined();
      expect(response.structuredContent).toBeDefined();
    }
  }, 60_000);

  it('routes prompts and searches capabilities without an LLM', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const route = await runtime.execute('route_intent', { prompt: 'Live Logs MCP activity ไม่ขึ้น' });
    expect(route).toMatchObject({ ok: true, value: { route: 'debug', domain: 'desktop/mcp/logging' } });
    const search = await runtime.execute('tool_search', { query: 'postgres schema inspection' });
    expect(search.ok).toBe(true);
    if (search.ok) expect(search.value).toHaveProperty('matches');
  });

  it('ranks primitive and upgrade tools with deterministic reasons without granting authorization', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const search = await runtime.execute('tool_dynamic_filter', { query: 'run a Linux WSL developer command', limit: 20, reranker: 'local' });

    expect(search).toMatchObject({ ok: true, value: {
      selectedModel: 'deterministic',
      fallbackReason: 'local_model_not_configured',
      primitiveToolsRemainAvailable: true,
      authorizationUnchanged: true,
      rankedCandidates: expect.arrayContaining([
        expect.objectContaining({ name: 'wsl_exec', permission: 'EXECUTE', reasonCodes: expect.any(Array) }),
      ]),
    } });
    if (search.ok) expect(search.value.rankedCandidates[0]?.name).toBe('wsl_exec');
  });

  it('ranks guarded exact file editing ahead of shell for source repairs', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const search = await runtime.execute('tool_function_find', {
      prompt: 'replace exact text in a TypeScript source file without a shell script',
      limit: 10,
    });

    expect(search).toMatchObject({ ok: true, value: { rankedCandidates: expect.any(Array) } });
    if (search.ok) {
      const names = search.value.rankedCandidates.map((candidate) => candidate.name);
      expect(names[0]).toBe('edit_file');
      const shellIndex = names.indexOf('shell');
      if (shellIndex >= 0) expect(names.indexOf('edit_file')).toBeLessThan(shellIndex);
    }
  });

  it('advertises guarded file editing as the preferred alternative to shell rewriting', () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool.description]));
    expect(byName.get('edit_file')).toContain('First choice');
    expect(byName.get('edit_file')).toContain('instead of shell');
    expect(byName.get('shell')).toContain('Never use shell as a source/config/text editor');
    expect(byName.get('shell')).toContain('call edit_file first');
    expect(byName.get('shell')).toContain('rejected before native approval');
  });

  it('returns route reason codes and a measurable deterministic model selection', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const route = await runtime.execute('route_intent', { prompt: 'debug the WSL task timeout and inspect live logs' });

    expect(route).toMatchObject({ ok: true, value: {
      route: 'debug',
      selectedModel: 'deterministic',
      reasonCodes: expect.arrayContaining(['keyword:debug', 'keyword:wsl']),
      authorizationUnchanged: true,
    } });
  });

  it('keeps context reads unrestricted while asking for dangerous actions', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const read = await runtime.execute('permission_check', { action: 'filesystem.read' });
    const remove = await runtime.execute('permission_check', { action: 'filesystem.delete' });
    expect(read).toMatchObject({ ok: true, value: { decision: 'allow', contextAccess: 'unrestricted' } });
    expect(remove).toMatchObject({ ok: true, value: { decision: 'ask', contextAccess: 'unrestricted' } });
  });

  it('keeps hooks create-only and plugin operations disabled without a real injected registry', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);

    await expect(runtime.execute('hook_register', { name: 'audit', event: 'beforeTool' }))
      .resolves.toMatchObject({ ok: true, value: { registered: true } });
    await expect(runtime.execute('hook_register', { name: 'audit', event: 'afterTool' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-plugin-registry-'));
    try {
      const runtimeStatePath = path.join(directory, 'runtime.json');
      for (const candidate of [runtime, new UpgradeRuntimeService({ runtimeStatePath }, actor)]) {
        for (const [name, input] of [
          ['plugin_install', { name: 'safe-plugin' }],
          ['plugin_list', {}],
          ['plugin_enable', { name: 'safe-plugin' }],
          ['plugin_disable', { name: 'safe-plugin' }],
          ['plugin_remove', { name: 'safe-plugin', userConfirmed: true }],
        ] as const) {
          await expect(candidate.execute(name, input)).resolves.toMatchObject({
            ok: true,
            value: {
              tool: name,
              status: 'disabled',
              available: false,
              ready: false,
              executed: false,
              requirements: ['validated injected plugin registry'],
            },
          });
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shares context economy telemetry between workspace context and the stats tool', async () => {
    const registry = new ToolRegistry({
      workspaceInfo: { async list(): Promise<ReturnType<typeof ok>> { return ok([{ id: 'workspace-1' }]); } },
      search: {
        async searchText(): Promise<ReturnType<typeof ok>> { return ok({ matches: [{ path: 'src/app.ts', line: 1, text: 'login' }], truncated: false }); },
        async searchFiles(): Promise<ReturnType<typeof ok>> { return ok({ paths: ['src/app.ts'], truncated: false }); },
      },
      file: { async readFile(): Promise<ReturnType<typeof ok>> { return ok({ path: 'src/app.ts', content: 'export function login() {}\n', startLine: 1, endLine: 1, encoding: 'utf8' as const, byteLength: 28 }); } },
      git: { async status(): Promise<ReturnType<typeof ok>> { return ok({ entries: [] }); } },
    }, actor);

    const context = await registry.invoke('workspace_context', { query: 'login', workspaceId: 'workspace-1' });
    expect(context.isError).not.toBe(true);
    const stats = await registry.invoke('context_economy_stats', {});
    expect(stats.isError).not.toBe(true);
    expect(stats).toMatchObject({ structuredContent: { filesDiscovered: 1, filesDelivered: 1 } });
  });

  it('persists redacted session state and reports task execution unavailable truthfully', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-'));
    const statePath = path.join(directory, 'runtime.json');
    const first = new UpgradeRuntimeService({ runtimeStatePath: statePath }, actor);
    await first.execute('session_checkpoint', { summary: 'inspect logs', token: 'must-not-be-retained' });
    const second = new UpgradeRuntimeService({ runtimeStatePath: statePath }, actor);
    const resumed = await second.execute('session_context', {});
    expect(resumed).toMatchObject({ ok: true, value: { checkpoints: [{ summary: 'inspect logs' }] } });
    const task = await second.execute('task_create', { instruction: 'run tests' });
    expect(task).toMatchObject({
      ok: true,
      value: {
        tool: 'task_create', status: 'disabled', available: false, ready: false, executed: false,
        requirements: ['managed task execution adapter'],
      },
    });
  });

  it('keeps Git worktree spawning path-scoped and dry-run first', async () => {
    const calls: unknown[] = [];
    const runtime = new UpgradeRuntimeService({
      git: {
        async run(_actor, request): Promise<ReturnType<typeof ok>> {
          calls.push(request);
          return ok({ exitCode: 0, stdout: 'worktree ready', stderr: '' });
        },
      },
    }, actor);

    await expect(runtime.execute('git_worktree_spawn', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', ref: 'main' })).resolves.toMatchObject({ ok: true, value: { dryRun: true, sideEffectsStarted: false } });
    await expect(runtime.execute('git_worktree_spawn', { workspaceId: 'ws-1', worktreePath: '..\\outside', ref: 'main', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(runtime.execute('git_worktree_spawn', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', ref: 'main', dryRun: false })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(runtime.execute('git_worktree_spawn', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', ref: 'main', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { status: 'completed', sideEffectsStarted: true } });
    expect(calls).toEqual([{ workspaceId: 'ws-1', args: ['worktree', 'add', '--detach', '.worktrees/agent-1', 'main'] }]);

    await expect(runtime.execute('git_worktree_remove', { workspaceId: 'ws-1', worktreePath: '.worktrees/unknown' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    await expect(runtime.execute('git_worktree_remove', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1' })).resolves.toMatchObject({ ok: true, value: { dryRun: true } });
    await expect(runtime.execute('git_worktree_remove', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', dryRun: false })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(runtime.execute('git_worktree_remove', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(calls.at(-1)).toMatchObject({ args: ['worktree', 'remove', '.worktrees/agent-1'] });
    await expect(runtime.execute('git_worktree_remove', { workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });

    await expect(runtime.execute('git_worktree_spawn', {
      workspaceId: 'ws-1', worktreePath: 'E:\\outside\\agent-1', ref: 'main', dryRun: false,
    }, undefined, fullBypassAuthorization)).resolves.toMatchObject({ ok: true, value: { status: 'completed', worktreePath: 'E:/outside/agent-1' } });
    expect(calls.at(-1)).toMatchObject({ args: ['worktree', 'add', '--detach', 'E:/outside/agent-1', 'main'] });
  });

  it('uses trusted Full Bypass for inner always-confirm upgrade mutations', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    await runtime.execute('hook_register', { name: 'audit', event: 'beforeTool' });

    await expect(runtime.execute('hook_remove', { name: 'audit' }, undefined, fullBypassAuthorization))
      .resolves.toMatchObject({ ok: true, value: { removed: true } });
    await expect(runtime.execute('permission_check', { action: 'filesystem.delete' }, undefined, fullBypassAuthorization))
      .resolves.toMatchObject({ ok: true, value: { decision: 'allow', standardDecision: 'ask', authorizationMode: 'full_bypass' } });
    await expect(runtime.execute('permission_profile', {}, undefined, fullBypassAuthorization))
      .resolves.toMatchObject({ ok: true, value: { dangerousActions: 'application-approval-bypassed', hardBlocksRemain: false, operatingSystemAndRemotePolicyRemain: true } });
  });

  it('routes PowerPoint and Outlook upgrade tools into the Office capability', async () => {
    const calls: Record<string, unknown>[] = [];
    const runtime = new UpgradeRuntimeService({
      capabilities: {
        async execute(tool: string, request: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
          expect(tool).toBe('office');
          calls.push(request);
          return ok({ app: request.app, action: request.action, ok: true });
        },
      },
      file: {
        async prepareExternalFileMutation(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          return ok({
            sourcePaths: [...(request.sourcePaths ?? [])],
            targetPath: request.targetPath,
            targetRelativePath: 'copy.pptx',
            replacementBackup: { recoveryId: 'backup-1', recoveryPath: 'C:\\recovery\\backup-1\\payload' },
          });
        },
      } as McpApplicationServices['file'],
    }, actor);

    await expect(runtime.execute('office_ppt', { action: 'read', file_path: 'C:\\work\\deck.pptx' })).resolves.toMatchObject({
      ok: true, value: { executed: true, action: 'read' },
    });
    await expect(runtime.execute('office_ppt', { action: 'save_as', file_path: 'C:\\work\\deck.pptx', target_path: 'C:\\work\\copy.pptx' })).resolves.toMatchObject({
      ok: true, value: { dryRun: true, executed: false },
    });
    await expect(runtime.execute('office_ppt', {
      workspaceId: 'ws-1', action: 'save_as', file_path: 'C:\\work\\deck.pptx', target_path: 'C:\\work\\copy.pptx', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({
      ok: true,
      value: { dryRun: false, executed: true, replacementBackup: { recoveryId: 'backup-1' } },
    });
    await expect(runtime.execute('office_outlook', { action: 'list_messages', folder: '\\Mailbox\\Inbox', max_messages: 250 })).resolves.toMatchObject({
      ok: true, value: { available: true, action: 'list_messages' },
    });
    expect(calls).toEqual([
      { app: 'powerpoint', action: 'read', file_path: 'C:\\work\\deck.pptx' },
      { app: 'powerpoint', action: 'save_as', file_path: 'C:\\work\\deck.pptx', target_path: 'C:\\work\\copy.pptx', userConfirmed: true },
      { app: 'outlook', action: 'list_messages', folder: '\\Mailbox\\Inbox', max_messages: 100 },
    ]);
  });

  it('keeps the 50-prompt routing golden set in the top-20 with a local p95 budget', async () => {
    const templates = [
      ['run a Linux WSL developer command', 'wsl_exec'],
      ['capture a numbered native UI observation', 'vision_annotated_capture'],
      ['control a native desktop app with mouse and keyboard', 'computer_use'],
      ['read Thai and English text with offline OCR', 'vision'],
      ['detonate an artifact offline in Windows Sandbox', 'sandbox_exec'],
      ['watch an allowlisted ETW event provider', 'event_watch'],
      ['show TypeScript compiler diagnostics from LSP', 'lsp_diagnostics'],
      ['rename a symbol with a cross-file LSP edit plan', 'lsp_rename'],
      ['attach to an owned DAP debug adapter', 'debug_attach'],
      ['step the debugger and inspect locals', 'debug_step'],
      ['spawn an isolated Git worktree', 'git_worktree_spawn'],
      ['inspect the local database schema', 'db_inspect'],
      ['run a bounded local SQL database query', 'db_query'],
      ['create a PowerPoint slide through Office', 'office_ppt'],
      ['draft an Outlook message through Office', 'office_outlook'],
      ['extract tables from a PDF', 'pdf_extract_tables'],
      ['merge DOCX documents after approval', 'docx_merge'],
      ['plan a safe reversible self-healing fix', 'self_heal_plan'],
      ['import a compatible local agent skill', 'skills_import'],
      ['plan an owned parallel agent swarm', 'agent_swarm_run'],
      ['discover connected MCP servers in the hub', 'mcp_hub'],
      ['run a bounded shell process', 'shell'],
      ['act on a revalidated marked UI control', 'ui_target_action'],
      ['translate a registered Windows path to WSL', 'wsl_fs'],
      ['inspect context economy telemetry', 'context_economy_stats'],
      ['discover project tests', 'discover_tests'],
    ] as const;
    const golden = Array.from({ length: 50 }, (_, index) => ({ query: `${templates[index % templates.length]![0]} ${index}`, target: templates[index % templates.length]![1] }));
    const runtime = new UpgradeRuntimeService({}, actor);
    const latencies: number[] = [];
    for (const prompt of golden) {
      const started = performance.now();
      const result = await runtime.execute('tool_dynamic_filter', { query: prompt.query, limit: 20 });
      latencies.push(performance.now() - started);
      expect(result).toMatchObject({ ok: true, value: { rankedCandidates: expect.any(Array), primitiveToolsRemainAvailable: true } });
      if (result.ok) expect(result.value.rankedCandidates.map((candidate) => candidate.name)).toContain(prompt.target);
    }
    const sorted = [...latencies].sort((left, right) => left - right);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(50);
  });

describe('self-healing (Wave 8)', () => {
  it('plans safe reversible fixes from live evidence', async () => {
    const staleStart = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    const runtime = new UpgradeRuntimeService({
      workspaceIndex: {
        async status(): Promise<ReturnType<typeof ok>> { return ok({ indexed: false, snapshot: null }); },
        async indexWorkspace(): Promise<ReturnType<typeof ok>> { return ok({ entries: [] }); },
      },
      capabilities: {
        async execute(_tool: string, request: { operation?: string }): Promise<ReturnType<typeof ok>> {
          if (request.operation === 'list') {
            return ok({ tasks: [
              { task_id: 'stale-1', state: 'running', durable: true, started_at: staleStart },
              { task_id: 'fresh-1', state: 'running', durable: true, started_at: new Date().toISOString() },
              { task_id: 'done-1', state: 'completed', durable: true, started_at: staleStart },
            ] });
          }
          expect(request.operation).toBe('cancel');
          return ok({ task_id: request.task_id, state: 'cancelled' });
        },
      },
    }, actor);

    const plan = await runtime.execute('self_heal_plan', { workspaceId: 'ws-1' });
    expect(plan).toMatchObject({ ok: true, value: {
      tool: 'self_heal_plan', applied: false, planId: expect.any(String), mutationRequired: true, automaticDestructiveRetry: false,
      evidence: { index: { indexed: false }, durableTasks: { staleOlderThan24h: 1 } },
      safeReversibleFixes: [
        expect.objectContaining({ id: 'reindex-workspace', kind: 'reindex_workspace', requiresConfirmation: false }),
        expect.objectContaining({ id: 'cancel-stale-task-stale-1', kind: 'cancel_stale_task', requiresConfirmation: true }),
      ],
    } });

    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: { dryRun: true, applied: [] } });
    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1', dryRun: false })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1', dryRun: false, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    if (!plan.ok) throw new Error('plan should be available');
    const planId = String((plan.value as { planId: string }).planId);
    const applied = await runtime.execute('self_heal_apply', { workspaceId: 'ws-1', planId, dryRun: false, userConfirmed: true, fixIds: ['cancel-stale-task-stale-1'] });
    expect(applied).toMatchObject({ ok: true, value: {
      dryRun: false, automaticDestructiveRetry: false,
      applied: [expect.objectContaining({ id: 'cancel-stale-task-stale-1', ok: true })],
    } });
  });

  it('reports an empty plan when everything is healthy', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    const plan = await runtime.execute('self_heal_plan', {});
    expect(plan).toMatchObject({ ok: true, value: { safeReversibleFixes: [], mutationRequired: false } });
  });
});
});
