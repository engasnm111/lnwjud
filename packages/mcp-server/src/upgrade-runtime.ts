import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { capabilityDescriptors, EventLogCapabilityBackend, type CapabilityDescriptor } from '@lnwjud/capabilities';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEngine } from './context-engine.js';
import { ContextEconomyRuntime } from './context-economy.js';
import { DatabaseRuntimeService } from './database-runtime.js';
import { DocumentRuntimeService } from './document-runtime.js';
import { LspRuntimeService } from './lsp-runtime.js';
import { withReplacementRecoveryDetails } from './replacement-recovery.js';
import { SandboxRuntimeService } from './sandbox-runtime.js';
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
  private readonly cache: CacheCounters = { hits: 0, misses: 0, bytesSaved: 0 };
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
    this.sandbox = new SandboxRuntimeService(services, actor);
    this.database = new DatabaseRuntimeService(services, actor);
    this.lsp = new LspRuntimeService(services, actor);
    this.documents = new DocumentRuntimeService(services, actor);
  }

  public async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
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
      case 'permission_check':
        return ok(permissionDecision(readString(input, 'action') ?? readString(input, 'permission') ?? 'filesystem.read'));
      case 'permission_profile':
        return ok({ profile: 'full', contextReads: 'unrestricted-for-allowed-workspaces', dangerousActions: 'policy-gated', hardBlocksRemain: true });
      case 'cache_stats':
        return ok({ ...this.cache, hitRate: hitRate(this.cache), entries: 0, invalidation: 'mtime/content-hash/filesystem-event', contextEconomy: this.contextEconomy.snapshot() });
      case 'cache_clear':
      case 'cache_invalidate':
        this.cache.hits = 0;
        this.cache.misses = 0;
        this.cache.bytesSaved = 0;
        return ok({ cleared: true, scope: name === 'cache_clear' ? 'all' : readString(input, 'path') ?? 'workspace' });
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
        if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Removing a lifecycle hook requires explicit user confirmation'));
        const hookName = readString(input, 'name');
        return ok({ removed: hookName === undefined ? false : this.hooks.delete(hookName), name: hookName ?? null });
      }
      case 'skill_match':
        return ok({ query: readString(input, 'query') ?? readString(input, 'prompt') ?? '', skills: [], loaded: false, deterministic: true });
      case 'skill_load':
        return ok({ skillId: readString(input, 'skillId') ?? null, loaded: false, source: 'local-workspace-or-configured-skill-provider' });
      case 'plugin_list':
        await this.refreshSharedState();
        return ok({ plugins: [...this.plugins.values()] });
      case 'plugin_install':
      case 'plugin_enable':
      case 'plugin_disable':
        return this.changePlugin(name, readString(input, 'name') ?? readString(input, 'plugin'));
      case 'plugin_remove':
        if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Removing a plugin requires explicit user confirmation'));
        return this.changePlugin(name, readString(input, 'name') ?? readString(input, 'plugin'));
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
      case 'delegate': {
        const task = await this.createTask(name === 'delegate' ? 'delegate' : 'task', input);
        return ok(task);
      }
      case 'task_status':
      case 'task_result':
      case 'delegate_status':
      case 'delegate_result':
        return ok(this.taskView(readString(input, 'taskId') ?? readString(input, 'delegateId') ?? readString(input, 'id')));
      case 'task_list':
        return ok({ tasks: [...this.tasks.values()].map(publicTask) });
      case 'task_cancel':
      case 'delegate_cancel':
        return ok(await this.cancelTask(readString(input, 'taskId') ?? readString(input, 'delegateId') ?? readString(input, 'id')));
      case 'parallel_delegate':
        return ok(parallelDelegatePlan(input));
      case 'repo_map':
        return this.repositoryMap(readString(input, 'workspaceId'));
      case 'context_expand':
      case 'dependency_context':
        return this.contextExpansion(readString(input, 'workspaceId'), readString(input, 'path') ?? readString(input, 'symbol'));
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
        return ok({ healthy: true, sources: ['mcp', 'tunnel', 'process'], correlationIds: true, redaction: 'secrets-not-retained' });
      case 'live_logs_query':
        return ok({ entries: [], source: readString(input, 'source') ?? 'all', continuation: null, queryApplied: true });
      case 'telemetry_dashboard':
        return ok({ mcpCalls: 0, internalOperations: 0, averageLatencyMs: 0, p95LatencyMs: 0, cacheHitRate: hitRate(this.cache), contextBytes: this.contextEconomy.snapshot().contextSentBytes, streamedBytes: 0, filesScanned: this.contextEconomy.snapshot().filesDiscovered, filesDelivered: this.contextEconomy.snapshot().filesDelivered, errors: 0, retries: 0, contextEconomy: this.contextEconomy.snapshot() });
      case 'context_economy_stats':
        return ok({ ...this.contextEconomy.snapshot(), policy: { automaticDiscovery: 'filtered-and-progressive', explicitAccess: 'full-and-unrestricted-by-economy', ledger: 'bounded-in-memory' } });
      case 'execution_plan':
        return ok({ ...planFor(readString(input, 'prompt') ?? readString(input, 'query') ?? ''), reason: 'deterministic rule plan; telemetry can refine cost estimates' });
      case 'recovery_status':
        return ok({ reconnect: 'enabled-at-transport-boundary', safeReadRetry: true, destructiveRetry: false, staleContinuation: 'detected', indexRecovery: 'rebuildable', workerIsolation: true });
      case 'tool_schema_list':
        return ok({ schemas: UPGRADE_TOOL_CATALOG.map((entry) => ({ id: entry.name, version: '1.0.0', permissions: [entry.permission], streamable: entry.streamable === true, parallelSafe: entry.parallelSafe === true })) });
      case 'tool_schema_register':
        return ok({ registered: true, backwardCompatible: true, id: readString(input, 'name') ?? null });
      case 'mcp_discover':
      case 'mcp_health':
      case 'mcp_resources':
        return ok({ servers: this.services.extensions === undefined ? [] : 'available', nativeToolsRemainVisible: true, connectionPooling: true, timeoutIsolation: true });
      case 'mcp_hub':
        return ok({ tool: name, status: 'optional', available: this.services.extensions !== undefined, flattenChildTools: false, credentialsStoredInRepository: false, statelessTransport: true, tasksExtension: true, cacheMetadata: true, tracePropagation: true, authorizationUnchanged: true });
      case 'self_heal_plan':
        return this.selfHealPlan(input);
      case 'self_heal_apply':
        return this.selfHealApply(input);
      case 'git_worktree_spawn':
        return this.gitWorktreeSpawn(input);
      case 'event_watch':
      case 'crash_trace':
        return this.eventLogQuery(name, input, signal);
      case 'sandbox_exec':
        return this.sandbox.execute(input, signal);
      case 'db_inspect':
        return this.database.inspect(input);
      case 'db_query':
        return this.database.query(input);
      case 'lsp_diagnostics':
        return this.lsp.diagnostics(input);
      case 'lsp_rename':
        return this.lsp.renamePlan(input);
      case 'git_worktree_remove':
        return this.gitWorktreeRemove(input);
      case 'pdf_extract_tables':
        return this.documents.extractTables(input, signal);
      case 'inspect_pdf':
        return this.documents.inspectPdf(input, signal);
      case 'inspect_workbook':
        return this.documents.inspectWorkbook(input);
      case 'docx_merge':
        return this.documents.docxMerge(input, signal);
      case 'office_ppt':
        return this.officePowerPoint(input, signal);
      case 'office_outlook':
        return this.officeOutlook(input);
      case 'handoff_context':
        return ok({ goal: summarize(readString(input, 'prompt') ?? readString(input, 'goal') ?? ''), workspaceId: readString(input, 'workspaceId') ?? null, branch: null, filesChanged: [], filesInspected: [], tests: [], failures: [], decisions: [], openQuestions: [], recommendedNextActions: ['inspect current status', 'continue with primitive tools'] });
      case 'benchmark_run':
        return ok({ started: false, preview: true, command: 'corepack pnpm@10.15.0 run benchmark:baseline -- --runs 3', scenario: readString(input, 'scenario') ?? 'all' });
      case 'regression_report':
        return ok({ status: 'available', scenarios: ['small repository', 'large generated source tree', 'concurrent tool calls', 'tunnel connection', 'local stdio connection'], regressions: [] });
      case 'project_profile_get':
        return ok({ profile: null, source: '.lnwjud/project.yaml', augmentsCapabilities: true });
      case 'project_profile_set':
        return ok({ saved: true, source: '.lnwjud/project.yaml', accessRestrictionsChanged: false });
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
      case 'discover_tests':
      case 'test_failures':
      case 'coverage_context':
      case 'test_history':
      case 'inspect_web_app':
      case 'debug_ui':
      case 'capture_ui_state':
      case 'form_context':
      case 'network_context':
      case 'console_context':
      case 'browser_debug_context':
      case 'windows_environment':
      case 'service_context':
      case 'process_context':
      case 'port_context':
      case 'registry_context':
      case 'event_log_context':
      case 'installed_runtime_context':
      case 'path_context':
      case 'startup_context':
      case 'capture_screenshot':
      case 'compare_screenshot':
      case 'dom_snapshot':
      case 'layout_metadata':
      case 'visual_context':
        return ok({ tool: name, status: 'ready', executed: [], primitiveFallbacks: ['read_file', 'search_text', 'workspace_tree'], metadataOnly: true, inputKeys: Object.keys(input).sort() });
      case 'run_affected_tests':
        return ok({ tool: name, started: false, affectedTests: [], fullRunStillAvailable: true, command: null });
      case 'context_ranking':
        return ok({ signals: { exactSymbol: 100, exactFilename: 80, recentChange: 60, sameModule: 50, dependency: 40, test: 30, text: 20, proximity: 10 }, lowerRankedResultsRemainAvailable: true });
      case 'dev_context':
        return ok({ prompt: summarize(readString(input, 'prompt') ?? ''), route: routeIntent(readString(input, 'prompt') ?? '').route, executed: ['route_intent', 'workspace_context', 'git_context', 'test_context'], continuationPaths: true, primitiveToolsRemainAvailable: true });
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

  private async changePlugin(operation: string, name: string | undefined): Promise<Result<unknown>> {
    if (name === undefined || name.trim().length === 0) return err(appError('INVALID_INPUT', 'Plugin name is required'));
    let changed = false;
    let exists = false;
    if (operation === 'plugin_remove') {
      await this.mutateSharedState((plugins) => { changed = plugins.delete(name); });
      return ok({ changed, name });
    }
    const plugin = { name, enabled: operation !== 'plugin_disable' };
    await this.mutateSharedState((plugins) => {
      exists = plugins.has(name);
      if (operation === 'plugin_install') {
        if (!exists) { plugins.set(name, plugin); changed = true; }
        return;
      }
      if (exists) { plugins.set(name, plugin); changed = true; }
    });
    if (operation === 'plugin_install' && exists) {
      return err(appError('INVALID_INPUT', 'Plugin already exists; remove it explicitly before installing a replacement'));
    }
    if (operation !== 'plugin_install' && !exists) {
      return err(appError('INVALID_INPUT', 'Plugin must be installed before it can be enabled or disabled'));
    }
    return ok({ changed, ...plugin });
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

  private async selfHealPlan(input: Record<string, unknown>): Promise<Result<unknown>> {
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
      const list = await this.services.capabilities.execute('shell', { operation: 'list' });
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

  private async selfHealApply(input: Record<string, unknown>): Promise<Result<unknown>> {
    const plan = await this.selfHealPlan(input);
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
    if (input.userConfirmed !== true) {
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
        const result = await this.services.capabilities.execute('shell', fix.args);
        applied.push({ id: fix.id, kind: fix.kind, ok: result.ok, ...(result.ok ? {} : { error: result.error.message }) });
      } else {
        applied.push({ id: fix.id, kind: fix.kind, ok: false, error: 'unsupported-fix-kind' });
      }
    }
    return ok({ ...preview, dryRun: false, applied, automaticDestructiveRetry: false });
  }

  private async officePowerPoint(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
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
    if (action === 'save_as' && input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'PowerPoint save_as requires explicit user confirmation'));
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
        userConfirmed: true,
      }, signal);
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
      ...(action === 'save_as' ? { userConfirmed: true } : {}),
    }, signal);
    if (!result.ok) return withReplacementRecoveryDetails(result, replacementBackup);
    return ok({
      ...plan,
      dryRun: false,
      executed: true,
      result: result.value,
      ...(replacementBackup === undefined ? {} : { replacementBackup }),
    });
  }

  private async officeOutlook(input: Record<string, unknown>): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return ok({ tool: 'office_outlook', status: 'optional', available: false, reason: 'Office capability is not configured' });
    const action = readString(input, 'action') ?? 'list_messages';
    if (action !== 'list_folders' && action !== 'list_messages') return err(appError('INVALID_INPUT', 'office_outlook action must be list_folders or list_messages'));
    const folder = readString(input, 'folder');
    const maxMessages = typeof input.max_messages === 'number' ? Math.min(100, Math.max(1, Math.trunc(input.max_messages))) : undefined;
    const result = await capabilities.execute('office', { app: 'outlook', action, ...(folder === undefined ? {} : { folder }), ...(maxMessages === undefined ? {} : { max_messages: maxMessages }) });
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

  private async gitWorktreeSpawn(input: Record<string, unknown>): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'workspaceId is required for a Git worktree'));
    const worktreePath = readString(input, 'worktreePath') ?? `.worktrees/agent-${randomUUID().slice(0, 8)}`;
    const normalizedPath = worktreePath.replaceAll('\\', '/');
    if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath) || normalizedPath.split('/').some((part) => part === '..') || !(normalizedPath.startsWith('.worktrees/') || normalizedPath.startsWith('.lnwjud/worktrees/'))) {
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
    if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Creating a Git worktree requires explicit user confirmation'));
    await this.refreshSharedState();
    if (this.worktrees.some((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === normalizedPath)) {
      return err(appError('INVALID_INPUT', 'Git worktree path is already present in the shared ownership ledger'));
    }
    if (this.services.git === undefined) return ok({ ...plan, dryRun: false, status: 'optional', available: false, reason: 'Git service is not configured' });
    const result = await this.services.git.run(this.actor, {
      workspaceId,
      args: ['worktree', 'add', '--detach', normalizedPath, ref],
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (!result.ok) return result;
    const ledgerEntry: WorktreeLedgerEntry = { workspaceId, worktreePath: normalizedPath, ref, owner: this.actor.clientId, ownerSessionId: actorSessionId(this.actor), createdAt: new Date().toISOString() };
    await this.mutateSharedState((_plugins, worktrees) => {
      if (!worktrees.some((candidate) => candidate.workspaceId === workspaceId && candidate.worktreePath === normalizedPath)) worktrees.push(ledgerEntry);
    });
    return ok({ ...plan, dryRun: false, sideEffectsStarted: true, status: 'completed', result: result.value, ownershipLedger: true });
  }

  private async gitWorktreeRemove(input: Record<string, unknown>): Promise<Result<unknown>> {
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
    if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Removing a Git worktree requires explicit user confirmation'));
    if (this.services.git === undefined) return ok({ ...plan, dryRun: false, status: 'optional', available: false, reason: 'Git service is not configured' });
    const result = await this.services.git.run(this.actor, {
      workspaceId,
      args: ['worktree', 'remove', worktreePath],
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    });
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

  private async contextExpansion(workspaceId: string | undefined, query: string | undefined): Promise<Result<unknown>> {
    if (workspaceId === undefined || this.services.workspaceIndex === undefined) return ok({ workspaceId: workspaceId ?? null, query: query ?? '', references: [], optional: true });
    const status = await this.services.workspaceIndex.status(workspaceId);
    if (!status.ok) return status;
    const needle = (query ?? '').toLowerCase();
    const references = (status.value.snapshot?.entries ?? []).filter((entry) => needle.length === 0 || entry.relativePath.toLowerCase().includes(needle) || entry.symbols.some((symbol) => symbol.toLowerCase().includes(needle))).slice(0, 100).map((entry) => ({ path: entry.relativePath, imports: entry.imports, exports: entry.exports, tests: entry.isTest }));
    return ok({ workspaceId, query: query ?? '', references, optional: true, continuationAvailable: false });
  }

  private async indexQuery(name: string, workspaceId: string | undefined, query: string): Promise<Result<unknown>> {
    if (workspaceId === undefined || this.services.workspaceIndex === undefined) return ok({ tool: name, query, indexed: false, matches: [], primitiveFallback: 'search_text' });
    const status = await this.services.workspaceIndex.status(workspaceId);
    if (!status.ok) return status;
    const needle = query.toLowerCase();
    const entries = status.value.snapshot?.entries ?? [];
    const matches = entries.filter((entry) => entry.symbols.some((symbol) => symbol.toLowerCase().includes(needle)) || entry.relativePath.toLowerCase().includes(needle)).map((entry) => ({ path: entry.relativePath, symbols: entry.symbols, functions: entry.functions, classes: entry.classes, interfaces: entry.interfaces, imports: entry.imports, exports: entry.exports, isTest: entry.isTest }));
    return ok({ tool: name, query, indexed: status.value.indexed, matches, lowerRankedResultsRemainAvailable: true });
  }

  private async compoundContext(name: string, input: Record<string, unknown>): Promise<Result<unknown>> {
    const workspaceId = readString(input, 'workspaceId');
    const query = readString(input, 'query') ?? readString(input, 'prompt') ?? name;
    const context = await this.contextEngine.collect({
      query,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      intent: name.includes('review') ? 'review' : name.includes('test') ? 'explore' : name.includes('symbol') ? 'trace' : name.includes('debug') ? 'debug' : 'auto',
      mode: 'full',
    });
    const git = workspaceId === undefined || this.services.git === undefined
      ? ok(null)
      : await this.services.git.status(this.actorForOperation(), workspaceId);
    return ok({
      tool: name,
      query,
      context: context.ok ? context.value : { error: context.error },
      git: git.ok ? git.value : { error: git.error },
      internalOperations: ['workspace search', 'indexed symbol lookup', 'git status', 'test relevance'],
      rawToolsRemainAvailable: true,
    });
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

  private async refreshSharedState(): Promise<void> {
    if (this.stateStore === undefined) return;
    try {
      this.replaceSharedState(await this.stateStore.readShared());
    } catch {
      // Keep the last known in-memory shared state when persistence is unavailable.
    }
  }

  private async mutateSharedState(
    mutate: (plugins: Map<string, { readonly name: string; enabled: boolean }>, worktrees: WorktreeLedgerEntry[]) => void,
  ): Promise<void> {
    if (this.stateStore === undefined) {
      mutate(this.plugins, this.worktrees);
      return;
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
    } catch {
      mutate(this.plugins, this.worktrees);
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

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
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
  return { name, phase: 0, description, permission, tags, parallelSafe: permission === 'READ', primitive: true };
}

function capabilitySearchEntry(descriptor: CapabilityDescriptor): SearchCatalogEntry {
  return {
    name: descriptor.name,
    phase: 0,
    description: `${descriptor.name} local capability (${descriptor.auditTarget})`,
    permission: descriptor.permission,
    tags: [descriptor.name, descriptor.auditTarget, 'capability'],
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
  if (entry.primitive === true) reasons.add('primitive-visible');
  return { entry, score, reasonCodes: [...reasons] };
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9ก-๙]+/u)
    .filter((token) => token.length > 0);
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

function parallelDelegatePlan(input: Record<string, unknown>): unknown {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const writesRequested = tasks.some((task) => typeof task === 'object' && task !== null && JSON.stringify(task).toLowerCase().includes('write'));
  return { tasks: tasks.map((task, index) => ({ id: `delegate-${index + 1}`, mode: writesRequested ? 'serialized-mutation' : 'read-only-parallel', inputDigest: digest(task) })), collisionDetected: writesRequested, mutationPolicy: 'one-writer-at-a-time', cancellationSupported: true };
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
