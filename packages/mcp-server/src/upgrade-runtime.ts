import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { capabilityDescriptors, EventLogCapabilityBackend, type CapabilityDescriptor } from '@lnwjud/capabilities';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEngine } from './context-engine.js';
import { ContextEconomyRuntime } from './context-economy.js';
import { DatabaseRuntimeService } from './database-runtime.js';
import { DocumentRuntimeService } from './document-runtime.js';
import { LspRuntimeService } from './lsp-runtime.js';
import { withReplacementRecoveryDetails } from './replacement-recovery.js';
import { withCapabilityOwnerMetadata } from './request-scope.js';
import { SandboxRuntimeService } from './sandbox-runtime.js';
import { truthfulUnavailable } from './tool-delivery-contract.js';
import { UPGRADE_TOOL_CATALOG, type UpgradeToolCatalogEntry } from './upgrade-catalog.js';
import { UpgradeRuntimeStateStore, type UpgradeRuntimeSessionState, type UpgradeRuntimeSharedState } from './upgrade-runtime-state-store.js';

interface RuntimeTask {
  readonly id: string;
  readonly kind: 'task' | 'delegate';
  readonly createdAt: string;
  readonly inputDigest: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled';
  result?: unknown;
}

interface SessionCheckpoint {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly inputDigest: string;
}

interface CacheCounters {
  hits: number;
  misses: number;
  bytesSaved: number;
  generation: number;
}

interface SearchCatalogEntry extends UpgradeToolCatalogEntry {
  readonly primitive?: boolean;
  readonly auditTarget?: string;
}

interface RankedToolCandidate {
  readonly name: string;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly permission: UpgradeToolCatalogEntry['permission'];
  readonly permissionMetadata: {
    readonly permission: UpgradeToolCatalogEntry['permission'];
    readonly authorization: 'not_granted_by_ranking';
    readonly destructiveHint: boolean;
  };
  readonly source: 'primitive' | 'upgrade';
  readonly tags: readonly string[];
  readonly phase: number;
}

interface WorktreeLedgerEntry {
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly ref: string;
  readonly owner: string;
  readonly ownerSessionId?: string;
  readonly createdAt: string;
}

interface SelfHealFix {
  readonly id: string;
  readonly kind: 'reindex_workspace' | 'cancel_stale_task';
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly description: string;
  readonly reversible: boolean;
  readonly requiresConfirmation: boolean;
}

const PRIMITIVE_SEARCH_ENTRIES: readonly SearchCatalogEntry[] = [
  primitiveEntry('workspace_list', 'List registered workspaces.', 'READ', ['workspace', 'read']),
  primitiveEntry('workspace_tree', 'Read a bounded registered workspace tree.', 'READ', ['workspace', 'tree', 'read']),
  primitiveEntry('read_file', 'Read one guarded workspace file.', 'READ', ['workspace', 'file', 'read']),
  primitiveEntry('read_files', 'Read multiple guarded workspace files.', 'READ', ['workspace', 'file', 'read']),
  primitiveEntry('search_files', 'Search guarded workspace file paths.', 'READ', ['workspace', 'search', 'read']),
  primitiveEntry('search_text', 'Search guarded workspace text.', 'READ', ['workspace', 'search', 'read']),
  primitiveEntry('git', 'Run a guarded Git operation.', 'EXECUTE', ['git', 'execute']),
  primitiveEntry('write_file', 'Guarded text file creation or replacement with checkpoint protection; prefer over shell filesystem scripts.', 'WRITE', ['workspace', 'file', 'write', 'create', 'replace', 'text']),
  primitiveEntry('apply_patch', 'Apply a guarded workspace patch.', 'WRITE', ['workspace', 'file', 'write']),
  primitiveEntry('edit_file', 'First-choice exact guarded text replacement for narrow source and config repairs; use instead of shell editing scripts.', 'WRITE', ['workspace', 'file', 'write', 'edit', 'replace', 'source', 'config', 'text']),
  primitiveEntry('shell', 'Run builds, tests, package managers, and system operations; not a text editor when edit_file, apply_patch, or write_file can perform the change.', 'EXECUTE', ['shell', 'process', 'execute', 'build', 'test']),
  primitiveEntry('computer_use', 'Codex-style native Windows desktop control with semantic, visual-mark, pointer, and keyboard routing.', 'EXECUTE', ['computer', 'desktop', 'ui', 'mouse', 'keyboard', 'click', 'type', 'vision', 'execute']),
  primitiveEntry('vision', 'Capture local screen content or use the OCR boundary.', 'READ', ['vision', 'display', 'read']),
  primitiveEntry('vision_annotated_capture', 'Capture an expiring Set-of-Marks observation.', 'READ', ['vision', 'ui', 'read']),
  primitiveEntry('ui_target_action', 'Act on a revalidated visual mark.', 'EXECUTE', ['vision', 'ui', 'execute']),
  primitiveEntry('tool_batch', 'Invoke registered tools with bounded dependency groups.', 'EXECUTE', ['workflow', 'execute']),
];

const CAPABILITY_SEARCH_ENTRIES: readonly SearchCatalogEntry[] = capabilityDescriptors.map((descriptor) => capabilitySearchEntry(descriptor));
const SEARCH_CATALOG: readonly SearchCatalogEntry[] = dedupeSearchEntries([
  ...PRIMITIVE_SEARCH_ENTRIES,
  ...CAPABILITY_SEARCH_ENTRIES,
  ...UPGRADE_TOOL_CATALOG,
]);

export class UpgradeRuntimeService {
  private readonly contextEngine: ContextEngine;
  private readonly actor: FileActor;
  private readonly contextEconomy: ContextEconomyRuntime;
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly checkpoints: SessionCheckpoint[] = [];
  private readonly hooks = new Map<string, { readonly name: string; readonly event: string }>();
  private readonly plugins = new Map<string, { readonly name: string; enabled: boolean }>();
  private readonly cache: CacheCounters = { hits: 0, misses: 0, bytesSaved: 0, generation: 0 };
  private readonly session = new Map<string, unknown>();
  private readonly worktrees: WorktreeLedgerEntry[] = [];
  private readonly eventLog: EventLogCapabilityBackend;
  private readonly sandbox: SandboxRuntimeService;
  private readonly database: DatabaseRuntimeService;
  private readonly lsp: LspRuntimeService;
  private readonly documents: DocumentRuntimeService;
  private readonly stateStore: UpgradeRuntimeStateStore | undefined;
  private loaded = false;

  public constructor(
    private readonly services: McpApplicationServices,
    actor: FileActor,
    contextEconomy: ContextEconomyRuntime = new ContextEconomyRuntime(),
  ) {
    this.actor = actor;
    this.stateStore = services.runtimeStatePath === undefined
      ? undefined
      : new UpgradeRuntimeStateStore(path.resolve(services.runtimeStatePath), runtimeOwnerKey(actor));
    this.contextEconomy = contextEconomy;
    this.contextEngine = new ContextEngine(services, actor, contextEconomy);
    this.eventLog = new EventLogCapabilityBackend();
    this.sandbox = new SandboxRuntimeService(services, actor, services.sandboxRuntimeOptions);
    this.database = new DatabaseRuntimeService(services, actor);
    this.lsp = new LspRuntimeService(services, actor);
    this.documents = new DocumentRuntimeService(services, actor);
  }

  public async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    await this.loadState();
    switch (name) {
      case 'tool_search':
      case 'tool_function_find':
      case 'tool_dynamic_filter':
        return ok(this.searchTools(readString(input, 'query') ?? readString(input, 'prompt') ?? '', input));
      case 'tool_describe':
        return ok(this.describeTool(readString(input, 'name') ?? readString(input, 'tool')));
      case 'tool_categories':
        return ok(this.categories());
      case 'tool_aliases':
        return ok({ aliases: { read: 'read_file', edit: 'edit_file', search: 'search_text', tree: 'workspace_tree', logs: 'live_logs_query', tests: 'test_context', context: 'workspace_context', map: 'repo_map' }, primitiveToolsRemainAvailable: true });
      case 'capabilities':
        return ok({ categories: this.categories().categories, totalUpgradeTools: UPGRADE_TOOL_CATALOG.length, primitiveToolsRemainAvailable: true });
      case 'route_intent':
        return ok(routeIntent(readString(input, 'prompt') ?? readString(input, 'query') ?? ''));
      case 'recipe_list':
      case 'recipe_catalog':
        return ok({ recipes: recipeCatalog() });
      case 'recipe_describe':
        return ok(recipeCatalog().find((recipe) => recipe.name === (readString(input, 'name') ?? 'bugfix')) ?? recipeCatalog()[0]);
      case 'recipe_run':
        return ok({ ...planFor(readString(input, 'prompt') ?? readString(input, 'name') ?? 'bugfix'), dryRun: input.dryRun !== false, sideEffectsStarted: false });
      case 'dry_run':
        return ok({ ...planFor(readString(input, 'prompt') ?? readString(input, 'query') ?? ''), sideEffects: { writes: [], shell: [], gitMutations: [], network: [] }, sideEffectsStarted: false });
      case 'response_mode':
        return ok({ mode: normalizeMode(readString(input, 'mode')), omittedDetailsRemainFetchable: true, continuationSupported: true });
      case 'permission_check': {
        const standard = permissionDecision(readString(input, 'action') ?? readString(input, 'permission') ?? 'filesystem.read');
        return ok(isFullBypassAuthorization(authorization)
          ? { ...standard, decision: 'allow', standardDecision: standard.decision, authorizationMode: 'full_bypass', bypassApplicationAuthorization: true }
          : { ...standard, authorizationMode: 'standard', bypassApplicationAuthorization: false });
      }
      case 'permission_profile':
        return ok(isFullBypassAuthorization(authorization)
          ? { profile: 'full', authorizationMode: 'full_bypass', contextReads: 'application-scope-bypassed', dangerousActions: 'application-approval-bypassed', hardBlocksRemain: false, operatingSystemAndRemotePolicyRemain: true }
          : { profile: 'full', authorizationMode: 'standard', contextReads: 'unrestricted-for-allowed-workspaces', dangerousActions: 'policy-gated', hardBlocksRemain: true });
      case 'cache_stats':
        return ok({ ...this.cache, hitRate: hitRate(this.cache), entries: 0, invalidation: 'mtime/content-hash/filesystem-event', contextEconomy: this.contextEconomy.snapshot() });
      case 'cache_clear':
      case 'cache_invalidate': {
        const previousGeneration = this.cache.generation;
        this.cache.hits = 0;
        this.cache.misses = 0;
        this.cache.bytesSaved = 0;
        this.cache.generation += 1;
        return ok({
          cleared: true,
          scope: name === 'cache_clear' ? 'all' : readString(input, 'path') ?? 'workspace',
          previousGeneration,
          generation: this.cache.generation,
        });
      }
      case 'hook_list':
        return ok({ hooks: [...this.hooks.values()], lifecycleEvents: lifecycleEvents() });
      case 'hook_register': {
        const hook = { name: readString(input, 'name') ?? `hook-${this.hooks.size + 1}`, event: readString(input, 'event') ?? 'beforeTool' };
        if (this.hooks.has(hook.name)) {
          return err(appError('INVALID_INPUT', 'Lifecycle hook already exists; remove it explicitly before registering a replacement'));
        }
        this.hooks.set(hook.name, hook);
        return ok({ registered: true, hook });
      }
      case 'hook_remove': {
        if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'Removing a lifecycle hook requires explicit user confirmation'));
        const hookName = readString(input, 'name');
        return ok({ removed: hookName === undefined ? false : this.hooks.delete(hookName), name: hookName ?? null });
      }
      case 'skill_match':
      case 'skill_load':
        return this.skillInsight(name, input);
      case 'plugin_list':
        await this.refreshSharedState();
        return ok({
          tool: 'plugin_list', status: 'ready', available: true, ready: true, executed: true,
          plugins: [...this.plugins.values()].sort((left, right) => left.name.localeCompare(right.name)),
          persistence: this.stateStore === undefined ? 'memory_only' : 'shared_locked_state',
        });
      case 'plugin_install':
      case 'plugin_enable':
      case 'plugin_disable':
      case 'plugin_remove':
        return this.changePlugin(name, readString(input, 'name') ?? readString(input, 'plugin'), input, authorization);
      case 'session_context':
      case 'session_resume':
        return ok({ session: Object.fromEntries(this.session), checkpoints: this.checkpoints });
      case 'session_checkpoint': {
        const checkpoint: SessionCheckpoint = { id: randomUUID(), createdAt: new Date().toISOString(), summary: summarize(readString(input, 'summary') ?? readString(input, 'prompt') ?? ''), inputDigest: digest(input) };
        this.checkpoints.push(checkpoint);
        this.session.set('lastCheckpointId', checkpoint.id);
        const persisted = await this.persistState();
        if (!persisted) return err(appError('INTERNAL_ERROR', 'Session checkpoint could not be persisted', true));
        return ok(checkpoint);
      }
      case 'session_history':
        return ok({ checkpoints: this.checkpoints });
      case 'task_create':
      case 'task_status':
      case 'task_cancel':
      case 'task_result':
      case 'task_list':
        return this.managedTask(name, input, signal, authorization);
      case 'delegate':
      case 'delegate_status':
      case 'delegate_cancel':
      case 'delegate_result':
      case 'parallel_delegate':
        return this.agentDelegation(name, input, signal, authorization);
      case 'repo_map':
        return this.repositoryMap(readString(input, 'workspaceId'));
      case 'context_expand':
      case 'dependency_context':
        return this.contextExpansion(name, readString(input, 'workspaceId'), readString(input, 'path') ?? readString(input, 'symbol'));
      case 'symbol_search':
      case 'find_definition':
      case 'find_references':
      case 'find_implementations':
      case 'call_hierarchy':
      case 'import_graph':
      case 'dependency_graph':
      case 'module_graph':
      case 'type_search':
      case 'trace_symbol':
      case 'changed_symbols':
        return this.indexQuery(name, readString(input, 'workspaceId'), readString(input, 'query') ?? readString(input, 'symbol') ?? readString(input, 'path') ?? '');
      case 'workspace_index':
        return ok({});
      case 'live_logs_status':
        return this.liveLogsStatus();
      case 'live_logs_query':
        return this.liveLogsQuery(input);
      case 'telemetry_dashboard':
        return this.telemetryDashboard();
      case 'context_economy_stats':
        return ok({ ...this.contextEconomy.snapshot(), policy: { automaticDiscovery: 'filtered-and-progressive', explicitAccess: 'full-and-unrestricted-by-economy', ledger: 'bounded-in-memory' } });
      case 'execution_plan':
        return ok({ ...planFor(readString(input, 'prompt') ?? readString(input, 'query') ?? ''), reason: 'deterministic rule plan; telemetry can refine cost estimates' });
      case 'recovery_status':
        return ok({ reconnect: 'enabled-at-transport-boundary', safeReadRetry: true, destructiveRetry: false, staleContinuation: 'detected', indexRecovery: 'rebuildable', workerIsolation: true });
      case 'tool_schema_list':
        return ok({ schemas: this.listToolSchemas(), persistence: this.stateStore === undefined ? 'memory_only' : 'session_locked_state' });
      case 'tool_schema_register':
        return this.registerToolSchema(input);
      case 'mcp_discover':
      case 'mcp_health':
        return this.externalMcpInsight(name);
      case 'mcp_resources':
        return this.externalMcpResources(input);
      case 'mcp_hub':
        return this.externalMcpHub();
      case 'self_heal_plan':
        return this.selfHealPlan(input, authorization);
      case 'self_heal_apply':
        return this.selfHealApply(input, authorization);
      case 'git_worktree_spawn':
        return this.gitWorktreeSpawn(input, authorization);
      case 'event_watch':
      case 'crash_trace':
        return this.eventLogQuery(name, input, signal);
      case 'sandbox_exec':
        return this.sandbox.execute(input, signal, authorization);
      case 'db_inspect':
        if (readString(input, 'workspaceId') === undefined || (readString(input, 'target') ?? readString(input, 'path') ?? readString(input, 'database')) === undefined) {
          return ok(truthfulUnavailable(name, 'needs_setup', ['registered workspace', 'SQLite target file']));
        }
        return this.database.inspect(input);
      case 'db_query':
        if (readString(input, 'workspaceId') === undefined || (readString(input, 'target') ?? readString(input, 'path') ?? readString(input, 'database')) === undefined) {
          return ok(truthfulUnavailable(name, 'needs_setup', ['registered workspace', 'SQLite target file']));
        }
        return this.database.query(input);
      case 'lsp_diagnostics':
        return this.lsp.diagnostics(input);
      case 'lsp_rename':
        return this.lsp.renamePlan(input);
      case 'git_worktree_remove':
        return this.gitWorktreeRemove(input, authorization);
      case 'pdf_extract_tables':
        return this.documents.extractTables(input, signal, authorization);
      case 'inspect_pdf':
        return this.documents.inspectPdf(input, signal, authorization);
      case 'inspect_workbook':
        return this.documents.inspectWorkbook(input, authorization);
      case 'docx_merge':
        return this.documents.docxMerge(input, signal, authorization);
      case 'office_ppt':
        return this.officePowerPoint(input, signal, authorization);
      case 'office_outlook':
        return this.officeOutlook(input, authorization);
      case 'handoff_context':
        return this.compoundContext(name, input);
      case 'benchmark_run':
        return this.benchmarkRun(input, signal, authorization);
      case 'regression_report':
        return this.regressionReport(input);
      case 'project_profile_get':
      case 'project_profile_set':
        return this.projectProfile(name, input, signal, authorization);
      case 'compare_workbook_layout':
        return this.documents.compareWorkbookLayout(input, authorization);
      case 'render_excel_preview':
        return this.documents.renderWorkbookPreview(input, authorization);
      case 'compare_pdf_pages':
        return this.documents.comparePdfPages(input, signal, authorization);
      case 'debug_attach':
        return ok(truthfulUnavailable(name, 'needs_setup', ['running loopback DAP adapter', 'registered workspace']));
      case 'debug_step':
        return ok(truthfulUnavailable(name, 'needs_setup', ['owned debug session created by a configured DAP adapter']));
      case 'skills_import':
        return this.importSkill(input, signal, authorization);
      case 'agent_swarm_run':
        return ok(truthfulUnavailable(name, 'disabled', ['subagent provider', 'ownership ledger', 'mutation policy']));
      case 'debug_context':
      case 'review_context':
      case 'change_context':
      case 'symbol_context':
      case 'test_context':
      case 'git_context':
      case 'frontend_context':
      case 'backend_context':
        return this.compoundContext(name, input);
      case 'review_changes':
      case 'affected_modules':
      case 'git_history_context':
      case 'git_blame_context':
        return this.gitInsight(name, input, signal);
      case 'discover_tests':
      case 'test_failures':
      case 'coverage_context':
      case 'test_history':
        return this.testInsight(name, input, signal);
      case 'run_affected_tests':
        return this.runAffectedTests(input, signal, authorization);
      case 'inspect_web_app':
      case 'debug_ui':
      case 'capture_ui_state':
      case 'form_context':
      case 'network_context':
      case 'console_context':
      case 'browser_debug_context':
        return this.browserInsight(name, input, signal, authorization);
      case 'windows_environment':
      case 'service_context':
      case 'process_context':
      case 'port_context':
      case 'registry_context':
      case 'event_log_context':
      case 'installed_runtime_context':
      case 'path_context':
      case 'startup_context':
        return this.windowsInsight(name, input, signal, authorization);
      case 'capture_screenshot':
      case 'compare_screenshot':
      case 'dom_snapshot':
      case 'layout_metadata':
      case 'visual_context':
        return this.visualInsight(name, input, signal, authorization);
      case 'context_ranking':
        return ok({ signals: { exactSymbol: 100, exactFilename: 80, recentChange: 60, sameModule: 50, dependency: 40, test: 30, text: 20, proximity: 10 }, lowerRankedResultsRemainAvailable: true });
      case 'dev_context':
        return this.compoundContext(name, input);
      default:
        return ok(contractStatus(name, input));
    }
  }

  private searchTools(query: string, input: Record<string, unknown> = {}): Record<string, unknown> {
    const normalized = query.toLowerCase().trim();
    const limit = boundedInteger(input.limit ?? input.topK, 20, 1, 100);
    const requestedReranker = readString(input, 'reranker') ?? readString(input, 'model') ?? 'deterministic';
    const category = readString(input, 'category')?.toLowerCase();
    const route = routeIntent(query);
    const scored = SEARCH_CATALOG
      .filter((entry) => category === undefined || entry.tags.some((tag) => tag.toLowerCase() === category))
      .map((entry) => scoreToolEntry(entry, normalized, route))
      .filter((entry) => normalized.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score || Number(right.entry.primitive === true) - Number(left.entry.primitive === true) || left.entry.name.localeCompare(right.entry.name));
    const rankedCandidates: readonly RankedToolCandidate[] = scored.slice(0, limit).map((candidate) => ({
      name: candidate.entry.name,
      score: Number(candidate.score.toFixed(4)),
      reasonCodes: candidate.reasonCodes,
      permission: candidate.entry.permission,
      permissionMetadata: {
        permission: candidate.entry.permission,
        authorization: 'not_granted_by_ranking',
        destructiveHint: candidate.entry.permission === 'DANGEROUS',
      },
      source: candidate.entry.primitive === true ? 'primitive' : 'upgrade',
      tags: candidate.entry.tags,
      phase: candidate.entry.phase,
    }));
    const selectedModel = requestedReranker === 'local' ? 'deterministic' : 'deterministic';
    return {
      query,
      matches: scored.slice(0, limit).map((candidate) => candidate.entry),
      totalMatches: scored.length,
      limit,
      rankedCandidates,
      selectedModel,
      ...(requestedReranker === 'local' ? { fallbackReason: 'local_model_not_configured' } : {}),
      primitiveToolsRemainAvailable: true,
      authorizationUnchanged: true,
      route: route.route,
    };
  }

  private describeTool(name: string | undefined): unknown {
    const entry = SEARCH_CATALOG.find((candidate) => candidate.name === name);
    return entry === undefined ? { found: false, name: name ?? null } : { found: true, ...entry, schema: { type: 'object', additionalProperties: true }, authorizationUnchanged: true };
  }

  private categories(): { readonly categories: readonly { readonly category: string; readonly tools: number }[] } {
    const counts = new Map<string, number>();
    for (const entry of UPGRADE_TOOL_CATALOG) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return { categories: [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, tools]) => ({ category, tools })) };
  }

  private async changePlugin(
    operation: 'plugin_install' | 'plugin_enable' | 'plugin_disable' | 'plugin_remove',
    rawName: string | undefined,
    input: Record<string, unknown>,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const name = rawName?.trim();
    if (name === undefined || name.length === 0 || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(name)) {
      return err(appError('INVALID_INPUT', 'Plugin name must be 1-128 characters and use only letters, numbers, dot, underscore, @, slash, or hyphen'));
    }
    if (operation === 'plugin_remove' && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', 'Removing a plugin requires explicit user confirmation'));
    }
    if (this.stateStore === undefined) {
      return ok(truthfulUnavailable(operation, 'needs_setup', ['persistent runtime state path']));
    }
    let changed = false;
    let exists = false;
    let currentEnabled: boolean | undefined;
    const persisted = await this.mutateSharedState((plugins) => {
      const existing = plugins.get(name);
      exists = existing !== undefined;
      currentEnabled = existing?.enabled;
      if (operation === 'plugin_remove') {
        changed = plugins.delete(name);
        return;
      }
      if (operation === 'plugin_install') {
        if (!exists) {
          plugins.set(name, { name, enabled: input.enabled !== false });
          changed = true;
        }
        return;
      }
      if (existing !== undefined) {
        const enabled = operation === 'plugin_enable';
        if (existing.enabled !== enabled) {
          plugins.set(name, { name, enabled });
          changed = true;
        }
      }
    }, true);
    if (!persisted) return err(appError('INTERNAL_ERROR', 'Plugin registry update could not be persisted safely', true));
    if (operation === 'plugin_install' && exists) return err(appError('INVALID_INPUT', 'Plugin is already installed; remove it explicitly before installing a replacement'));
    if (operation !== 'plugin_install' && operation !== 'plugin_remove' && !exists) return err(appError('INVALID_INPUT', 'Plugin must be installed before it can be enabled or disabled'));
    if (operation === 'plugin_remove') return ok({ tool: operation, status: 'ready', available: true, executed: true, changed, name, removed: changed });
    const enabled = operation === 'plugin_install' ? input.enabled !== false : operation === 'plugin_enable';
    return ok({
      tool: operation, status: 'ready', available: true, executed: true, changed, name, enabled,
      ...(currentEnabled === undefined ? {} : { previousEnabled: currentEnabled }),
      persistence: 'shared_locked_state',
    });
  }

  private activityLogPath(): string | undefined {
    const runtimeStatePath = this.services.runtimeStatePath;
    return runtimeStatePath === undefined ? undefined : path.join(path.dirname(runtimeStatePath), 'mcp-activity.log');
  }

  private async liveLogsStatus(): Promise<Result<unknown>> {
    const filePath = this.activityLogPath();
    if (filePath === undefined) return ok(truthfulUnavailable('live_logs_status', 'needs_setup', ['runtime activity-log path']));
    try {
      const info = await stat(filePath);
      return ok({
        tool: 'live_logs_status', status: 'ready', available: true, ready: true, executed: true,
        source: 'mcp-activity.log', sourceState: 'active', bytes: info.size, updatedAt: info.mtime.toISOString(),
        boundedReadBytes: 4 * 1024 * 1024,
      });
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') {
        return ok({
          tool: 'live_logs_status', status: 'ready', available: true, ready: true, executed: true,
          source: 'mcp-activity.log', sourceState: 'idle', bytes: 0, updatedAt: null, boundedReadBytes: 4 * 1024 * 1024,
        });
      }
      return err(appError('INTERNAL_ERROR', 'Live Logs status could not read the activity log', true));
    }
  }

  private async liveLogsQuery(input: Record<string, unknown>): Promise<Result<unknown>> {
    const filePath = this.activityLogPath();
    if (filePath === undefined) return ok(truthfulUnavailable('live_logs_query', 'needs_setup', ['runtime activity-log path']));
    const limit = boundedInteger(input.limit, 100, 1, 500);
    const toolName = readString(input, 'toolName') ?? readString(input, 'tool');
    const correlationId = readString(input, 'correlationId') ?? readString(input, 'callId') ?? readString(input, 'traceId');
    const phase = readString(input, 'phase');
    const resultCode = readString(input, 'resultCode');
    const workspaceId = readString(input, 'workspaceId');
    let lines: readonly string[];
    try {
      lines = await readJsonlTail(filePath, 4 * 1024 * 1024);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') {
        return ok({ tool: 'live_logs_query', status: 'ready', available: true, ready: true, executed: true, events: [], returned: 0, truncatedByTailWindow: false });
      }
      return err(appError('INTERNAL_ERROR', 'Live Logs query could not read the activity log', true));
    }
    const parsed = lines.flatMap((line): Record<string, unknown>[] => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
    const events = parsed.filter((event) => {
      if (toolName !== undefined && event.toolName !== toolName) return false;
      if (phase !== undefined && event.phase !== phase) return false;
      if (resultCode !== undefined && event.resultCode !== resultCode) return false;
      if (workspaceId !== undefined && event.workspaceId !== workspaceId) return false;
      if (correlationId !== undefined && event.callId !== correlationId && event.traceId !== correlationId && event.traceParent !== correlationId) return false;
      return true;
    }).slice(-limit);
    return ok({
      tool: 'live_logs_query', status: 'ready', available: true, ready: true, executed: true,
      events, returned: events.length, limit, boundedReadBytes: 4 * 1024 * 1024,
      filters: { toolName: toolName ?? null, correlationId: correlationId ?? null, phase: phase ?? null, resultCode: resultCode ?? null, workspaceId: workspaceId ?? null },
    });
  }

  private async telemetryDashboard(): Promise<Result<unknown>> {
    const contextEconomy = this.contextEconomy.snapshot();
    const filePath = this.activityLogPath();
    if (filePath === undefined) {
      return ok({
        tool: 'telemetry_dashboard', status: 'ready', available: true, ready: true, executed: true,
        source: 'runtime-counters', mcpCalls: 0, completedCalls: 0, errors: 0, averageLatencyMs: 0, p95LatencyMs: 0,
        cacheHitRate: hitRate(this.cache), contextBytes: contextEconomy.contextSentBytes,
        filesScanned: contextEconomy.filesDiscovered, filesDelivered: contextEconomy.filesDelivered,
        contextEconomy,
      });
    }
    let lines: readonly string[] = [];
    try { lines = await readJsonlTail(filePath, 4 * 1024 * 1024); } catch (error: unknown) {
      if (nodeErrorCode(error) !== 'ENOENT') return err(appError('INTERNAL_ERROR', 'Telemetry could not read the local activity log', true));
    }
    const completed: { readonly durationMs: number; readonly resultCode: string }[] = [];
    let started = 0;
    for (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) continue;
        if (value.phase === 'started') started += 1;
        if (value.phase !== 'completed') continue;
        const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? Math.max(0, value.durationMs) : 0;
        completed.push({ durationMs, resultCode: typeof value.resultCode === 'string' ? value.resultCode : 'UNKNOWN' });
      } catch { /* ignore malformed historical lines */ }
    }
    const durations = completed.map((entry) => entry.durationMs).sort((left, right) => left - right);
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);
    const p95Index = durations.length === 0 ? -1 : Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * 0.95) - 1));
    const errors = completed.filter((entry) => entry.resultCode !== 'SUCCESS' && entry.resultCode !== 'OK' && entry.resultCode !== 'STARTED').length;
    return ok({
      tool: 'telemetry_dashboard', status: 'ready', available: true, ready: true, executed: true,
      source: 'mcp-activity.log', boundedReadBytes: 4 * 1024 * 1024,
      mcpCalls: Math.max(started, completed.length), completedCalls: completed.length, errors,
      averageLatencyMs: completed.length === 0 ? 0 : Number((totalDuration / completed.length).toFixed(2)),
      p95LatencyMs: p95Index < 0 ? 0 : durations[p95Index],
      cacheHitRate: hitRate(this.cache), contextBytes: contextEconomy.contextSentBytes,
      filesScanned: contextEconomy.filesDiscovered, filesDelivered: contextEconomy.filesDelivered,
      contextEconomy,
    });
  }

  private async managedTask(
    name: 'task_create' | 'task_status' | 'task_cancel' | 'task_result' | 'task_list',
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['local shell task runtime']));
    const workspaceId = readString(input, 'workspaceId');
    if (name === 'task_create') {
      const executable = readString(input, 'executable') ?? readString(input, 'command');
      if (executable === undefined) {
        return err(appError('INVALID_INPUT', 'task_create requires executable (or command); pass arguments, cwd, timeout_seconds, and workspaceId as needed'));
      }
      return capabilities.execute('shell', withCapabilityOwnerMetadata({
        ...input,
        operation: 'run',
        executable,
        execution: 'background',
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }, this.actor), signal, authorization);
    }
    if (name === 'task_list') {
      return capabilities.execute('shell', withCapabilityOwnerMetadata({
        operation: 'list',
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }, this.actor), signal, authorization);
    }
    const taskId = readString(input, 'taskId') ?? readString(input, 'task_id');
    if (taskId === undefined) return err(appError('INVALID_INPUT', `${name} requires taskId`));
    const operation = name === 'task_status' ? 'status' : name === 'task_result' ? 'result' : 'cancel';
    return capabilities.execute('shell', withCapabilityOwnerMetadata({
      operation,
      task_id: taskId,
      include_stdout: true,
      include_stderr: true,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(name === 'task_cancel' ? { userConfirmed: input.userConfirmed === true } : {}),
    }, this.actor), signal, authorization);
  }

  private async agentDelegation(
    name: 'delegate' | 'delegate_status' | 'delegate_cancel' | 'delegate_result' | 'parallel_delegate',
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const provider = this.services.agentSwarm;
    if (provider === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['configured owned agent-swarm provider']));
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${name} requires workspaceId`));

    if (name === 'delegate' || name === 'parallel_delegate') {
      const rawTasks = name === 'delegate'
        ? [{ id: readString(input, 'taskId') ?? 'delegate-1', prompt: readString(input, 'instruction') ?? readString(input, 'prompt') ?? readString(input, 'task') ?? '' }]
        : (Array.isArray(input.tasks) ? input.tasks : []).map((entry, index) => {
          const record = isRecord(entry) ? entry : { prompt: String(entry) };
          return {
            id: readString(record, 'id') ?? `delegate-${index + 1}`,
            prompt: readString(record, 'prompt') ?? readString(record, 'instruction') ?? readString(record, 'task') ?? '',
            ...(Array.isArray(record.dependsOn) ? { dependsOn: record.dependsOn.map(String) } : {}),
          };
        });
      if (rawTasks.length === 0 || rawTasks.some((task) => task.prompt.trim().length === 0)) {
        return err(appError('INVALID_INPUT', `${name} requires ${name === 'delegate' ? 'instruction/prompt' : 'one or more tasks with prompt/instruction'}`));
      }
      if (rawTasks.length > 4) return err(appError('INVALID_INPUT', 'parallel_delegate supports at most four tasks'));
      const ids = new Set(rawTasks.map((task) => task.id));
      if (ids.size !== rawTasks.length) return err(appError('INVALID_INPUT', 'Delegated task IDs must be unique'));
      for (const task of rawTasks) {
        if (task.dependsOn?.some((dependency) => !ids.has(dependency) || dependency === task.id)) return err(appError('INVALID_INPUT', 'Delegated task dependencies must reference another task in the same request'));
      }
      const idempotencyKey = readString(input, 'idempotencyKey') ?? digest({ workspaceId, tasks: rawTasks });
      const started = await provider.start(this.actor, {
        workspaceId,
        idempotencyKey,
        accessMode: 'read_only',
        tasks: rawTasks,
        maxConcurrency: name === 'delegate' ? 1 : boundedInteger(input.maxConcurrency, Math.min(2, rawTasks.length), 1, 4),
      }, signal, authorization);
      return started.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, delegateId: started.value.swarmId, swarm: started.value }) : started;
    }

    const delegateId = readString(input, 'delegateId') ?? readString(input, 'swarmId');
    if (delegateId === undefined) return err(appError('INVALID_INPUT', `${name} requires delegateId`));
    if (name === 'delegate_status') {
      const status = await provider.status(this.actor, workspaceId, delegateId);
      return status.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, delegateId, swarm: status.value }) : status;
    }
    if (name === 'delegate_cancel') {
      const cancelled = await provider.cancel(this.actor, workspaceId, delegateId, authorization);
      return cancelled.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, delegateId, swarm: cancelled.value }) : cancelled;
    }
    const taskId = readString(input, 'taskId') ?? 'delegate-1';
    const result = await provider.result(this.actor, workspaceId, delegateId, taskId, readString(input, 'cursor') ?? '0', boundedInteger(input.maxBytes, 8_192, 1, 16_384));
    return result.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, delegateId, result: result.value }) : result;
  }

  private async createTask(kind: RuntimeTask['kind'], input: Record<string, unknown>): Promise<RuntimeTask> {
    const task: RuntimeTask = { id: randomUUID(), kind, createdAt: new Date().toISOString(), inputDigest: digest(input), state: 'queued' };
    this.tasks.set(task.id, task);
    await this.persistState();
    return task;
  }

  private taskView(id: string | undefined): unknown {
    const task = id === undefined ? undefined : this.tasks.get(id);
    return task === undefined ? { found: false, id: id ?? null } : publicTask(task);
  }

  private async cancelTask(id: string | undefined): Promise<unknown> {
    const task = id === undefined ? undefined : this.tasks.get(id);
    if (task === undefined) return { cancelled: false, id: id ?? null };
    task.state = 'cancelled';
    await this.persistState();
    return { cancelled: true, id };
  }

  private listToolSchemas(): readonly Record<string, unknown>[] {
    const baseline = UPGRADE_TOOL_CATALOG.map((entry) => ({
      id: entry.name, version: '1.0.0', permissions: [entry.permission], streamable: entry.streamable === true,
      parallelSafe: entry.parallelSafe === true, source: 'built_in', schema: { type: 'object', additionalProperties: true },
    }));
    const stored = this.session.get('toolSchemas');
    const custom = Array.isArray(stored) ? stored.filter(isRegisteredToolSchema) : [];
    return [...baseline, ...custom].sort((left, right) => String(left.id).localeCompare(String(right.id)) || String(left.version).localeCompare(String(right.version)));
  }

  private async registerToolSchema(input: Record<string, unknown>): Promise<Result<unknown>> {
    const id = readString(input, 'id') ?? readString(input, 'name');
    const version = readString(input, 'version');
    const schema = isRecord(input.schema) ? input.schema : undefined;
    if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return err(appError('INVALID_INPUT', 'tool_schema_register requires a valid id/name'));
    if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) return err(appError('INVALID_INPUT', 'tool_schema_register requires a semantic version such as 1.1.0'));
    if (schema === undefined || schema.type !== 'object') return err(appError('INVALID_INPUT', 'tool_schema_register requires an object JSON schema descriptor'));
    const builtIn = UPGRADE_TOOL_CATALOG.find((entry) => entry.name === id);
    const requestedPermission = readString(input, 'permission');
    if (builtIn !== undefined && requestedPermission !== undefined && requestedPermission !== builtIn.permission) {
      return err(appError('PERMISSION_DENIED', 'A registered schema cannot change a built-in tool permission'));
    }
    const current = this.listToolSchemas().filter((entry) => entry.id === id);
    if (current.some((entry) => entry.version === version)) return err(appError('CONFLICT', 'That tool schema version is already registered'));
    const latest = current.at(-1);
    if (latest !== undefined && semanticMajor(String(latest.version)) !== semanticMajor(version)) {
      return err(appError('INVALID_INPUT', 'Schema registration must remain within the current major version'));
    }
    const previousRequired = latest !== undefined && isRecord(latest.schema) && Array.isArray(latest.schema.required) ? latest.schema.required.map(String) : [];
    const nextRequired = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const newlyRequired = nextRequired.filter((key) => !previousRequired.includes(key));
    if (latest !== undefined && newlyRequired.length > 0) return err(appError('INVALID_INPUT', `Backward-compatible schemas cannot add required properties: ${newlyRequired.join(', ')}`));
    const record = {
      id, version, permissions: [builtIn?.permission ?? normalizePermission(requestedPermission)],
      streamable: input.streamable === true, parallelSafe: input.parallelSafe === true,
      source: 'registered', schema,
    };
    const stored = this.session.get('toolSchemas');
    const custom = Array.isArray(stored) ? stored.filter(isRegisteredToolSchema) : [];
    custom.push(record);
    this.session.set('toolSchemas', custom);
    const persisted = await this.persistState();
    if (!persisted) return err(appError('INTERNAL_ERROR', 'Tool schema registry could not be persisted', true));
    return ok({ tool: 'tool_schema_register', status: 'ready', available: true, ready: true, executed: true, registered: true, backwardCompatible: true, schema: record, persistence: this.stateStore === undefined ? 'memory_only' : 'session_locked_state' });
  }

  private async externalMcpInsight(name: 'mcp_discover' | 'mcp_health'): Promise<Result<unknown>> {
    const extensions = this.services.extensions;
    if (extensions === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['configured external MCP catalog']));
    const listed = await extensions.listMcpServers();
    if (!listed.ok) return listed;
    if (name === 'mcp_discover') {
      return ok({
        tool: name,
        status: 'ready',
        available: true,
        ready: true,
        executed: true,
        servers: listed.value.servers,
        nativeToolsRemainVisible: true,
        flattenChildTools: false,
      });
    }
    const servers = listed.value.servers.map((server) => ({
      name: server.name,
      enabled: server.enabled,
      connected: server.connected,
      excluded: server.excluded,
      ...(server.exclusionReason === undefined ? {} : { exclusionReason: server.exclusionReason }),
    }));
    return ok({
      tool: name,
      status: 'ready',
      available: true,
      ready: true,
      executed: true,
      servers,
      connected: servers.filter((server) => server.connected).length,
      enabled: servers.filter((server) => server.enabled).length,
    });
  }

  private async externalMcpHub(): Promise<Result<unknown>> {
    const extensions = this.services.extensions;
    if (extensions === undefined) return ok(truthfulUnavailable('mcp_hub', 'needs_setup', ['configured external MCP catalog']));
    const listed = await extensions.listMcpServers();
    if (!listed.ok) return listed;
    const servers = listed.value.servers.map((server) => ({
      name: server.name,
      enabled: server.enabled,
      connected: server.connected,
      excluded: server.excluded,
    }));
    return ok({
      tool: 'mcp_hub', status: 'ready', available: true, ready: true, executed: true,
      servers, connected: servers.filter((server) => server.connected).length,
      flattenChildTools: false, credentialsStoredInRepository: false, authorizationUnchanged: true,
    });
  }

  private async externalMcpResources(input: Record<string, unknown>): Promise<Result<unknown>> {
    const extensions = this.services.extensions;
    if (extensions === undefined) return ok(truthfulUnavailable('mcp_resources', 'needs_setup', ['configured external MCP server with resources capability']));
    const server = readString(input, 'server');
    if (server !== undefined) {
      const listed = await extensions.listMcpResources({ server });
      if (!listed.ok) return listed;
      return ok({ tool: 'mcp_resources', status: 'ready', available: true, ready: true, executed: true, ...listed.value });
    }
    const discovered = await extensions.listMcpServers();
    if (!discovered.ok) return discovered;
    const candidates = discovered.value.servers.filter((entry) => entry.enabled && !entry.excluded);
    if (candidates.length === 0) return ok(truthfulUnavailable('mcp_resources', 'needs_setup', ['configured external MCP server with resources capability']));
    const servers: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const listed = await extensions.listMcpResources({ server: candidate.name });
      if (listed.ok) servers.push({ server: candidate.name, connected: listed.value.connected, resources: listed.value.resources });
      else servers.push({ server: candidate.name, connected: candidate.connected, status: 'unknown', error: summarize(listed.error.message) });
    }
    return ok({ tool: 'mcp_resources', status: 'ready', available: true, ready: true, executed: true, servers });
  }

  private async selfHealPlan(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const evidence: Record<string, unknown> = {};
    const fixes: SelfHealFix[] = [];

    if (workspaceId !== undefined && this.services.workspaceIndex !== undefined) {
      const status = await this.services.workspaceIndex.status(workspaceId);
      if (status.ok) {
        evidence.index = { indexed: status.value.indexed, entries: status.value.snapshot?.entries?.length ?? 0 };
        if (status.value.indexed !== true) {
          fixes.push({
            id: 'reindex-workspace', kind: 'reindex_workspace', tool: 'workspace_index', args: { workspaceId },
            description: 'Rebuild the persistent workspace index (read-only re-scan)', reversible: true, requiresConfirmation: false,
          });
        }
      }
    }

    if (this.services.capabilities !== undefined) {
      const list = await this.services.capabilities.execute('shell', { operation: 'list' }, undefined, authorization);
      if (list.ok && typeof list.value === 'object' && list.value !== null && Array.isArray((list.value as { tasks?: unknown }).tasks)) {
        const tasks = (list.value as { tasks: Record<string, unknown>[] }).tasks;
        const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
        const stale = tasks.filter((task) => task.durable === true && task.state === 'running' && typeof task.started_at === 'string' && Date.parse(task.started_at) < cutoff);
        evidence.durableTasks = { total: tasks.length, staleOlderThan24h: stale.length };
        for (const task of stale.slice(0, 10)) {
          fixes.push({
            id: `cancel-stale-task-${String(task.task_id)}`, kind: 'cancel_stale_task', tool: 'shell',
            args: { operation: 'cancel', task_id: task.task_id },
            description: `Cancel durable task ${String(task.task_id)} that has been running for over 24 hours`, reversible: false, requiresConfirmation: true,
          });
        }
      }
    }

    const planId = digest({ workspaceId: workspaceId ?? null, evidence, fixes: fixes.map((fix) => ({ id: fix.id, kind: fix.kind, args: fix.args })) });
    return ok({
      tool: 'self_heal_plan', status: 'ready', available: true, applied: false,
      planId,
      mutationRequired: fixes.some((fix) => fix.requiresConfirmation),
      safeReversibleFixes: fixes,
      automaticDestructiveRetry: false,
      auditTarget: 'recovery-plan',
      evidence,
    });
  }

  private async selfHealApply(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const plan = await this.selfHealPlan(input, authorization);
    if (!plan.ok) return plan;
    const planValue = plan.value as { planId: string; safeReversibleFixes: SelfHealFix[] };
    const requested = Array.isArray(input.fixIds) ? input.fixIds.map(String) : undefined;
    const selected = planValue.safeReversibleFixes.filter((fix) => requested === undefined || requested.includes(fix.id));
    const preview = {
      tool: 'self_heal_apply',
      planId: planValue.planId,
      selected: selected.map((fix) => ({ id: fix.id, kind: fix.kind, description: fix.description, requiresConfirmation: fix.requiresConfirmation })),
      automaticDestructiveRetry: false,
      auditTarget: 'recovery-mutation',
    };
    if (input.dryRun !== false && input.dry_run !== false) return ok({ ...preview, dryRun: true, applied: [] });
    if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', 'Applying a recovery plan requires explicit chat confirmation. Review self_heal_plan first, then retry with userConfirmed: true'));
    }
    const approvedPlanId = readString(input, 'planId');
    if (approvedPlanId === undefined) {
      return err(appError('PERMISSION_REQUIRED', 'Applying a recovery plan requires the planId returned by self_heal_plan'));
    }
    if (approvedPlanId !== planValue.planId) {
      return err(appError('INVALID_INPUT', 'Recovery evidence changed after preview. Run self_heal_plan again and review the new plan before applying it'));
    }

    const applied: Record<string, unknown>[] = [];
    for (const fix of selected) {
      if (fix.kind === 'reindex_workspace' && this.services.workspaceIndex !== undefined) {
        const result = await this.services.workspaceIndex.indexWorkspace(String(fix.args.workspaceId));
        applied.push({ id: fix.id, kind: fix.kind, ok: result.ok, ...(result.ok ? {} : { error: result.error.message }) });
      } else if (fix.kind === 'cancel_stale_task' && this.services.capabilities !== undefined) {
        const result = await this.services.capabilities.execute('shell', fix.args, undefined, authorization);
        applied.push({ id: fix.id, kind: fix.kind, ok: result.ok, ...(result.ok ? {} : { error: result.error.message }) });
      } else {
        applied.push({ id: fix.id, kind: fix.kind, ok: false, error: 'unsupported-fix-kind' });
      }
    }
    return ok({ ...preview, dryRun: false, applied, automaticDestructiveRetry: false });
  }

  private async officePowerPoint(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return ok({ tool: 'office_ppt', status: 'optional', available: false, reason: 'Office capability is not configured' });
    const action = readString(input, 'action') ?? 'read';
    if (action !== 'read' && action !== 'save_as') return err(appError('INVALID_INPUT', 'office_ppt action must be read or save_as'));
    const filePath = readString(input, 'file_path') ?? readString(input, 'path');
    if (filePath === undefined) return err(appError('INVALID_INPUT', 'office_ppt requires file_path'));
    const targetPath = readString(input, 'target_path') ?? readString(input, 'target');
    if (action === 'save_as' && targetPath === undefined) return err(appError('INVALID_INPUT', 'office_ppt save_as requires target_path'));
    const plan = { tool: 'office_ppt', status: 'ready', available: true, app: 'powerpoint', action, file_path: filePath, ...(targetPath === undefined ? {} : { target_path: targetPath }) };
    if (action === 'save_as' && input.dryRun !== false && input.dry_run !== false) return ok({ ...plan, dryRun: true, executed: false });
    if (action === 'save_as' && !isApplicationAuthorized(authorization, input.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'PowerPoint save_as requires explicit user confirmation'));
    let safeFilePath = filePath;
    let safeTargetPath = targetPath;
    let replacementBackup: { readonly recoveryId: string; readonly recoveryPath: string } | undefined;
    if (action === 'save_as') {
      const workspaceId = readString(input, 'workspaceId');
      if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'PowerPoint save_as requires workspaceId'));
      const fileSafety = this.services.file;
      if (fileSafety === undefined) return err(appError('INTERNAL_ERROR', 'File safety service is unavailable; refusing PowerPoint save_as', true));
      const prepared = await fileSafety.prepareExternalFileMutation(this.actor, workspaceId, {
        sourcePaths: [filePath],
        targetPath: targetPath!,
        ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
      }, signal, authorization);
      if (!prepared.ok) return prepared;
      safeFilePath = prepared.value.sourcePaths[0]!;
      safeTargetPath = prepared.value.targetPath;
      replacementBackup = prepared.value.replacementBackup;
    }
    const result = await capabilities.execute('office', {
      app: 'powerpoint',
      action,
      file_path: safeFilePath,
      ...(safeTargetPath === undefined ? {} : { target_path: safeTargetPath }),
      ...(action === 'save_as' && input.userConfirmed === true ? { userConfirmed: true } : {}),
    }, signal, authorization);
    if (!result.ok) return withReplacementRecoveryDetails(result, replacementBackup);
    return ok({
      ...plan,
      dryRun: false,
      executed: true,
      result: result.value,
      ...(replacementBackup === undefined ? {} : { replacementBackup }),
    });
  }

  private async officeOutlook(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return ok({ tool: 'office_outlook', status: 'optional', available: false, reason: 'Office capability is not configured' });
    const action = readString(input, 'action') ?? 'list_messages';
    if (action !== 'list_folders' && action !== 'list_messages') return err(appError('INVALID_INPUT', 'office_outlook action must be list_folders or list_messages'));
    const folder = readString(input, 'folder');
    const maxMessages = typeof input.max_messages === 'number' ? Math.min(100, Math.max(1, Math.trunc(input.max_messages))) : undefined;
    const result = await capabilities.execute('office', { app: 'outlook', action, ...(folder === undefined ? {} : { folder }), ...(maxMessages === undefined ? {} : { max_messages: maxMessages }) }, undefined, authorization);
    return result.ok ? ok({ tool: 'office_outlook', status: 'ready', available: true, action, result: result.value }) : result;
  }

  private async eventLogQuery(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const result = await this.eventLog.execute({
      operation: name === 'crash_trace' ? 'crashes' : 'query',
      ...(readString(input, 'log_name') === undefined && readString(input, 'logName') === undefined ? {} : { log_name: readString(input, 'log_name') ?? readString(input, 'logName') }),
      ...(readString(input, 'provider') === undefined ? {} : { provider: readString(input, 'provider') }),
      ...(readString(input, 'since') === undefined ? {} : { since: readString(input, 'since') }),
      ...(typeof input.hours === 'number' ? { hours: input.hours } : {}),
      ...(typeof input.max_events === 'number' ? { max_events: input.max_events } : {}),
    }, signal);
    if (!result.ok) return result;
    const payload = result.value as Record<string, unknown>;
    return ok({
      tool: name,
      status: payload.available === false ? 'optional' : 'ready',
      ...payload,
    });
  }

  private async gitWorktreeSpawn(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is required for a Git worktree'));
    const worktreePath = readString(input, 'worktreePath') ?? `.worktrees/agent-${randomUUID().slice(0, 8)}`;
    const absolutePath = path.win32.isAbsolute(worktreePath);
    const normalizedPath = path.win32.normalize(worktreePath).replaceAll('\\', '/');
    const scopedRelativePath = !absolutePath
      && !normalizedPath.split('/').some((part) => part === '..')
      && (normalizedPath.startsWith('.worktrees/') || normalizedPath.startsWith('.lnwjud/worktrees/'));
    if (!scopedRelativePath && !(absolutePath && isFullBypassAuthorization(authorization))) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Git worktree path must remain under .worktrees or .lnwjud/worktrees'));
    }
    const ref = readString(input, 'ref') ?? 'HEAD';
    if (ref.includes('\0') || ref.length > 256) return err(appError('INVALID_INPUT', 'Git worktree ref is invalid'));
    const plan = {
      tool: 'git_worktree_spawn',
      workspaceId,
      worktreePath: normalizedPath,
      ref,
      owner: this.actor.clientId,
      ownerSessionId: actorSessionId(this.actor),
      collisionPolicy: 'one-owner-per-worktree-path',
      mutationPolicy: 'explicit-confirmation-and-dry-run',
      sideEffectsStarted: false,
    };
    const dryRun = input.dryRun !== false && input.dry_run !== false;
    if (dryRun) return ok({ ...plan, dryRun: true });
    if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'Creating a Git worktree requires explicit user confirmation'));
    await this.refreshSharedState();
    if (this.worktrees.some((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === normalizedPath)) {
      return err(appError('INVALID_INPUT', 'Git worktree path is already present in the shared ownership ledger'));
    }
    if (this.services.git === undefined) return ok({ ...plan, dryRun: false, status: 'optional', available: false, reason: 'Git service is not configured' });
    const result = await this.services.git.run(this.actor, {
      workspaceId,
      args: ['worktree', 'add', '--detach', normalizedPath, ref],
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    }, undefined, authorization);
    if (!result.ok) return result;
    const ledgerEntry: WorktreeLedgerEntry = { workspaceId, worktreePath: normalizedPath, ref, owner: this.actor.clientId, ownerSessionId: actorSessionId(this.actor), createdAt: new Date().toISOString() };
    await this.mutateSharedState((_plugins, worktrees) => {
      if (!worktrees.some((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === normalizedPath)) worktrees.push(ledgerEntry);
    });
    return ok({ ...plan, dryRun: false, sideEffectsStarted: true, status: 'completed', result: result.value, ownershipLedger: true });
  }

  private async gitWorktreeRemove(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const worktreePath = readString(input, 'worktreePath')?.replaceAll('\\', '/');
    if (workspaceId === undefined || worktreePath === undefined) return err(appError('INVALID_INPUT', 'workspaceId and worktreePath are required'));
    await this.refreshSharedState();
    const entry = this.worktrees.find((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === worktreePath);
    if (entry === undefined) return err(appError('PROCESS_NOT_FOUND', 'Worktree is not in the ownership ledger; refusing to remove unknown worktrees'));
    if (entry.owner !== this.actor.clientId || (entry.ownerSessionId !== undefined && entry.ownerSessionId !== actorSessionId(this.actor))) {
      return err(appError('PERMISSION_DENIED', 'Worktree is owned by another client session'));
    }
    const plan = {
      tool: 'git_worktree_remove', workspaceId, worktreePath,
      owner: entry.owner,
      mutationPolicy: 'explicit-confirmation-and-dry-run',
    };
    if (input.dryRun !== false && input.dry_run !== false) return ok({ ...plan, dryRun: true });
    if (!isApplicationAuthorized(authorization, input.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'Removing a Git worktree requires explicit user confirmation'));
    if (this.services.git === undefined) return ok({ ...plan, dryRun: false, status: 'optional', available: false, reason: 'Git service is not configured' });
    const result = await this.services.git.run(this.actor, {
      workspaceId,
      args: ['worktree', 'remove', worktreePath],
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    }, undefined, authorization);
    if (!result.ok) return result;
    await this.mutateSharedState((_plugins, worktrees) => {
      const index = worktrees.findIndex((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === worktreePath);
      if (index !== -1) worktrees.splice(index, 1);
    });
    return ok({ ...plan, dryRun: false, sideEffectsStarted: true, status: 'completed', result: result.value });
  }

  private async repositoryMap(workspaceId: string | undefined): Promise<Result<unknown>> {
    if (workspaceId === undefined || this.services.workspaceIndex === undefined) return ok({ workspaceId: workspaceId ?? null, entries: [], indexed: false, traversable: true });
    const status = await this.services.workspaceIndex.status(workspaceId);
    if (!status.ok) return status;
    const entries = status.value.snapshot?.entries ?? [];
    return ok({ workspaceId, indexed: status.value.indexed, traversable: true, counts: countKinds(entries), entries: entries.map((entry) => ({ path: entry.relativePath, kind: entry.kind, language: entry.language, isTest: entry.isTest })) });
  }

  private async contextExpansion(name: string, workspaceId: string | undefined, query: string | undefined): Promise<Result<unknown>> {
    if (workspaceId === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['registered workspace']));
    if (this.services.workspaceIndex === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['workspace index service']));
    const status = await this.services.workspaceIndex.status(workspaceId);
    if (!status.ok) return status;
    const needle = (query ?? '').toLowerCase();
    const references = (status.value.snapshot?.entries ?? []).filter((entry) => needle.length === 0 || entry.relativePath.toLowerCase().includes(needle) || entry.symbols.some((symbol) => symbol.toLowerCase().includes(needle))).slice(0, 100).map((entry) => ({ path: entry.relativePath, imports: entry.imports, exports: entry.exports, tests: entry.isTest }));
    return ok({ workspaceId, query: query ?? '', references, optional: true, continuationAvailable: false });
  }

  private async indexQuery(name: string, workspaceId: string | undefined, query: string): Promise<Result<unknown>> {
    if (workspaceId === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['registered workspace']));
    if (this.services.workspaceIndex === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['workspace index service']));
    const status = await this.services.workspaceIndex.status(workspaceId);
    if (!status.ok) return status;
    const needle = query.toLowerCase();
    const entries = status.value.snapshot?.entries ?? [];
    const matches = entries.filter((entry) => entry.symbols.some((symbol) => symbol.toLowerCase().includes(needle)) || entry.relativePath.toLowerCase().includes(needle)).map((entry) => ({ path: entry.relativePath, symbols: entry.symbols, functions: entry.functions, classes: entry.classes, interfaces: entry.interfaces, imports: entry.imports, exports: entry.exports, isTest: entry.isTest }));
    return ok({ tool: name, query, indexed: status.value.indexed, matches, lowerRankedResultsRemainAvailable: true });
  }

  private async benchmarkRun(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'benchmark_run requires workspaceId'));
    const processService = this.services.process;
    const fileService = this.services.file;
    if (processService === undefined || fileService === undefined) {
      return ok(truthfulUnavailable('benchmark_run', 'needs_setup', [
        ...(processService === undefined ? ['managed process service'] : []),
        ...(fileService === undefined ? ['workspace file service'] : []),
      ]));
    }
    const detected = await this.detectBenchmarkCommand(workspaceId, authorization);
    if (!detected.ok) return detected;
    const plan = {
      tool: 'benchmark_run', status: 'ready', available: true, ready: true,
      workspaceId, scenario: readString(input, 'scenario') ?? detected.value.script,
      command: detected.value, mutationPolicy: 'managed-process-policy',
    };
    if (input.dryRun !== false && input.dry_run !== false) return ok({ ...plan, dryRun: true, executed: false, started: false });
    const started = await processService.start(this.actor, workspaceId, {
      executable: detected.value.executable,
      args: detected.value.args,
      timeoutMs: boundedInteger(input.timeoutMs ?? input.timeout_ms, 15 * 60_000, 1_000, 4 * 60 * 60_000),
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    }, signal, authorization);
    if (!started.ok) return started;
    const run = {
      id: randomUUID(), workspaceId, processId: started.value.processId,
      scenario: readString(input, 'scenario') ?? detected.value.script,
      command: detected.value,
      startedAt: new Date().toISOString(),
    };
    const existing = this.session.get('benchmarkRuns');
    const runs = Array.isArray(existing) ? existing.filter(isBenchmarkRunRecord) : [];
    runs.push(run);
    this.session.set('benchmarkRuns', runs.slice(-50));
    await this.persistState();
    return ok({ ...plan, dryRun: false, executed: true, started: true, benchmarkRunId: run.id, process: started.value });
  }

  private async detectBenchmarkCommand(workspaceId: string, authorization?: InvocationAuthorization): Promise<Result<{ readonly executable: string; readonly args: readonly string[]; readonly script: string }>> {
    const file = this.services.file;
    if (file === undefined) return ok(truthfulUnavailable('benchmark_run', 'needs_setup', ['workspace file service'])) as Result<{ readonly executable: string; readonly args: readonly string[]; readonly script: string }>;
    const packageJson = await file.readFile(this.actor, workspaceId, { path: 'package.json' }, authorization);
    if (!packageJson.ok) {
      if (packageJson.error.code === 'FILE_NOT_FOUND') return err(appError('INVALID_INPUT', 'No package.json benchmark script was detected in this workspace'));
      return packageJson as Result<{ readonly executable: string; readonly args: readonly string[]; readonly script: string }>;
    }
    const content = (packageJson.value as { content?: unknown }).content;
    if (typeof content !== 'string') return err(appError('INVALID_INPUT', 'package.json is not a readable text file'));
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return err(appError('INVALID_INPUT', 'package.json contains invalid JSON')); }
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return err(appError('INVALID_INPUT', 'No package.json scripts were found for benchmark detection'));
    const scripts = parsed.scripts;
    const script = ['benchmark:baseline', 'benchmark', 'bench'].find((candidate) => typeof scripts[candidate] === 'string' && String(scripts[candidate]).trim().length > 0);
    if (script === undefined) return err(appError('INVALID_INPUT', 'No benchmark:baseline, benchmark, or bench package script was detected'));
    const packageManager = typeof parsed.packageManager === 'string' ? parsed.packageManager.trim() : '';
    if (packageManager.startsWith('pnpm@')) return ok({ executable: 'corepack', args: [packageManager, 'run', script], script });
    if (packageManager.startsWith('yarn@')) return ok({ executable: 'corepack', args: [packageManager, 'run', script], script });
    if (packageManager.startsWith('npm@')) return ok({ executable: 'npm.cmd', args: ['run', script], script });
    return ok({ executable: 'npm.cmd', args: ['run', script], script });
  }

  private async regressionReport(input: Record<string, unknown>): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const stored = this.session.get('benchmarkRuns');
    const runs = (Array.isArray(stored) ? stored.filter(isBenchmarkRunRecord) : [])
      .filter((run) => workspaceId === undefined || run.workspaceId === workspaceId);
    const processService = this.services.process;
    const reports: Record<string, unknown>[] = [];
    for (const run of runs.slice(-20)) {
      if (processService === undefined) {
        reports.push({ ...run, state: 'unavailable', reason: 'managed process service is not configured' });
        continue;
      }
      const status = await processService.status(this.actor, run.workspaceId, run.processId);
      if (!status.ok) {
        reports.push({ ...run, state: 'unavailable', reason: status.error.message });
        continue;
      }
      let output: unknown = null;
      if (['exited', 'failed', 'stopped', 'timed_out'].includes(status.value.state)) {
        const logs = await processService.logs(this.actor, run.workspaceId, run.processId, { tailLines: 200 });
        output = logs.ok ? logs.value : { error: logs.error.message };
      }
      const durationMs = status.value.finishedAt === undefined
        ? null
        : Math.max(0, new Date(status.value.finishedAt).getTime() - new Date(status.value.startedAt).getTime());
      reports.push({ ...run, state: status.value.state, exitCode: status.value.exitCode ?? null, durationMs, output });
    }
    const terminal = reports.filter((entry) => ['exited', 'failed', 'stopped', 'timed_out'].includes(String(entry.state)));
    const failed = terminal.filter((entry) => entry.state !== 'exited' || (typeof entry.exitCode === 'number' && entry.exitCode !== 0));
    return ok({
      tool: 'regression_report', status: 'ready', available: true, ready: true, executed: true,
      workspaceId: workspaceId ?? null, runs: reports, retainedRuns: runs.length,
      terminalRuns: terminal.length, regressions: failed.map((entry) => ({ benchmarkRunId: entry.id, scenario: entry.scenario, state: entry.state, exitCode: entry.exitCode })),
      persistence: this.stateStore === undefined ? 'memory_only' : 'session_locked_state',
    });
  }

  private async projectProfile(
    name: 'project_profile_get' | 'project_profile_set',
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${name} requires workspaceId`));
    const file = this.services.file;
    if (file === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['workspace file service']));
    const profilePath = '.lnwjud/project-profile.json';
    if (name === 'project_profile_get') {
      const loaded = await file.readFile(this.actor, workspaceId, { path: profilePath }, authorization);
      if (!loaded.ok) {
        if (loaded.error.code === 'FILE_NOT_FOUND') return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, workspaceId, source: profilePath, profile: null });
        return loaded;
      }
      const content = (loaded.value as { content?: unknown }).content;
      if (typeof content !== 'string') return err(appError('INTERNAL_ERROR', 'Project profile file returned a non-text payload', true));
      try {
        const profile: unknown = JSON.parse(content);
        if (!isRecord(profile)) return err(appError('INVALID_INPUT', 'Project profile must contain a JSON object'));
        return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, workspaceId, source: profilePath, profile });
      } catch {
        return err(appError('INVALID_INPUT', 'Project profile contains invalid JSON'));
      }
    }
    const profile = isRecord(input.profile) ? input.profile : isRecord(input.conventions) ? input.conventions : undefined;
    if (profile === undefined) return err(appError('INVALID_INPUT', 'project_profile_set requires profile (a JSON object)'));
    const normalized = validateProjectProfile(profile);
    if (!normalized.ok) return normalized;
    const content = `${JSON.stringify(normalized.value, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > 128 * 1024) return err(appError('FILE_TOO_LARGE', 'Project profile exceeds 128 KiB'));
    if (input.dryRun !== false && input.dry_run !== false) return ok({ tool: name, status: 'ready', available: true, ready: true, executed: false, dryRun: true, workspaceId, source: profilePath, profile: normalized.value });
    const saved = await file.writeFile(this.actor, workspaceId, { path: profilePath, content, overwriteExisting: true, ...(input.userConfirmed === true ? { userConfirmed: true } : {}) }, signal, authorization);
    return saved.ok
      ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, dryRun: false, workspaceId, source: profilePath, profile: normalized.value, write: saved.value })
      : saved;
  }

  private async compoundContext(name: string, input: Record<string, unknown>): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const requirements = [
      ...(workspaceId === undefined ? ['registered workspace'] : []),
      ...(this.services.search === undefined ? ['workspace search service'] : []),
      ...(this.services.file === undefined ? ['workspace file service'] : []),
      ...(this.services.git === undefined ? ['configured Git service'] : []),
    ];
    if (requirements.length > 0) return ok(truthfulUnavailable(name, 'needs_setup', requirements));
    const query = readString(input, 'query') ?? readString(input, 'prompt') ?? name;
    const context = await this.contextEngine.collect({
      query,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      intent: name.includes('review') ? 'review' : name.includes('test') ? 'explore' : name.includes('symbol') ? 'trace' : name.includes('debug') ? 'debug' : 'auto',
      mode: 'full',
    });
    if (!context.ok) return context;
    const git = await this.services.git!.status(this.actorForOperation(), workspaceId!);
    if (!git.ok) return git;
    return ok({
      tool: name,
      query,
      context: context.value,
      git: git.value,
      internalOperations: ['workspace search', 'indexed symbol lookup', 'git status', 'test relevance'],
      rawToolsRemainAvailable: true,
    });
  }

  private async skillInsight(name: string, input: Record<string, unknown>): Promise<Result<unknown>> {
    const extensions = this.services.extensions;
    if (extensions === undefined) {
      return ok(truthfulUnavailable(name, 'needs_setup', ['configured local skill catalog']));
    }

    if (name === 'skill_match') {
      const query = readString(input, 'query') ?? readString(input, 'prompt') ?? '';
      const source = readString(input, 'source');
      const listed = await extensions.listSkills({
        ...(query.length === 0 ? {} : { query }),
        ...(source === undefined ? {} : { source }),
      });
      return listed.ok
        ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, query, skills: listed.value.skills })
        : listed;
    }

    const skillId = readString(input, 'skillId') ?? readString(input, 'id') ?? readString(input, 'name');
    if (skillId === undefined) return err(appError('INVALID_INPUT', 'skill_load requires skillId'));
    const relativePath = readString(input, 'relativePath') ?? readString(input, 'path');
    const loaded = await extensions.readSkill({
      skillId,
      ...(relativePath === undefined ? {} : { relativePath }),
    });
    return loaded.ok
      ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, skill: loaded.value })
      : loaded;
  }

  private async importSkill(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const sourcePath = readString(input, 'source_path') ?? readString(input, 'sourcePath') ?? readString(input, 'path');
    const requestedName = readString(input, 'name');
    if (workspaceId === undefined || sourcePath === undefined) return err(appError('INVALID_INPUT', 'skills_import requires workspaceId and source_path'));
    const file = this.services.file;
    if (file === undefined) return ok(truthfulUnavailable('skills_import', 'needs_setup', ['workspace file service']));
    const loaded = await file.readFile(this.actor, workspaceId, { path: sourcePath }, authorization);
    if (!loaded.ok) return loaded;
    const content = (loaded.value as { content?: unknown }).content;
    if (typeof content !== 'string') return err(appError('INVALID_INPUT', 'Skill source must be a UTF-8 text SKILL.md file'));
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) return err(appError('FILE_TOO_LARGE', 'Skill source exceeds 256 KiB'));
    const parsed = parseSkillDescriptor(content);
    if (!parsed.ok) return parsed;
    const name = requestedName ?? parsed.value.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return err(appError('INVALID_INPUT', 'Skill name must be 1-128 safe filename characters'));
    const targetPath = `.agents/skills/${name}/SKILL.md`;
    const plan = { tool: 'skills_import', status: 'ready', available: true, ready: true, workspaceId, sourcePath, targetPath, skill: parsed.value };
    if (input.dryRun !== false && input.dry_run !== false) return ok({ ...plan, dryRun: true, executed: false, imported: false });
    const saved = await file.writeFile(this.actor, workspaceId, {
      path: targetPath,
      content,
      overwriteExisting: input.overwriteExisting === true || input.overwrite_existing === true,
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    }, signal, authorization);
    return saved.ok
      ? ok({ ...plan, dryRun: false, executed: true, imported: true, write: saved.value })
      : saved;
  }

  private async gitInsight(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${name} requires workspaceId`));
    const git = this.services.git;
    if (git === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['configured Git service']));

    if (name === 'git_history_context') {
      const history = await git.log(this.actor, workspaceId, { maxCommits: boundedInteger(input.maxCommits, 25, 1, 100) }, signal);
      return history.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, history: history.value }) : history;
    }
    if (name === 'git_blame_context') {
      const filePath = readString(input, 'path');
      if (filePath === undefined) return err(appError('INVALID_INPUT', 'git_blame_context requires path'));
      const blame = await git.run(this.actor, { workspaceId, args: ['blame', '--line-porcelain', '--', filePath] }, signal);
      return blame.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, path: filePath, blame: blame.value }) : blame;
    }

    const status = await git.status(this.actor, workspaceId, signal);
    if (!status.ok) return status;
    if (name === 'affected_modules') {
      const changedPaths = status.value.entries.map((entry) => entry.path);
      const modules = [...new Set(changedPaths.map((changedPath) => changedPath.replaceAll('\\', '/').split('/')[0]).filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
      let index: unknown = null;
      if (this.services.workspaceIndex !== undefined) {
        const indexed = await this.services.workspaceIndex.status(workspaceId);
        index = indexed.ok ? indexed.value : { error: indexed.error };
      }
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, changedPaths, modules, index });
    }

    const diff = await git.diff(this.actor, workspaceId, { maxBytes: boundedInteger(input.maxBytes, 64_000, 1_000, 4 * 1024 * 1024) }, signal);
    if (!diff.ok) return diff;
    const history = await git.log(this.actor, workspaceId, { maxCommits: boundedInteger(input.maxCommits, 20, 1, 100) }, signal);
    if (!history.ok) return history;
    return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, gitStatus: status.value, diff: diff.value, history: history.value });
  }

  private async testInsight(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${name} requires workspaceId`));

    if (name === 'discover_tests') {
      if (this.services.workspaceIndex !== undefined) {
        const indexed = await this.services.workspaceIndex.status(workspaceId);
        if (!indexed.ok) return indexed;
        const tests = (indexed.value.snapshot?.entries ?? []).filter((entry) => entry.isTest).map((entry) => ({ path: entry.relativePath, language: entry.language, symbols: entry.symbols }));
        return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, source: 'workspace-index', tests });
      }
      if (this.services.search !== undefined) {
        const searched = await this.services.search.searchFiles(this.actor, workspaceId, { glob: '**/*{test,spec}*', maxResults: 500, discovery: 'explicit' }, signal);
        return searched.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, source: 'search-files', tests: searched.value }) : searched;
      }
      return ok(truthfulUnavailable(name, 'needs_setup', ['workspace index or search service']));
    }

    if (name === 'coverage_context') {
      if (this.services.search === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['search service', 'project coverage artifacts']));
      const coverage = await this.services.search.searchFiles(this.actor, workspaceId, { glob: '**/coverage*', maxResults: 200, discovery: 'explicit' }, signal);
      return coverage.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, artifacts: coverage.value }) : coverage;
    }

    if (this.services.process === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['managed process service']));
    const processes = await this.services.process.list(this.actor, workspaceId);
    if (!processes.ok) return processes;
    return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, processHistory: processes.value, interpretation: name === 'test_failures' ? 'Inspect non-zero completed project test processes and their logs.' : 'Managed project-process history.' });
  }

  private async runAffectedTests(input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'run_affected_tests requires workspaceId'));
    const processService = this.services.process;
    if (processService === undefined) return ok(truthfulUnavailable('run_affected_tests', 'needs_setup', ['managed process service', 'detected project test command']));
    const preview = await processService.previewProjectCommand(workspaceId, 'test');
    if (!preview.ok) return preview;
    const dryRun = input.dryRun !== false && input.dry_run !== false;
    if (dryRun) return ok({ tool: 'run_affected_tests', status: 'ready', available: true, ready: true, executed: true, started: false, dryRun: true, command: preview.value, selection: 'project test command; project runner may apply its own affected-test selection' });
    const started = await processService.startProjectCommand(this.actor, workspaceId, 'test', signal, input.userConfirmed === true, preview.value, authorization);
    return started.ok ? ok({ tool: 'run_affected_tests', status: 'ready', available: true, ready: true, executed: true, started: true, process: started.value }) : started;
  }

  private async browserInsight(name: string, input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (name === 'network_context') return ok(truthfulUnavailable(name, 'needs_setup', ['CDP network event subscription and retained event stream']));
    if (name === 'console_context') return ok(truthfulUnavailable(name, 'needs_setup', ['CDP Runtime/Log event subscription and retained event stream']));
    if (capabilities === undefined) return ok(truthfulUnavailable(name, 'needs_setup', ['DOM/CDP capability']));
    const target = requireBrowserTabId(name, input);
    if (!target.ok) return target;
    const tabId = target.value;
    const invoke = (action: string, parameters: Record<string, unknown> = {}): Promise<Result<unknown>> => capabilities.execute('dom_cdp', { action, parameters, tab_id: tabId }, signal, authorization);
    const status = await invoke('status');
    if (!status.ok) return status;
    if (browserRuntimeNeedsStart(status.value)) {
      return ok({
        tool: name,
        status: 'needs_setup',
        readinessReason: 'runtime_not_ready',
        deliveryState: 'operational',
        available: true,
        ready: false,
        executed: false,
        requirements: ['Start the lnwjud managed browser before using browser context tools.'],
        runtimeStatus: status.value,
      });
    }

    if (name === 'form_context') {
      const selector = readString(input, 'selector') ?? 'form, input, select, textarea, button';
      const form = await invoke('query', { selector });
      return form.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, selector, form: form.value }) : form;
    }

    const tabs = await invoke('list_tabs');
    if (!tabs.ok) return tabs;
    const body = await invoke('query', { selector: readString(input, 'selector') ?? 'body' });
    if (!body.ok) return body;
    if (name === 'inspect_web_app') return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, backendStatus: status.value, tabs: tabs.value, body: body.value });
    if (name === 'debug_ui') return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, tabs: tabs.value, body: body.value, diagnostics: ['DOM query', 'tab metadata'] });
    if (name === 'capture_ui_state') {
      const screenshot = await invoke('screenshot');
      return screenshot.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, tabs: tabs.value, body: body.value, screenshot: screenshot.value }) : screenshot;
    }
    const screenshot = await invoke('screenshot');
    return screenshot.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, tabs: tabs.value, body: body.value, screenshot: screenshot.value, unavailableStreams: ['console', 'network'] }) : screenshot;
  }

  private async visualInsight(name: string, input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (name === 'compare_screenshot') {
      const baseline = readString(input, 'baseline_base64') ?? readString(input, 'left_base64');
      const actual = readString(input, 'actual_base64') ?? readString(input, 'right_base64');
      if (baseline === undefined || actual === undefined) return err(appError('INVALID_INPUT', 'compare_screenshot requires baseline_base64/actual_base64 or left_base64/right_base64'));
      const baselineHash = createHash('sha256').update(baseline).digest('hex');
      const actualHash = createHash('sha256').update(actual).digest('hex');
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, equal: baselineHash === actualHash, baseline: { sha256: baselineHash, encodedBytes: Buffer.byteLength(baseline, 'utf8') }, actual: { sha256: actualHash, encodedBytes: Buffer.byteLength(actual, 'utf8') }, comparison: 'exact artifact identity; pixel-diff renderer remains optional' });
    }
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return ok({ tool: name, status: 'optional', available: false, ready: false, executed: false, requirements: ['DOM/CDP capability'] });
    const target = requireBrowserTabId(name, input);
    if (!target.ok) return target;
    const tabId = target.value;
    const invoke = (action: string, parameters: Record<string, unknown> = {}): Promise<Result<unknown>> => capabilities.execute('dom_cdp', { action, parameters, tab_id: tabId }, signal, authorization);
    if (name === 'capture_screenshot') {
      const screenshot = await invoke('screenshot');
      return screenshot.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, screenshot: screenshot.value }) : screenshot;
    }
    const dom = await invoke('query', { selector: readString(input, 'selector') ?? (name === 'dom_snapshot' ? 'html' : 'body') });
    if (!dom.ok) return dom;
    if (name === 'dom_snapshot') return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, snapshot: dom.value, bounded: true });
    if (name === 'layout_metadata') return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, layout: dom.value });
    const screenshot = await invoke('screenshot');
    return screenshot.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, dom: dom.value, screenshot: screenshot.value }) : screenshot;
  }

  private async windowsInsight(name: string, input: Record<string, unknown>, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (process.platform !== 'win32') return ok(truthfulUnavailable(name, 'unsupported', ['Windows host']));

    if (name === 'windows_environment') {
      let systemInfo: unknown = null;
      if (this.services.capabilities !== undefined) {
        const info = await this.services.capabilities.execute('system_info', { operation: 'all' }, signal, authorization);
        systemInfo = info.ok ? info.value : { error: info.error };
      }
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), node: process.version, cwd: process.cwd(), systemInfo });
    }
    if (name === 'process_context') {
      if (this.services.capabilities !== undefined) {
        const processes = await this.services.capabilities.execute('system_info', { operation: 'processes', top_count: boundedInteger(input.top_count, 50, 1, 500) }, signal, authorization);
        return processes.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, processes: processes.value }) : processes;
      }
      const processes = await runBoundedProcess('tasklist.exe', ['/FO', 'CSV', '/NH'], signal);
      return processes.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, processes: processes.value.stdout }) : processes;
    }
    if (name === 'service_context') {
      const serviceName = readString(input, 'service') ?? readString(input, 'name');
      const result = await runBoundedProcess('sc.exe', serviceName === undefined ? ['query', 'state=', 'all'] : ['query', serviceName], signal);
      return result.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, service: serviceName ?? null, output: result.value.stdout }) : result;
    }
    if (name === 'port_context') {
      const result = await runBoundedProcess('netstat.exe', ['-ano', '-p', 'tcp'], signal);
      if (!result.ok) return result;
      const listening = result.value.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\bLISTENING\b/i.test(line)).slice(0, 1000);
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, listening });
    }
    if (name === 'registry_context') {
      const key = readString(input, 'key') ?? 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
      if (!/^(HKCU|HKLM)\\[A-Za-z0-9 _.,{}()\-\\]+$/i.test(key)) return err(appError('PERMISSION_DENIED', 'registry_context only allows read-only HKCU/HKLM key paths with safe characters'));
      const result = await runBoundedProcess('reg.exe', ['query', key], signal);
      return result.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, key, output: result.value.stdout }) : result;
    }
    if (name === 'event_log_context') {
      const event = await this.eventLog.execute({ operation: 'query', log_name: readString(input, 'log_name') ?? 'Application', ...(readString(input, 'provider') === undefined ? {} : { provider: readString(input, 'provider') }), max_events: boundedInteger(input.max_events, 100, 1, 500) }, signal);
      return event.ok ? ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, eventLog: event.value }) : event;
    }
    if (name === 'installed_runtime_context') {
      const checks: readonly [string, string, readonly string[]][] = [
        ['node', 'node.exe', ['--version']], ['npm', 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd --version']], ['corepack', 'cmd.exe', ['/d', '/s', '/c', 'corepack.cmd --version']],
        ['git', 'git.exe', ['--version']], ['python', 'python.exe', ['--version']], ['pwsh', 'pwsh.exe', ['--version']],
      ];
      const runtimes: Record<string, unknown>[] = [];
      for (const [runtime, executable, args] of checks) {
        const result = await runBoundedProcess(executable, args, signal, 5_000, 64 * 1024);
        runtimes.push(result.ok ? { runtime, available: true, version: result.value.stdout.trim() } : { runtime, available: false });
      }
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, runtimes });
    }
    if (name === 'path_context') {
      const pathValue = process.env.Path ?? process.env.PATH ?? '';
      const entries = pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
      const executable = readString(input, 'executable');
      if (executable === undefined) return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, entries });
      if (!/^[A-Za-z0-9_.-]+$/.test(executable)) return err(appError('INVALID_INPUT', 'path_context executable must be a simple executable name'));
      const found = await runBoundedProcess('where.exe', [executable], signal, 5_000, 64 * 1024);
      return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, entries, executable, matches: found.ok ? found.value.stdout.split(/\r?\n/).filter(Boolean) : [] });
    }
    const userStartup = await runBoundedProcess('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], signal);
    const machineStartup = await runBoundedProcess('reg.exe', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], signal);
    return ok({ tool: name, status: 'ready', available: true, ready: true, executed: true, user: userStartup.ok ? userStartup.value.stdout : null, machine: machineStartup.ok ? machineStartup.value.stdout : null, errors: [userStartup.ok ? null : userStartup.error.message, machineStartup.ok ? null : machineStartup.error.message].filter(Boolean) });
  }

  private actorForOperation(): FileActor {
    return this.actor;
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.stateStore === undefined) return;
    try {
      const state = await this.stateStore.load();
      this.replaceSessionState(state.session);
      this.replaceSharedState(state.shared);
    } catch {
      // Optional runtime persistence must not prevent tools from operating.
    }
  }

  private replaceSessionState(state: UpgradeRuntimeSessionState): void {
    this.tasks.clear();
    this.checkpoints.splice(0);
    this.session.clear();
    for (const task of state.tasks) if (isRuntimeTask(task)) this.tasks.set(task.id, { ...task });
    for (const checkpoint of state.checkpoints) if (isCheckpoint(checkpoint)) this.checkpoints.push(checkpoint);
    for (const pair of state.session) this.session.set(pair[0], pair[1]);
  }

  private replaceSharedState(state: UpgradeRuntimeSharedState): void {
    this.plugins.clear();
    this.worktrees.splice(0);
    for (const plugin of state.plugins) if (isPlugin(plugin)) this.plugins.set(plugin.name, { ...plugin });
    for (const worktree of state.worktrees) if (isWorktreeLedgerEntry(worktree)) this.worktrees.push(worktree);
  }

  private async refreshSharedState(): Promise<boolean> {
    if (this.stateStore === undefined) return false;
    try {
      this.replaceSharedState(await this.stateStore.readShared());
      return true;
    } catch {
      // Keep the last known in-memory shared state when persistence is unavailable.
      return false;
    }
  }

  private async mutateSharedState(
    mutate: (plugins: Map<string, { readonly name: string; enabled: boolean }>, worktrees: WorktreeLedgerEntry[]) => void,
    failClosed = false,
  ): Promise<boolean> {
    if (this.stateStore === undefined) {
      if (failClosed) return false;
      mutate(this.plugins, this.worktrees);
      return true;
    }
    try {
      const next = await this.stateStore.updateShared((current) => {
        const plugins = new Map<string, { readonly name: string; enabled: boolean }>();
        const worktrees: WorktreeLedgerEntry[] = [];
        for (const plugin of current.plugins) if (isPlugin(plugin)) plugins.set(plugin.name, { ...plugin });
        for (const worktree of current.worktrees) if (isWorktreeLedgerEntry(worktree)) worktrees.push(worktree);
        mutate(plugins, worktrees);
        return { plugins: [...plugins.values()], worktrees };
      });
      this.replaceSharedState(next);
      return true;
    } catch {
      if (!failClosed) mutate(this.plugins, this.worktrees);
      return false;
    }
  }

  private async persistState(): Promise<boolean> {
    if (this.stateStore === undefined) return true;
    try {
      const merged = await this.stateStore.updateSession((current) => {
        const tasks = new Map<string, RuntimeTask>();
        for (const task of current.tasks) if (isRuntimeTask(task)) tasks.set(task.id, { ...task });
        for (const task of this.tasks.values()) tasks.set(task.id, { ...task });
        const checkpoints = new Map<string, SessionCheckpoint>();
        for (const checkpoint of current.checkpoints) if (isCheckpoint(checkpoint)) checkpoints.set(checkpoint.id, checkpoint);
        for (const checkpoint of this.checkpoints) checkpoints.set(checkpoint.id, checkpoint);
        const session = new Map<string, unknown>();
        for (const pair of current.session) session.set(pair[0], pair[1]);
        for (const [key, value] of this.session) session.set(key, value);
        return { tasks: [...tasks.values()], checkpoints: [...checkpoints.values()], session: [...session.entries()] };
      });
      this.replaceSessionState(merged);
      return true;
    } catch {
      // Most upgrade-runtime persistence is optional, but callers such as
      // session_checkpoint can fail closed when durable state is the operation.
      return false;
    }
  }

}

function runBoundedProcess(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = 15_000,
  maxBytes = 1024 * 1024,
): Promise<Result<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(err(appError('PROCESS_TIMEOUT', `${executable} query was cancelled`, true)));
      return;
    }
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { windowsHide: true, shell: false });
    } catch {
      resolve(err(appError('PROCESS_NOT_FOUND', `${executable} could not be started`, true)));
      return;
    }
    const finish = (result: Result<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, 'utf8') >= maxBytes) return current;
      const remaining = maxBytes - Buffer.byteLength(current, 'utf8');
      return current + chunk.subarray(0, remaining).toString('utf8');
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', `${executable} query timed out`, true)));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', `${executable} query was cancelled`, true)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', () => finish(err(appError('PROCESS_NOT_FOUND', `${executable} is unavailable`, true))));
    child.once('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        finish(err(appError('INTERNAL_ERROR', `${executable} query failed with exit code ${exitCode}`, true)));
        return;
      }
      finish(ok({ exitCode, stdout, stderr }));
    });
    child.stdin?.end();
  });
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRegisteredToolSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.version === 'string'
    && Array.isArray(value.permissions)
    && isRecord(value.schema);
}

function isBenchmarkRunRecord(value: unknown): value is {
  readonly id: string;
  readonly workspaceId: string;
  readonly processId: string;
  readonly scenario: string;
  readonly command: Record<string, unknown>;
  readonly startedAt: string;
} {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.workspaceId === 'string'
    && typeof value.processId === 'string'
    && typeof value.scenario === 'string'
    && isRecord(value.command)
    && typeof value.startedAt === 'string';
}

function parseSkillDescriptor(content: string): Result<{ readonly name: string; readonly description: string }> {
  const normalized = content.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return err(appError('INVALID_INPUT', 'SKILL.md must begin with YAML frontmatter'));
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return err(appError('INVALID_INPUT', 'SKILL.md frontmatter is not terminated'));
  const frontmatter = normalized.slice(4, end);
  let name: string | undefined;
  let description: string | undefined;
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name') name = value;
    if (key === 'description') description = value;
  }
  if (name === undefined || name.length === 0) return err(appError('INVALID_INPUT', 'SKILL.md frontmatter requires name'));
  if (description === undefined || description.length === 0) return err(appError('INVALID_INPUT', 'SKILL.md frontmatter requires description'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return err(appError('INVALID_INPUT', 'SKILL.md name is not a safe skill identifier'));
  if (description.length > 2_048) return err(appError('INVALID_INPUT', 'SKILL.md description exceeds 2048 characters'));
  return ok({ name, description });
}

function semanticMajor(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : -1;
}

function normalizePermission(value: string | undefined): UpgradeToolCatalogEntry['permission'] {
  return value === 'READ' || value === 'WRITE' || value === 'EXECUTE' || value === 'DANGEROUS' ? value : 'READ';
}

function validateProjectProfile(profile: Record<string, unknown>): Result<Record<string, unknown>> {
  try {
    const normalized = normalizeProjectProfileValue(profile, 0) as Record<string, unknown>;
    return ok(normalized);
  } catch (error: unknown) {
    return err(appError('INVALID_INPUT', error instanceof Error ? error.message : 'Project profile is invalid'));
  }
}

function normalizeProjectProfileValue(value: unknown, depth: number): unknown {
  if (depth > 8) throw new Error('Project profile nesting exceeds 8 levels');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > 16_384) throw new Error('Project profile string values are too large');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Project profile numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error('Project profile arrays may contain at most 256 items');
    return value.map((entry) => normalizeProjectProfileValue(entry, depth + 1));
  }
  if (!isRecord(value)) throw new Error('Project profile values must be JSON-compatible');
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error('Project profile objects may contain at most 256 keys');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 128) throw new Error('Project profile keys must be 1-128 characters');
    if (/(token|secret|password|api[_-]?key|private[_-]?key|authorization|credential)/i.test(key)) {
      throw new Error(`Project profile must not persist secret-bearing field: ${key}`);
    }
    result[key] = normalizeProjectProfileValue(entry, depth + 1);
  }
  return result;
}

function requireBrowserTabId(toolName: string, input: Record<string, unknown>): Result<string> {
  const tabId = readString(input, 'tab_id') ?? readString(input, 'tabId');
  if (tabId === undefined || tabId.trim().length === 0) {
    return err(appError('INVALID_INPUT', `${toolName} requires tab_id; call dom_cdp list_tabs or new_tab first`));
  }
  return ok(tabId.trim());
}

function browserRuntimeNeedsStart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = value as Readonly<Record<string, unknown>>;
  return status.ready === false || status.browserRunning === false;
}

function digest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function summarize(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
}

function hitRate(cache: CacheCounters): number {
  const total = cache.hits + cache.misses;
  return total === 0 ? 0 : Number((cache.hits / total).toFixed(4));
}

function publicTask(task: RuntimeTask): Omit<RuntimeTask, 'result'> & { readonly result?: unknown } {
  return { ...task };
}

function countKinds(entries: readonly { readonly kind: string }[]): Record<string, number> {
  return entries.reduce<Record<string, number>>((counts, entry) => { counts[entry.kind] = (counts[entry.kind] ?? 0) + 1; return counts; }, {});
}

function normalizeMode(value: string | undefined): 'compact' | 'normal' | 'verbose' | 'stream' {
  return value === 'compact' || value === 'verbose' || value === 'stream' ? value : 'normal';
}

function lifecycleEvents(): readonly string[] {
  return ['beforeTool', 'afterTool', 'beforeRead', 'afterRead', 'beforeWrite', 'afterWrite', 'beforeShell', 'afterShell', 'beforeGit', 'afterGit', 'beforeBrowser', 'afterBrowser'];
}

function primitiveEntry(name: string, description: string, permission: UpgradeToolCatalogEntry['permission'], tags: readonly string[]): SearchCatalogEntry {
  return { name, phase: 0, description, permission, tags, deliveryState: 'operational', parallelSafe: permission === 'READ', primitive: true };
}

function capabilitySearchEntry(descriptor: CapabilityDescriptor): SearchCatalogEntry {
  return {
    name: descriptor.name,
    phase: 0,
    description: `${descriptor.name} local capability (${descriptor.auditTarget})`,
    permission: descriptor.permission,
    tags: [descriptor.name, descriptor.auditTarget, 'capability'],
    deliveryState: 'operational',
    parallelSafe: descriptor.permission === 'READ',
    primitive: true,
    auditTarget: descriptor.auditTarget,
  };
}

function dedupeSearchEntries(entries: readonly SearchCatalogEntry[]): readonly SearchCatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

function scoreToolEntry(entry: SearchCatalogEntry, query: string, route: ReturnType<typeof routeIntent>): { readonly entry: SearchCatalogEntry; readonly score: number; readonly reasonCodes: readonly string[] } {
  if (query.length === 0) return { entry, score: 0, reasonCodes: ['empty-query'] };
  const queryTokens = tokenize(query);
  const nameTokens = tokenize(entry.name);
  const tagTokens = entry.tags.flatMap((tag) => tokenize(tag));
  const description = entry.description.toLowerCase();
  let score = 0;
  const reasons = new Set<string>();
  if (entry.name.toLowerCase() === query) {
    score += 2;
    reasons.add('exact-name');
  }
  if (entry.name.toLowerCase().includes(query)) {
    score += 1;
    reasons.add('name-phrase');
  }
  for (const token of queryTokens) {
    if (nameTokens.includes(token)) {
      score += 1;
      reasons.add(`name-token:${token}`);
    } else if (tagTokens.includes(token)) {
      score += 0.8;
      reasons.add(`tag-token:${token}`);
    } else if (description.includes(token)) {
      score += 0.25;
      reasons.add(`description-token:${token}`);
    }
  }
  if (route.route !== 'workspace' && entry.tags.some((tag) => route.route === tag || route.domain.split('/').some((part) => tag === part))) {
    score += 0.5;
    reasons.add(`route:${route.route}`);
  }
  if (entry.primitive === true) {
    score += 0.25;
    reasons.add('primitive-visible');
  }
  return { entry, score, reasonCodes: [...reasons] };
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9ก-๙]+/u)
    .filter((token) => token.length > 0);
}

async function readJsonlTail(filePath: string, maxBytes: number): Promise<readonly string[]> {
  const info = await stat(filePath);
  if (info.size === 0) return [];
  const bytesToRead = Math.min(info.size, maxBytes);
  const position = Math.max(0, info.size - bytesToRead);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (position > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function contractStatus(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const entry = UPGRADE_TOOL_CATALOG.find((candidate) => candidate.name === name);
  const status = entry?.availability ?? 'ready';
  return {
    tool: name,
    status,
    available: status === 'ready',
    ready: status === 'ready',
    phase: entry?.phase ?? null,
    ...(entry?.requirements === undefined ? {} : { requirements: entry.requirements }),
    supportsCancel: entry?.supportsCancel === true,
    supportsDryRun: entry?.supportsDryRun === true,
    ...(entry?.auditTarget === undefined ? {} : { auditTarget: entry.auditTarget }),
    executed: false,
    primitiveFallbacks: ['read_file', 'search_text', 'workspace_tree'],
    inputKeys: Object.keys(input).sort(),
    authorizationUnchanged: true,
  };
}

function routeIntent(prompt: string): {
  readonly route: string;
  readonly domain: string;
  readonly confidence: 'high' | 'medium';
  readonly selectedModel: 'deterministic';
  readonly reasonCodes: readonly string[];
  readonly authorizationUnchanged: true;
} {
  const normalized = prompt.toLowerCase();
  const rules: readonly { readonly route: string; readonly domain: string; readonly confidence: 'high' | 'medium'; readonly terms: readonly (readonly [string, string])[] }[] = [
    { route: 'debug', domain: 'desktop/mcp/logging', confidence: 'high' as const, terms: [['live log', 'live-logs'], ['mcp activity', 'mcp'], ['tunnel', 'tunnel'], ['stdio', 'stdio'], ['connect', 'connect'], ['debug', 'debug'], ['wsl', 'wsl'], ['timeout', 'timeout'], ['crash', 'crash']] },
    { route: 'test', domain: 'project/tests', confidence: 'high' as const, terms: [['test', 'test'], ['vitest', 'vitest'], ['jest', 'jest'], ['playwright', 'playwright'], ['pytest', 'pytest']] },
    { route: 'review', domain: 'git/code', confidence: 'high' as const, terms: [['review', 'review'], ['diff', 'diff'], ['pull request', 'pull-request'], ['changed', 'changed']] },
    { route: 'frontend', domain: 'browser/ui', confidence: 'medium' as const, terms: [['browser', 'browser'], ['ui', 'ui'], ['button', 'button'], ['dom', 'dom'], ['screenshot', 'screenshot']] },
    { route: 'release', domain: 'git/release', confidence: 'medium' as const, terms: [['release', 'release'], ['tag', 'tag'], ['publish', 'publish'], ['deploy', 'deploy']] },
  ];
  const scored = rules.map((rule, index) => ({
    ...rule,
    matches: rule.terms.filter(([term]) => normalized.includes(term)),
    index,
  })).filter((rule) => rule.matches.length > 0);
  const selected = scored.sort((left, right) => right.matches.length - left.matches.length || left.index - right.index)[0];
  if (selected === undefined) {
    return { route: 'workspace', domain: 'workspace/code', confidence: 'medium', selectedModel: 'deterministic', reasonCodes: ['fallback:workspace'], authorizationUnchanged: true };
  }
  return {
    route: selected.route,
    domain: selected.domain,
    confidence: selected.confidence,
    selectedModel: 'deterministic',
    reasonCodes: selected.matches.map(([, reason]) => `keyword:${reason}`),
    authorizationUnchanged: true,
  };
}

function recipeCatalog(): readonly { readonly name: string; readonly steps: readonly string[]; readonly optional: boolean }[] {
  return [
    { name: 'bugfix', steps: ['workspace_context', 'git_context', 'test_context', 'live_logs_query'], optional: false },
    { name: 'code-review', steps: ['review_context', 'changed_symbols', 'discover_tests'], optional: false },
    { name: 'frontend-debug', steps: ['debug_ui', 'console_context', 'network_context', 'capture_ui_state'], optional: true },
    { name: 'release-check', steps: ['git_context', 'regression_report', 'benchmark_run'], optional: false },
  ];
}

function planFor(prompt: string): { readonly route: string; readonly operations: readonly string[]; readonly permissions: readonly string[] } {
  const route = routeIntent(prompt);
  const operations = route.route === 'debug'
    ? ['workspace_context', 'git_context', 'live_logs_query', 'test_context']
    : route.route === 'test'
      ? ['workspace_context', 'discover_tests', 'test_context']
      : route.route === 'review'
        ? ['git_context', 'review_changes', 'changed_symbols', 'discover_tests']
        : ['workspace_context', 'repo_map'];
  return { route: route.route, operations, permissions: ['filesystem.read', 'git.read'] };
}

function permissionDecision(action: string): { readonly action: string; readonly decision: 'allow' | 'ask'; readonly class: string; readonly contextAccess: 'unrestricted' } {
  const normalized = action.toLowerCase();
  const dangerousAction = /(delete|destructive|admin|system\.admin|shell\.destructive|git\.destructive)/.test(normalized);
  return { action, decision: dangerousAction ? 'ask' : 'allow', class: dangerousAction ? 'dangerous' : 'read-or-safe', contextAccess: 'unrestricted' };
}

function actorSessionId(actor: FileActor): string {
  return actor.sessionId?.trim() || actor.clientId;
}

function runtimeOwnerKey(actor: FileActor): string {
  return `${actor.clientId}\u0000${actorSessionId(actor)}`;
}

function isWorktreeLedgerEntry(value: unknown): value is WorktreeLedgerEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceId === 'string'
    && typeof record.worktreePath === 'string'
    && typeof record.ref === 'string'
    && typeof record.owner === 'string'
    && (record.ownerSessionId === undefined || typeof record.ownerSessionId === 'string')
    && typeof record.createdAt === 'string';
}

function isRuntimeTask(value: unknown): value is RuntimeTask {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && (record.kind === 'task' || record.kind === 'delegate') && typeof record.createdAt === 'string' && typeof record.inputDigest === 'string' && (record.state === 'queued' || record.state === 'running' || record.state === 'completed' || record.state === 'cancelled');
}

function isCheckpoint(value: unknown): value is SessionCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.createdAt === 'string' && typeof record.summary === 'string' && typeof record.inputDigest === 'string';
}

function isPlugin(value: unknown): value is { readonly name: string; readonly enabled: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.enabled === 'boolean';
}

export function upgradeCatalogByName(name: string): UpgradeToolCatalogEntry | undefined {
  return UPGRADE_TOOL_CATALOG.find((entry) => entry.name === name);
}
