import type { McpPermissionLevel } from './tools/tool-types.js';
import type { ToolDeliveryState } from './tool-delivery-contract.js';

export interface UpgradeToolCatalogEntry {
  readonly name: string;
  readonly phase: number;
  readonly description: string;
  readonly permission: McpPermissionLevel;
  readonly tags: readonly string[];
  readonly deliveryState: ToolDeliveryState;
  readonly streamable?: boolean;
  readonly parallelSafe?: boolean;
  readonly availability?: 'ready' | 'optional' | 'planned' | 'unavailable';
  readonly requirements?: readonly string[];
  readonly supportsCancel?: boolean;
  readonly supportsDryRun?: boolean;
  readonly auditTarget?: string;
}

const read = (name: string, phase: number, description: string, tags: readonly string[], options: Partial<UpgradeToolCatalogEntry> = {}): UpgradeToolCatalogEntry => entry(name, phase, description, 'READ', tags, true, options);
const execute = (name: string, phase: number, description: string, tags: readonly string[], options: Partial<UpgradeToolCatalogEntry> = {}): UpgradeToolCatalogEntry => entry(name, phase, description, 'EXECUTE', tags, false, options);
const write = (name: string, phase: number, description: string, tags: readonly string[], options: Partial<UpgradeToolCatalogEntry> = {}): UpgradeToolCatalogEntry => entry(name, phase, description, 'WRITE', tags, false, options);
const dangerous = (name: string, phase: number, description: string, tags: readonly string[], options: Partial<UpgradeToolCatalogEntry> = {}): UpgradeToolCatalogEntry => entry(name, phase, description, 'DANGEROUS', tags, false, options);

function entry(
  name: string,
  phase: number,
  description: string,
  permission: McpPermissionLevel,
  tags: readonly string[],
  parallelSafe: boolean,
  options: Partial<UpgradeToolCatalogEntry>,
): UpgradeToolCatalogEntry {
  return {
    name,
    phase,
    description,
    permission,
    tags,
    parallelSafe,
    deliveryState: deliveryStateFor(options.availability),
    ...options,
  };
}

function deliveryStateFor(availability: UpgradeToolCatalogEntry['availability']): ToolDeliveryState {
  if (availability === 'optional') return 'dependency_gated';
  if (availability === 'planned') return 'planned';
  if (availability === 'unavailable') return 'feature_disabled';
  return 'operational';
}

export const UPGRADE_TOOL_CATALOG: readonly UpgradeToolCatalogEntry[] = [
  read('symbol_search', 5, 'Search indexed symbols across the workspace.', ['code', 'symbol', 'search']),
  read('find_definition', 5, 'Find deterministic symbol definitions.', ['code', 'definition']),
  read('find_references', 5, 'Find textual and indexed references to a symbol.', ['code', 'references']),
  read('find_implementations', 5, 'Find interface and class implementations.', ['code', 'implementation']),
  read('call_hierarchy', 5, 'Return a deterministic call hierarchy approximation.', ['code', 'calls']),
  read('import_graph', 5, 'Return indexed imports and exports for a module.', ['code', 'imports', 'graph']),
  read('dependency_graph', 5, 'Return package and module dependency metadata.', ['code', 'dependency', 'graph']),
  read('module_graph', 5, 'Return the workspace module graph.', ['code', 'module', 'graph']),
  read('type_search', 5, 'Search indexed TypeScript, JavaScript, and Python types.', ['code', 'type']),
  read('trace_symbol', 5, 'Combine definition, references, imports, tests, and recent context.', ['code', 'trace']),
  read('context_ranking', 6, 'Explain ranking signals without removing lower-ranked context.', ['context', 'ranking']),
  read('debug_context', 7, 'Gather deterministic debugging context and continuation metadata.', ['debug', 'context'], { streamable: true }),
  read('review_context', 7, 'Gather code-review context.', ['review', 'context'], { streamable: true }),
  read('change_context', 7, 'Gather changed files, symbols, dependencies, and tests.', ['change', 'git', 'context'], { streamable: true }),
  read('symbol_context', 7, 'Gather context around a symbol.', ['symbol', 'context'], { streamable: true }),
  read('test_context', 7, 'Gather relevant test context.', ['test', 'context'], { streamable: true }),
  read('dependency_context', 7, 'Gather dependency-related context.', ['dependency', 'context'], { streamable: true }),
  read('git_context', 7, 'Gather Git status, diff, and history context.', ['git', 'context'], { streamable: true }),
  read('frontend_context', 7, 'Gather frontend project context.', ['frontend', 'context'], { streamable: true }),
  read('backend_context', 7, 'Gather backend project context.', ['backend', 'context'], { streamable: true }),
  read('route_intent', 8, 'Classify a prompt with a deterministic, overridable route.', ['router', 'intent']),
  read('recipe_list', 9, 'List built-in and user recipe names.', ['recipe']),
  read('recipe_describe', 9, 'Describe a recipe plan and permissions.', ['recipe']),
  execute('recipe_run', 9, 'Preview or run a deterministic recipe plan.', ['recipe', 'workflow']),
  read('dry_run', 10, 'Return a no-side-effect execution preview.', ['dry-run', 'preview']),
  read('review_changes', 11, 'Review current Git changes and affected context.', ['git', 'review']),
  read('changed_symbols', 11, 'Find symbols in changed files.', ['git', 'symbol']),
  read('affected_modules', 11, 'Find modules affected by current changes.', ['git', 'module']),
  read('git_history_context', 11, 'Return relevant recent Git history.', ['git', 'history']),
  read('git_blame_context', 11, 'Return line ownership context for a file.', ['git', 'blame']),
  read('discover_tests', 12, 'Discover project tests without imposing an execution limit.', ['test', 'discover']),
  execute('run_affected_tests', 12, 'Plan or run tests affected by changed files.', ['test', 'execute']),
  read('test_failures', 12, 'Summarize recorded test failures.', ['test', 'failure']),
  read('coverage_context', 12, 'Return coverage context when project tooling provides it.', ['test', 'coverage']),
  read('test_history', 12, 'Return recent test execution history.', ['test', 'history']),
  read('cache_stats', 13, 'Return shared cache hit/miss telemetry.', ['cache', 'telemetry']),
  write('cache_clear', 13, 'Clear safe local runtime caches.', ['cache']),
  write('cache_invalidate', 13, 'Invalidate cache entries for a path or workspace.', ['cache']),
  read('hook_list', 14, 'List registered lifecycle hooks.', ['hooks', 'lifecycle']),
  write('hook_register', 14, 'Register a deterministic lifecycle hook descriptor.', ['hooks', 'lifecycle']),
  write('hook_remove', 14, 'Remove a lifecycle hook descriptor.', ['hooks', 'lifecycle']),
  read('skill_match', 15, 'Match relevant local skills without loading all skill text.', ['skills', 'discovery']),
  read('skill_load', 15, 'Load a selected local skill by identifier.', ['skills']),
  write('plugin_install', 16, 'Register a declared plugin descriptor after validation and permission evaluation.', ['plugin'], { availability: 'unavailable', requirements: ['validated injected plugin registry'] }),
  read('plugin_list', 16, 'List installed and enabled plugins.', ['plugin'], { availability: 'unavailable', requirements: ['validated injected plugin registry'] }),
  write('plugin_enable', 16, 'Enable an installed plugin.', ['plugin'], { availability: 'unavailable', requirements: ['validated injected plugin registry'] }),
  write('plugin_disable', 16, 'Disable an installed plugin.', ['plugin'], { availability: 'unavailable', requirements: ['validated injected plugin registry'] }),
  dangerous('plugin_remove', 16, 'Remove an installed plugin.', ['plugin'], { availability: 'unavailable', requirements: ['validated injected plugin registry'] }),
  read('session_context', 17, 'Return persisted development-session context.', ['session', 'handoff']),
  write('session_checkpoint', 17, 'Persist a development-session checkpoint.', ['session']),
  read('session_resume', 17, 'Resume a persisted session context.', ['session']),
  read('session_history', 17, 'Return session checkpoints and decisions.', ['session']),
  read('response_mode', 18, 'Select compact, normal, verbose, or stream formatting.', ['response', 'stream'], { streamable: true }),
  read('inspect_web_app', 19, 'Combine DOM, console, network, URL, and screenshot metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['browser', 'ui']),
  read('debug_ui', 19, 'Gather deterministic UI debugging context. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['browser', 'ui', 'debug']),
  read('capture_ui_state', 19, 'Capture a structured UI state. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['browser', 'ui']),
  read('form_context', 19, 'Inspect form controls and values metadata. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['browser', 'form']),
  read('network_context', 19, 'Summarize browser network context when a retained CDP network event stream is available.', ['browser', 'network'], { availability: 'optional', requirements: ['CDP network event subscription and retained event stream'] }),
  read('console_context', 19, 'Summarize browser console context when a retained CDP Runtime/Log event stream is available.', ['browser', 'console'], { availability: 'optional', requirements: ['CDP Runtime/Log event subscription and retained event stream'] }),
  read('browser_debug_context', 19, 'Combine browser diagnostics for one request. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['browser', 'debug']),
  read('windows_environment', 20, 'Inspect Windows environment metadata.', ['windows', 'environment']),
  read('service_context', 20, 'Inspect Windows service metadata.', ['windows', 'services']),
  read('process_context', 20, 'Inspect process-tree context.', ['windows', 'process']),
  read('port_context', 20, 'Inspect local listening-port context.', ['windows', 'network']),
  read('registry_context', 20, 'Inspect registry context through the Windows capability boundary.', ['windows', 'registry']),
  read('event_log_context', 20, 'Inspect Windows event-log context.', ['windows', 'events']),
  read('installed_runtime_context', 20, 'Inspect installed runtimes and package managers.', ['windows', 'runtime']),
  read('path_context', 20, 'Resolve executable and PATH context.', ['windows', 'path']),
  read('startup_context', 20, 'Inspect startup configuration context.', ['windows', 'startup']),
  read('mcp_discover', 21, 'Discover external MCP servers without flattening native tools.', ['mcp', 'gateway']),
  read('mcp_health', 21, 'Return external MCP connection health.', ['mcp', 'gateway', 'health']),
  read('mcp_resources', 21, 'List resources exposed by connected MCP servers when the child server supports resources/list.', ['mcp', 'gateway', 'resources'], { availability: 'optional', requirements: ['configured external MCP server with resources capability'] }),
  execute('task_create', 22, 'Create a visible managed runtime task.', ['task', 'runtime'], { availability: 'unavailable', requirements: ['managed task execution adapter'] }),
  read('task_status', 22, 'Read managed task state.', ['task', 'runtime'], { availability: 'unavailable', requirements: ['managed task execution adapter'] }),
  execute('task_cancel', 22, 'Cancel a managed runtime task.', ['task', 'runtime'], { availability: 'unavailable', requirements: ['managed task execution adapter'] }),
  read('task_result', 22, 'Read a managed task result.', ['task', 'runtime'], { availability: 'unavailable', requirements: ['managed task execution adapter'] }),
  read('task_list', 22, 'List managed runtime tasks.', ['task', 'runtime'], { availability: 'unavailable', requirements: ['managed task execution adapter'] }),
  execute('delegate', 23, 'Delegate a task through a policy/audit adapter.', ['agent', 'delegate'], { availability: 'unavailable', requirements: ['subagent provider'] }),
  read('delegate_status', 23, 'Read delegated agent state.', ['agent', 'delegate'], { availability: 'unavailable', requirements: ['subagent provider'] }),
  execute('delegate_cancel', 23, 'Cancel a delegated agent task.', ['agent', 'delegate'], { availability: 'unavailable', requirements: ['subagent provider'] }),
  read('delegate_result', 23, 'Read delegated agent result.', ['agent', 'delegate'], { availability: 'unavailable', requirements: ['subagent provider'] }),
  execute('parallel_delegate', 24, 'Run isolated read-only agent tasks with collision metadata.', ['agent', 'parallel'], { availability: 'unavailable', requirements: ['subagent provider', 'ownership/collision adapter'] }),
  read('permission_check', 25, 'Evaluate an action class without limiting allowed context reads.', ['permission', 'policy']),
  read('permission_profile', 25, 'Return the active Permission v2 profile.', ['permission', 'policy']),
  read('live_logs_query', 26, 'Query structured activity/log metadata with correlation IDs.', ['logs', 'audit'], { availability: 'unavailable', requirements: ['structured live-log provider'] }),
  read('live_logs_status', 26, 'Return Live Logs pipeline health and source status.', ['logs', 'audit'], { availability: 'unavailable', requirements: ['structured live-log provider'] }),
  read('telemetry_dashboard', 27, 'Return runtime performance telemetry.', ['telemetry', 'dashboard'], { availability: 'unavailable', requirements: ['runtime telemetry provider'] }),
  read('context_economy_stats', 41, 'Return context discovery, deduplication, ledger, and token-efficiency telemetry.', ['context', 'economy', 'quota', 'telemetry']),
  read('execution_plan', 28, 'Return the cheapest deterministic execution plan and reason.', ['planner', 'telemetry']),
  read('repo_map', 29, 'Return a traversable repository structural map.', ['repository', 'map'], { streamable: true }),
  read('context_expand', 30, 'Return optional import, caller, type, test, and change references.', ['context', 'dependency']),
  read('recovery_status', 31, 'Return reconnect, retry, continuation, cache, and worker recovery state.', ['resilience', 'recovery']),
  read('tool_schema_list', 32, 'List versioned tool schema metadata.', ['schema', 'registry']),
  write('tool_schema_register', 32, 'Register a backward-compatible tool schema descriptor.', ['schema', 'registry'], { availability: 'unavailable', requirements: ['versioned schema registry'] }),
  read('capabilities', 33, 'Discover capability categories without requiring every full schema.', ['capability', 'discovery']),
  read('tool_search', 33, 'Search tools, tags, phases, and descriptions deterministically.', ['tool', 'search', 'discovery']),
  read('tool_dynamic_filter', 33, 'Return a bounded ranked tool set using deterministic scoring with optional local rerank fallback.', ['tool', 'search', 'router', 'filter']),
  read('tool_describe', 33, 'Describe one tool contract on demand.', ['tool', 'discovery']),
  read('tool_categories', 33, 'List tool categories and counts.', ['tool', 'discovery']),
  read('tool_function_find', 34, 'Find the best local tool/function candidates for a prompt.', ['tool', 'search']),
  read('tool_aliases', 33, 'List stable shorthand aliases and their primitive tool targets.', ['tool', 'alias', 'discovery']),
  read('mcp_hub', 41, 'Describe the additive MCP hub boundary without flattening child tools or retaining credentials.', ['mcp', 'gateway', 'hub'], { availability: 'optional', requirements: ['configured child MCP server', 'credential provider outside repository'], supportsCancel: true, supportsDryRun: true, auditTarget: 'mcp-server' }),
  read('dev_context', 35, 'Run the unified deterministic development-context facade.', ['development', 'context'], { streamable: true }),
  read('recipe_catalog', 36, 'Return inspectable developer automation recipes.', ['recipe', 'automation']),
  read('capture_screenshot', 37, 'Capture screenshot metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['visual', 'browser']),
  read('compare_screenshot', 37, 'Compare screenshot metadata or supplied artifacts.', ['visual', 'browser']),
  read('dom_snapshot', 37, 'Return a structured DOM snapshot. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['visual', 'browser']),
  read('layout_metadata', 37, 'Return layout metadata for visual validation. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['visual', 'browser']),
  read('visual_context', 37, 'Combine screenshot, DOM, layout, console, and network references. Requires an exact dom_cdp tab_id from list_tabs or new_tab; never uses the active/first tab.', ['visual', 'context']),
  read('inspect_workbook', 37, 'Inspect workbook sheets, used ranges, and a bounded sample through Excel COM.', ['visual', 'excel', 'office']),
  read('compare_workbook_layout', 37, 'Compare workbook layout metadata through an optional spreadsheet plugin.', ['visual', 'excel', 'plugin'], { availability: 'unavailable', requirements: ['spreadsheet layout plugin adapter'] }),
  read('render_excel_preview', 37, 'Render an Excel preview through an optional spreadsheet plugin.', ['visual', 'excel', 'plugin'], { availability: 'unavailable', requirements: ['Excel preview renderer adapter'] }),
  read('inspect_pdf', 37, 'Inspect PDF page structure and text through the local PDF provider.', ['visual', 'pdf', 'provider'], { availability: 'optional', requirements: ['local PDF provider', 'registered workspace'] }),
  read('compare_pdf_pages', 37, 'Compare PDF page metadata through an optional PDF plugin.', ['visual', 'pdf', 'plugin'], { availability: 'unavailable', requirements: ['PDF page renderer adapter'] }),
  read('project_profile_get', 38, 'Read project intelligence conventions.', ['project', 'profile'], { availability: 'unavailable', requirements: ['validated project-profile persistence adapter'] }),
  write('project_profile_set', 38, 'Update project intelligence conventions.', ['project', 'profile'], { availability: 'unavailable', requirements: ['validated project-profile persistence adapter'] }),
  read('handoff_context', 39, 'Build a structured cross-agent handoff bundle from real workspace, Git, and context services.', ['handoff', 'session'], { requirements: ['registered workspace', 'workspace search service', 'workspace file service', 'configured Git service'] }),
  execute('benchmark_run', 40, 'Run or preview a benchmark scenario.', ['benchmark', 'regression'], { availability: 'unavailable', requirements: ['managed benchmark execution adapter'] }),
  read('regression_report', 40, 'Return benchmark and regression results.', ['benchmark', 'regression'], { availability: 'unavailable', requirements: ['persisted benchmark result store'] }),
  execute('sandbox_exec', 42, 'Run an artifact-based Windows Sandbox job with networking disabled and read-only mapped input.', ['windows', 'sandbox', 'detonation'], { availability: 'optional', requirements: ['Windows Sandbox feature', 'interactive user session', 'artifact output directory'], supportsCancel: false, supportsDryRun: true, auditTarget: 'sandbox-artifact' }),
  execute('event_watch', 42, 'Watch an allowlisted user-mode ETW or Windows Event Log diagnostic stream.', ['windows', 'etw', 'events', 'diagnostics'], { availability: 'optional', requirements: ['allowlisted provider', 'admin diagnostics only when required'], supportsCancel: true, supportsDryRun: true, auditTarget: 'event-provider' }),
  read('crash_trace', 42, 'Return bounded crash and service-diagnostic context from allowlisted user-mode sources.', ['windows', 'crash', 'diagnostics'], { availability: 'optional', requirements: ['allowlisted provider', 'Windows Event Log'], supportsCancel: true, supportsDryRun: true, auditTarget: 'crash-diagnostic' }),
  read('lsp_diagnostics', 43, 'Read diagnostics from an owned language-server child process.', ['code', 'lsp', 'diagnostics'], { availability: 'optional', requirements: ['language server executable', 'registered workspace'], supportsCancel: true, supportsDryRun: true, auditTarget: 'language-server' }),
  write('lsp_rename', 43, 'Create a cross-file LSP rename edit plan before any workspace write.', ['code', 'lsp', 'refactor'], { availability: 'optional', requirements: ['language server executable', 'edit-plan approval'], supportsCancel: true, supportsDryRun: true, auditTarget: 'workspace-edit-plan' }),
  execute('debug_attach', 43, 'Attach a DAP client only to an owned workspace debug adapter.', ['code', 'dap', 'debug'], { availability: 'unavailable', requirements: ['owned DAP execution adapter', 'registered workspace'], supportsCancel: true, supportsDryRun: true, auditTarget: 'debug-session' }),
  execute('debug_step', 43, 'Perform a bounded DAP stepping/read operation in an owned debug session.', ['code', 'dap', 'debug'], { availability: 'unavailable', requirements: ['owned DAP execution adapter', 'owned debug session'], supportsCancel: true, supportsDryRun: true, auditTarget: 'debug-session' }),
  write('git_worktree_spawn', 44, 'Create a confined, ledger-owned Git worktree for isolated agent work with collision metadata.', ['git', 'worktree', 'agent'], { availability: 'optional', requirements: ['registered Git workspace'], supportsCancel: true, supportsDryRun: true, auditTarget: 'git-worktree' }),
  dangerous('git_worktree_remove', 44, 'Remove a ledger-owned Git worktree after dry-run and standard-mode confirmation; trusted Full Bypass skips lnwjud approval.', ['git', 'worktree', 'agent'], { availability: 'optional', requirements: ['registered Git workspace', 'ownership ledger entry'], supportsCancel: true, supportsDryRun: true, auditTarget: 'git-worktree' }),
  read('db_inspect', 44, 'Inspect a local database schema through a configured, read-only connection.', ['database', 'schema', 'local'], { availability: 'optional', requirements: ['local database driver', 'registered database target'], supportsCancel: true, supportsDryRun: true, auditTarget: 'database-schema' }),
  read('db_query', 44, 'Run a bounded read-only local SQLite SELECT, PRAGMA, or WITH...SELECT query.', ['database', 'query', 'local'], { availability: 'optional', requirements: ['local database driver', 'approved database target'], supportsCancel: true, supportsDryRun: true, auditTarget: 'database-query' }),
  write('office_ppt', 45, 'Read PowerPoint content or save a copy through the existing Office policy boundary.', ['office', 'powerpoint', 'com'], { availability: 'optional', requirements: ['Microsoft PowerPoint', 'Office COM policy'], supportsCancel: false, supportsDryRun: true, auditTarget: 'office-presentation' }),
  read('office_outlook', 45, 'Read Outlook folder and message headers through the existing Office policy boundary.', ['office', 'outlook', 'com'], { availability: 'optional', requirements: ['Microsoft Outlook', 'Office COM policy', 'redaction policy'], supportsCancel: false, supportsDryRun: false, auditTarget: 'office-mail' }),
  read('pdf_extract_tables', 45, 'Extract bounded PDF text and tables through a local document provider.', ['document', 'pdf', 'extract'], { availability: 'optional', requirements: ['local PDF provider', 'bounded document size'], supportsCancel: true, supportsDryRun: true, auditTarget: 'document' }),
  write('docx_merge', 45, 'Create a deterministic DOCX merge plan and write only after approval.', ['document', 'docx', 'merge'], { availability: 'optional', requirements: ['local DOCX provider', 'edit approval'], supportsCancel: true, supportsDryRun: true, auditTarget: 'document' }),
  read('self_heal_plan', 46, 'Propose safe, deterministic, reversible recovery steps without applying mutations.', ['recovery', 'self-healing', 'safety'], { availability: 'ready', requirements: ['diagnostic evidence'], supportsCancel: false, supportsDryRun: true, auditTarget: 'recovery-plan' }),
  dangerous('self_heal_apply', 46, 'Apply a current reversible recovery plan without automatic destructive retries; standard mode requires confirmation and trusted Full Bypass skips lnwjud approval.', ['recovery', 'self-healing', 'safety'], { availability: 'optional', requirements: ['current recovery plan from self_heal_plan', 'dry-run preview'], supportsCancel: true, supportsDryRun: true, auditTarget: 'recovery-mutation' }),
  write('skills_import', 46, 'Import a compatible skill descriptor after validation and permission review.', ['skills', 'compatibility', 'import'], { availability: 'unavailable', requirements: ['validated skill import adapter', 'validated local skill source'], supportsCancel: false, supportsDryRun: true, auditTarget: 'skill-catalog' }),
  execute('agent_swarm_run', 46, 'Plan bounded parallel subagents with ownership, collision, approval, and cancellation metadata.', ['agent', 'swarm', 'parallel'], { availability: 'planned', requirements: ['subagent provider', 'ownership ledger', 'mutation policy'], supportsCancel: true, supportsDryRun: true, auditTarget: 'agent-swarm' }),
];

export function upgradeCatalogEntry(name: string): UpgradeToolCatalogEntry | undefined {
  return UPGRADE_TOOL_CATALOG.find((entry) => entry.name === name);
}
