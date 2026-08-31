import type { ToolRuntimeEvidence } from './tool-delivery-contract.js';

export type ToolRuntimePreparation =
  | 'workspace_context'
  | 'workspace_full_scan'
  | 'read_file_page'
  | 'vision_annotated_capture'
  | 'cache_seed'
  | 'hook_register'
  | 'session_checkpoint'
  | 'git_worktree_spawn';

export interface ToolRuntimeFixture {
  readonly input: Readonly<Record<string, unknown>>;
  readonly evidence: ToolRuntimeEvidence;
  readonly prepare?: ToolRuntimePreparation;
  readonly oracle?: ToolRuntimeOracle;
}

export interface ToolRuntimeOracle {
  readonly expected: Readonly<Record<string, unknown>>;
  readonly requiredKeys?: readonly string[];
  readonly alternate?: {
    readonly input: Readonly<Record<string, unknown>>;
    readonly expected: Readonly<Record<string, unknown>>;
  };
  readonly state?: 'cache_generation' | 'hook_registered' | 'hook_removed' | 'session_checkpoint';
}

const workspaceId = 'workspace-1';
const zeroUuid = '00000000-0000-0000-0000-000000000000';

const service = (
  input: Readonly<Record<string, unknown>>,
  serviceCall: string,
  prepare?: ToolRuntimePreparation,
): ToolRuntimeFixture => ({ input, evidence: { kind: 'service_dispatch', serviceCall }, ...(prepare === undefined ? {} : { prepare }) });

const deterministic = (
  input: Readonly<Record<string, unknown>>,
  oracle: ToolRuntimeOracle,
  prepare?: ToolRuntimePreparation,
): ToolRuntimeFixture => ({ input, evidence: { kind: 'deterministic_operation' }, oracle, ...(prepare === undefined ? {} : { prepare }) });

const unavailable = (
  input: Readonly<Record<string, unknown>>,
  unavailableStatus: 'needs_setup' | 'disabled' | 'unsupported' = 'needs_setup',
): ToolRuntimeFixture => ({ input, evidence: { kind: 'truthful_unavailable', unavailableStatus } });

/**
 * Safe parse-valid inputs and expected delivery evidence for the 93 core tools.
 * These are non-production fixtures: they use controlled workspace IDs, dry-run
 * inputs where available, and never point at a real user path.
 */
export const CORE_TOOL_RUNTIME_FIXTURES = {
  workspace_list: service({}, 'workspaceInfo.list'),
  workspace_register: service({ path: 'E:\\project' }, 'workspaceInfo.register'),
  workspace_info: service({ workspaceId }, 'workspaceInfo.info'),
  workspace_tree: service({}, 'workspaceQuery.tree'),
  project_snapshot: service({ workspaceId }, 'projectSnapshot.snapshot'),
  read_file: service({ workspaceId, path: 'README.md' }, 'file.readFile'),
  read_files: service({ workspaceId, files: [{ path: 'README.md' }] }, 'file.readFiles'),
  search_files: service({ workspaceId }, 'search.searchFiles'),
  search_text: service({ workspaceId, query: 'needle' }, 'search.searchText'),
  git_status: service({ workspaceId }, 'git.status'),
  git_diff: service({ workspaceId }, 'git.diff'),
  git_log: service({ workspaceId }, 'git.log'),
  git: service({ workspaceId, args: ['status', '--short'] }, 'git.run'),
  write_file: service({ workspaceId, path: 'tmp-smoke.txt', content: 'smoke' }, 'file.writeFile'),
  apply_patch: service({ workspaceId, files: [{ path: 'tmp-smoke.txt', content: 'smoke' }] }, 'file.applyPatch'),
  edit_file: service({ workspaceId, path: 'tmp-smoke.txt', oldText: 'before', newText: 'after' }, 'file.editFile'),
  move_file: service({ workspaceId, sourcePath: 'from.txt', destinationPath: 'to.txt' }, 'file.moveFile'),
  copy_file: service({ workspaceId, sourcePath: 'from.txt', destinationPath: 'to.txt' }, 'file.copyFile'),
  delete_file: service({ workspaceId, path: 'tmp-smoke.txt', userConfirmed: true }, 'file.deleteFile'),
  list_recovery_items: service({ workspaceId }, 'file.listRecoveryItems'),
  restore_deleted_file: service({ workspaceId, recoveryId: zeroUuid, userConfirmed: true }, 'file.restoreDeletedFile'),
  list_checkpoints: service({ workspaceId }, 'checkpoint.list'),
  restore_checkpoint: service({ workspaceId, checkpointId: zeroUuid, userConfirmed: true }, 'checkpoint.restore'),
  process_start: service({ workspaceId, executable: 'node.exe', args: ['--version'] }, 'process.start'),
  process_list: service({ workspaceId }, 'process.list'),
  process_status: service({ workspaceId, processId: 'process-1' }, 'process.status'),
  process_logs: service({ workspaceId, processId: 'process-1' }, 'process.logs'),
  process_stop: service({ workspaceId, processId: 'process-1', userConfirmed: true }, 'process.stop'),
  project_dev: service({ workspaceId, userConfirmed: true }, 'process.startProjectCommand'),
  project_test: service({ workspaceId, userConfirmed: true }, 'process.startProjectCommand'),
  project_lint: service({ workspaceId, userConfirmed: true }, 'process.startProjectCommand'),
  project_typecheck: service({ workspaceId, userConfirmed: true }, 'process.startProjectCommand'),
  project_build: service({ workspaceId, userConfirmed: true }, 'process.startProjectCommand'),
  codex_status: service({}, 'codex.status'),
  codex_run: service({ workspaceId, instruction: 'read-only smoke', userConfirmed: true }, 'codex.run'),
  codex_task_list: service({ workspaceId }, 'codex.list'),
  codex_task_status: service({ workspaceId, codexTaskId: 'codex-1' }, 'codex.taskStatus'),
  codex_task_logs: service({ workspaceId, codexTaskId: 'codex-1' }, 'codex.taskLogs'),
  codex_stop: service({ workspaceId, codexTaskId: 'codex-1', userConfirmed: true }, 'codex.stop'),
  shell: service({ workspaceId, operation: 'list' }, 'capabilities.shell'),
  dom_cdp: service({ action: 'status' }, 'capabilities.dom_cdp'),
  computer_use: service({ workspaceId, action: 'inspect' }, 'capabilities.accessibility'),
  accessibility: service({ action: 'status' }, 'capabilities.accessibility'),
  input_event: service({ operation: 'release_all', userConfirmed: true }, 'capabilities.input_event'),
  vision: service({ action: 'capture_display', dry_run: true }, 'capabilities.vision'),
  vision_annotated_capture: service({ workspaceId, capture: 'display' }, 'capabilities.vision'),
  ui_target_action: service({ workspaceId, observationId: 'observation-1', markId: 'm1', dry_run: true }, 'capabilities.accessibility', 'vision_annotated_capture'),
  window: service({ operation: 'list' }, 'capabilities.window'),
  health: service({}, 'capabilities.health'),
  system_info: service({}, 'capabilities.system_info'),
  notification: service({ title: 'Smoke', message: 'Readiness check', dry_run: true }, 'capabilities.notification'),
  file_dialog: service({ action: 'open', dry_run: true }, 'capabilities.file_dialog'),
  clipboard: service({ action: 'get_text' }, 'capabilities.clipboard'),
  web_fetch: service({ url: 'https://example.com', method: 'GET', dry_run: true }, 'capabilities.web_fetch'),
  audio: service({ action: 'stop', dry_run: true }, 'capabilities.audio'),
  screen_record: service({ action: 'status' }, 'capabilities.screen_record'),
  office: service({ app: 'outlook', action: 'list_folders' }, 'capabilities.office'),
  scheduler: service({ action: 'list' }, 'capabilities.scheduler'),
  wsl_exec: service({ workspaceId, operation: 'run', executable: 'printf', arguments: ['smoke'], dry_run: true }, 'capabilities.wsl_exec'),
  wsl_fs: service({ operation: 'status' }, 'capabilities.wsl_fs'),
  skills_list: service({}, 'extensions.listSkills'),
  skills_read: service({ skillId: 'skill-1' }, 'extensions.readSkill'),
  mcp_list: service({}, 'extensions.listMcpServers'),
  mcp_describe: service({ server: 'server-1' }, 'extensions.describeMcpServer'),
  mcp_call: service({ server: 'server-1', tool: 'noop', arguments: {}, userConfirmed: true }, 'extensions.callMcpTool'),
  workspace_context: service({ workspaceId, query: 'smoke' }, 'search.searchText'),
  workspace_context_continue: service({ continuationToken: 'context-token' }, 'file.readFile', 'workspace_context'),
  workspace_full_scan: service({ workspaceId }, 'search.searchFiles'),
  workspace_full_scan_continue: deterministic(
    { continuationToken: 'scan-token' },
    { expected: { scannedWorkspaces: 1, scannedFiles: 2, hasMore: false }, requiredKeys: ['files'] },
    'workspace_full_scan',
  ),
  workspace_snapshot: service({ workspaceId }, 'projectSnapshot.snapshot'),
  search_all: service({ workspaceId, query: 'smoke' }, 'search.searchText'),
  read_many_files: service({ workspaceId, files: [{ path: 'README.md' }] }, 'file.readFile'),
  read_file_page: service({ workspaceId, path: 'README.md' }, 'file.readFile'),
  read_file_page_continue: service({ continuationToken: 'page-token' }, 'file.readFile', 'read_file_page'),
  workspace_index: service({ workspaceId }, 'workspaceIndex.indexWorkspace'),
  workspace_index_status: service({ workspaceId }, 'workspaceIndex.status'),
  workspace_index_watch: service({ workspaceId }, 'workspaceIndex.startWatch'),
  workspace_index_stop: service({ workspaceId }, 'workspaceIndex.stopWatch'),
  session_handoff: service({ workspaceId }, 'file.readFile'),
  verify_incremental: service({ workspaceId, userConfirmed: true }, 'git.status'),
  run_goal: service({ workspaceId, goalKey: 'smoke-goal', objective: 'Smoke durable goal contract' }, 'goals.runGoal'),
  get_goal: service({ goalId: 'goal-1' }, 'goals.getGoal'),
  checkpoint_goal: service({
    goalId: 'goal-1', leaseToken: 'lease-token', expectedRevision: 0, currentPhase: 'smoke', summary: 'smoke',
    stepUpdates: [], nextAction: '', blockers: [], evidence: [], activeTaskIds: [],
  }, 'goals.checkpointGoal'),
  finish_goal: service({ goalId: 'goal-1', leaseToken: 'lease-token', expectedRevision: 0, status: 'completed', summary: 'smoke', evidence: [] }, 'goals.finishGoal'),
  cancel_goal: service({ goalId: 'goal-1', expectedRevision: 0, summary: 'cancel smoke', evidence: [] }, 'goals.cancelGoal'),
  list_goals: service({}, 'goals.listGoals'),
  prepare_scheduled_continuation: service({
    goalId: 'goal-1', leaseToken: 'lease-token', expectedRevision: 0, currentPhase: 'smoke', summary: 'smoke',
    stepUpdates: [], nextAction: 'continue smoke', blockers: [], evidence: [], activeTaskIds: [], successorDelayMinutes: 25, executionPreference: 'cloud',
  }, 'scheduledContinuations.prepareScheduledContinuation'),
  record_scheduled_continuation_receipt: service({ continuationId: 'continuation-1', expectedVersion: 0, outcome: 'create_failed' }, 'scheduledContinuations.recordScheduledContinuationReceipt'),
  claim_scheduled_continuation: service({ continuationId: 'continuation-1' }, 'scheduledContinuations.claimScheduledContinuation'),
  get_scheduled_continuation: service({ continuationId: 'continuation-1' }, 'scheduledContinuations.getScheduledContinuation'),
  expedite_scheduled_continuation: service({
    goalId: 'goal-1', continuationId: 'continuation-1', leaseToken: 'lease-token',
    expectedLeaseGeneration: 1, expectedGoalRevision: 1, expectedContinuationVersion: 1,
    reason: 'host_budget_warning',
  }, 'scheduledContinuations.expediteScheduledContinuation'),
  cancel_scheduled_continuation: service({ continuationId: 'continuation-1', expectedVersion: 0 }, 'scheduledContinuations.cancelScheduledContinuation'),
  tool_batch: service({ calls: [{ id: 'readiness-child', tool: 'workspace_list', arguments: {} }] }, 'workspaceInfo.list'),
} as const satisfies Readonly<Record<string, ToolRuntimeFixture>>;

/** Runtime fixtures for the exact 53 upgrade definitions delivered in phases 5-18. */
export const PHASE_5_TO_18_TOOL_RUNTIME_FIXTURES = {
  symbol_search: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  find_definition: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  find_references: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  find_implementations: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  call_hierarchy: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  import_graph: service({ workspaceId, path: 'src/smoke.ts' }, 'workspaceIndex.status'),
  dependency_graph: service({ workspaceId, path: 'src/smoke.ts' }, 'workspaceIndex.status'),
  module_graph: service({ workspaceId, path: 'src/smoke.ts' }, 'workspaceIndex.status'),
  type_search: service({ workspaceId, query: 'Smoke' }, 'workspaceIndex.status'),
  trace_symbol: service({ workspaceId, symbol: 'smoke' }, 'workspaceIndex.status'),
  context_ranking: deterministic({ query: 'smoke' }, { expected: {
    signals: { exactSymbol: 100, exactFilename: 80, recentChange: 60, sameModule: 50, dependency: 40, test: 30, text: 20, proximity: 10 },
    lowerRankedResultsRemainAvailable: true,
  } }),
  debug_context: service({ workspaceId, query: 'smoke failure' }, 'git.status'),
  review_context: service({ workspaceId, query: 'review smoke' }, 'git.status'),
  change_context: service({ workspaceId, query: 'changed smoke' }, 'git.status'),
  symbol_context: service({ workspaceId, query: 'smoke' }, 'git.status'),
  test_context: service({ workspaceId, query: 'smoke test' }, 'git.status'),
  dependency_context: service({ workspaceId, path: 'src/smoke.ts' }, 'workspaceIndex.status'),
  git_context: service({ workspaceId, query: 'smoke' }, 'git.status'),
  frontend_context: service({ workspaceId, query: 'component smoke' }, 'git.status'),
  backend_context: service({ workspaceId, query: 'service smoke' }, 'git.status'),
  route_intent: deterministic({ prompt: 'debug the smoke failure' }, {
    expected: { route: 'debug', domain: 'desktop/mcp/logging', confidence: 'high', selectedModel: 'deterministic', reasonCodes: ['keyword:debug'], authorizationUnchanged: true },
    alternate: { input: { prompt: 'test the smoke project' }, expected: { route: 'test', domain: 'project/tests', selectedModel: 'deterministic', reasonCodes: ['keyword:test'] } },
  }),
  recipe_list: deterministic({}, { expected: { recipes: [
    { name: 'bugfix', steps: ['workspace_context', 'git_context', 'test_context', 'live_logs_query'], optional: false },
    { name: 'code-review', steps: ['review_context', 'changed_symbols', 'discover_tests'], optional: false },
    { name: 'frontend-debug', steps: ['debug_ui', 'console_context', 'network_context', 'capture_ui_state'], optional: true },
    { name: 'release-check', steps: ['git_context', 'regression_report', 'benchmark_run'], optional: false },
  ] } }),
  recipe_describe: deterministic({ name: 'bugfix' }, { expected: {
    name: 'bugfix', steps: ['workspace_context', 'git_context', 'test_context', 'live_logs_query'], optional: false,
  } }),
  recipe_run: deterministic({ prompt: 'debug a smoke failure', dryRun: true }, {
    expected: { route: 'debug', operations: ['workspace_context', 'git_context', 'live_logs_query', 'test_context'], permissions: ['filesystem.read', 'git.read'], dryRun: true, sideEffectsStarted: false },
    alternate: { input: { prompt: 'test the smoke project', dryRun: true }, expected: { route: 'test', operations: ['workspace_context', 'discover_tests', 'test_context'] } },
  }),
  dry_run: deterministic({ prompt: 'build the smoke project' }, {
    expected: { route: 'frontend', operations: ['workspace_context', 'repo_map'], permissions: ['filesystem.read', 'git.read'], sideEffects: { writes: [], shell: [], gitMutations: [], network: [] }, sideEffectsStarted: false },
    alternate: { input: { prompt: 'test the smoke project' }, expected: { route: 'test', operations: ['workspace_context', 'discover_tests', 'test_context'] } },
  }),
  review_changes: service({ workspaceId }, 'git.status'),
  changed_symbols: service({ workspaceId, query: 'smoke' }, 'workspaceIndex.status'),
  affected_modules: service({ workspaceId }, 'git.status'),
  git_history_context: service({ workspaceId }, 'git.log'),
  git_blame_context: service({ workspaceId, path: 'src/smoke.ts' }, 'git.run'),
  discover_tests: service({ workspaceId }, 'workspaceIndex.status'),
  run_affected_tests: service({ workspaceId, dryRun: true }, 'process.previewProjectCommand'),
  test_failures: service({ workspaceId }, 'process.list'),
  coverage_context: service({ workspaceId }, 'search.searchFiles'),
  test_history: service({ workspaceId }, 'process.list'),
  cache_stats: deterministic({}, { expected: { hits: 0, misses: 0, bytesSaved: 0, generation: 0, hitRate: 0, entries: 0, invalidation: 'mtime/content-hash/filesystem-event' }, requiredKeys: ['contextEconomy'] }),
  cache_clear: deterministic({}, { expected: { cleared: true, scope: 'all', previousGeneration: 0, generation: 1 }, state: 'cache_generation' }, 'cache_seed'),
  cache_invalidate: deterministic({ path: 'src/smoke.ts' }, { expected: { cleared: true, scope: 'src/smoke.ts', previousGeneration: 0, generation: 1 }, state: 'cache_generation' }, 'cache_seed'),
  hook_list: deterministic({}, { expected: { hooks: [{ name: 'runtime-contract', event: 'beforeTool' }] }, requiredKeys: ['lifecycleEvents'], state: 'hook_registered' }, 'hook_register'),
  hook_register: deterministic({ name: 'runtime-contract', event: 'beforeTool' }, { expected: { registered: true, hook: { name: 'runtime-contract', event: 'beforeTool' } }, state: 'hook_registered' }),
  hook_remove: deterministic({ name: 'runtime-contract', userConfirmed: true }, { expected: { removed: true, name: 'runtime-contract' }, state: 'hook_removed' }, 'hook_register'),
  skill_match: service({ query: 'smoke', source: 'workspace' }, 'extensions.listSkills'),
  skill_load: service({ skillId: 'skill-1' }, 'extensions.readSkill'),
  plugin_install: unavailable({ name: 'safe-plugin' }, 'disabled'),
  plugin_list: unavailable({}, 'disabled'),
  plugin_enable: unavailable({ name: 'safe-plugin' }, 'disabled'),
  plugin_disable: unavailable({ name: 'safe-plugin' }, 'disabled'),
  plugin_remove: unavailable({ name: 'safe-plugin', userConfirmed: true }, 'disabled'),
  session_context: deterministic({}, { expected: { checkpoints: [{ summary: 'prepared checkpoint' }] }, requiredKeys: ['session'], state: 'session_checkpoint' }, 'session_checkpoint'),
  session_checkpoint: deterministic({ summary: 'runtime contract checkpoint' }, { expected: { summary: 'runtime contract checkpoint' }, requiredKeys: ['id', 'createdAt', 'inputDigest'], state: 'session_checkpoint' }),
  session_resume: deterministic({}, { expected: { checkpoints: [{ summary: 'prepared checkpoint' }] }, requiredKeys: ['session'], state: 'session_checkpoint' }, 'session_checkpoint'),
  session_history: deterministic({}, { expected: { checkpoints: [{ summary: 'prepared checkpoint' }] }, state: 'session_checkpoint' }, 'session_checkpoint'),
  response_mode: deterministic({ mode: 'compact' }, {
    expected: { mode: 'compact', omittedDetailsRemainFetchable: true, continuationSupported: true },
    alternate: { input: { mode: 'verbose' }, expected: { mode: 'verbose', omittedDetailsRemainFetchable: true, continuationSupported: true } },
  }),
} as const satisfies Readonly<Record<string, ToolRuntimeFixture>>;

const windowsRuntime = (
  name: string,
  input: Readonly<Record<string, unknown>>,
  serviceCall?: string,
): ToolRuntimeFixture => process.platform === 'win32'
  ? serviceCall === undefined
    ? deterministic(input, { expected: { tool: name, status: 'ready', available: true, ready: true, executed: true } })
    : service(input, serviceCall)
  : unavailable(input, 'unsupported');

/** Runtime fixtures for the exact 46 upgrade definitions delivered in phases 19-33. */
export const PHASE_19_TO_33_TOOL_RUNTIME_FIXTURES = {
  inspect_web_app: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  debug_ui: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  capture_ui_state: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  form_context: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  network_context: unavailable({}, 'needs_setup'),
  console_context: unavailable({}, 'needs_setup'),
  browser_debug_context: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  windows_environment: windowsRuntime('windows_environment', {}, 'capabilities.system_info'),
  service_context: windowsRuntime('service_context', { service: 'EventLog' }),
  process_context: windowsRuntime('process_context', {}, 'capabilities.system_info'),
  port_context: windowsRuntime('port_context', {}),
  registry_context: windowsRuntime('registry_context', { key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' }),
  event_log_context: windowsRuntime('event_log_context', { log_name: 'Application', max_events: 1 }),
  installed_runtime_context: windowsRuntime('installed_runtime_context', {}),
  path_context: windowsRuntime('path_context', {}),
  startup_context: windowsRuntime('startup_context', {}),
  mcp_discover: service({}, 'extensions.listMcpServers'),
  mcp_health: service({}, 'extensions.listMcpServers'),
  mcp_resources: service({ server: 'server-1' }, 'extensions.listMcpResources'),
  task_create: unavailable({ instruction: 'smoke task' }, 'disabled'),
  task_status: unavailable({ taskId: 'task-1' }, 'disabled'),
  task_cancel: unavailable({ taskId: 'task-1' }, 'disabled'),
  task_result: unavailable({ taskId: 'task-1' }, 'disabled'),
  task_list: unavailable({}, 'disabled'),
  delegate: unavailable({ instruction: 'smoke delegate' }, 'disabled'),
  delegate_status: unavailable({ delegateId: 'delegate-1' }, 'disabled'),
  delegate_cancel: unavailable({ delegateId: 'delegate-1' }, 'disabled'),
  delegate_result: unavailable({ delegateId: 'delegate-1' }, 'disabled'),
  parallel_delegate: unavailable({ tasks: [{ instruction: 'inspect smoke' }] }, 'disabled'),
  permission_check: deterministic({ action: 'filesystem.read' }, { expected: { decision: 'allow', class: 'read-or-safe', contextAccess: 'unrestricted' } }),
  permission_profile: deterministic({}, { expected: { profile: 'full', authorizationMode: 'standard', dangerousActions: 'policy-gated', hardBlocksRemain: true } }),
  live_logs_query: unavailable({}, 'needs_setup'),
  live_logs_status: unavailable({}, 'needs_setup'),
  telemetry_dashboard: unavailable({}, 'needs_setup'),
  execution_plan: deterministic({ prompt: 'test smoke' }, { expected: { route: 'test', operations: ['workspace_context', 'discover_tests', 'test_context'], reason: 'deterministic rule plan; telemetry can refine cost estimates' } }),
  repo_map: service({ workspaceId }, 'workspaceIndex.status'),
  context_expand: service({ workspaceId, path: 'src/smoke.ts' }, 'workspaceIndex.status'),
  recovery_status: deterministic({}, { expected: { reconnect: 'enabled-at-transport-boundary', safeReadRetry: true, destructiveRetry: false, workerIsolation: true } }),
  tool_schema_list: deterministic({}, { expected: {}, requiredKeys: ['schemas'] }),
  tool_schema_register: unavailable({ name: 'smoke-schema' }, 'disabled'),
  capabilities: deterministic({}, { expected: { primitiveToolsRemainAvailable: true }, requiredKeys: ['categories', 'totalUpgradeTools'] }),
  tool_search: deterministic({ query: 'workspace search' }, { expected: { selectedModel: 'deterministic', primitiveToolsRemainAvailable: true, authorizationUnchanged: true }, requiredKeys: ['matches', 'rankedCandidates'] }),
  tool_dynamic_filter: deterministic({ query: 'workspace search', limit: 10 }, { expected: { selectedModel: 'deterministic', primitiveToolsRemainAvailable: true, authorizationUnchanged: true }, requiredKeys: ['rankedCandidates'] }),
  tool_describe: deterministic({ name: 'tool_search' }, { expected: { found: true, name: 'tool_search', authorizationUnchanged: true } }),
  tool_categories: deterministic({}, { expected: {}, requiredKeys: ['categories'] }),
  tool_aliases: deterministic({}, { expected: { primitiveToolsRemainAvailable: true }, requiredKeys: ['aliases'] }),
} as const satisfies Readonly<Record<string, ToolRuntimeFixture>>;

/** Runtime fixtures for the exact 39 upgrade definitions delivered in phases 34-46. */
export const PHASE_34_TO_46_TOOL_RUNTIME_FIXTURES = {
  context_economy_stats: deterministic({}, { expected: { policy: { automaticDiscovery: 'filtered-and-progressive', explicitAccess: 'full-and-unrestricted-by-economy', ledger: 'bounded-in-memory' } } }),
  tool_function_find: deterministic({ prompt: 'replace exact text in a TypeScript source file without a shell script', limit: 10 }, { expected: { selectedModel: 'deterministic', primitiveToolsRemainAvailable: true, authorizationUnchanged: true }, requiredKeys: ['rankedCandidates'] }),
  mcp_hub: service({}, 'extensions.listMcpServers'),
  dev_context: service({ workspaceId, query: 'smoke development context' }, 'git.status'),
  recipe_catalog: deterministic({}, { expected: {}, requiredKeys: ['recipes'] }),
  capture_screenshot: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  compare_screenshot: deterministic({ baseline_base64: 'same', actual_base64: 'same' }, { expected: { executed: true, equal: true }, requiredKeys: ['baseline', 'actual'] }),
  dom_snapshot: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  layout_metadata: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  visual_context: service({ tab_id: 'tab-1' }, 'capabilities.dom_cdp'),
  inspect_workbook: service({ workspaceId, file_path: 'package.json' }, 'capabilities.office'),
  compare_workbook_layout: unavailable({}, 'disabled'),
  render_excel_preview: unavailable({}, 'disabled'),
  inspect_pdf: unavailable({ workspaceId, file_path: 'package.json' }, 'needs_setup'),
  compare_pdf_pages: unavailable({}, 'disabled'),
  project_profile_get: unavailable({}, 'disabled'),
  project_profile_set: unavailable({}, 'disabled'),
  handoff_context: service({ workspaceId, query: 'handoff smoke' }, 'git.status'),
  benchmark_run: unavailable({}, 'disabled'),
  regression_report: unavailable({}, 'disabled'),
  sandbox_exec: unavailable({}, process.platform === 'win32' ? 'needs_setup' : 'unsupported'),
  event_watch: deterministic({ log_name: 'Application', max_events: 1 }, { expected: { status: process.platform === 'win32' ? 'ready' : 'optional' }, requiredKeys: ['available'] }),
  crash_trace: deterministic({ hours: 1, max_events: 1 }, { expected: { status: process.platform === 'win32' ? 'ready' : 'optional' }, requiredKeys: ['available'] }),
  lsp_diagnostics: unavailable({ workspaceId, files: ['src/upgrade-runtime.ts'] }, 'needs_setup'),
  lsp_rename: unavailable({ workspaceId, file: 'src/upgrade-runtime.ts', newName: 'smokeRenamed' }, 'needs_setup'),
  debug_attach: unavailable({}, 'disabled'),
  debug_step: unavailable({}, 'disabled'),
  git_worktree_spawn: deterministic({ workspaceId, worktreePath: '.worktrees/runtime-contract', ref: 'HEAD' }, { expected: { dryRun: true, sideEffectsStarted: false, mutationPolicy: 'explicit-confirmation-and-dry-run' } }),
  git_worktree_remove: deterministic({ workspaceId, worktreePath: '.worktrees/runtime-contract' }, { expected: { dryRun: true, mutationPolicy: 'explicit-confirmation-and-dry-run' } }, 'git_worktree_spawn'),
  db_inspect: unavailable({}, 'needs_setup'),
  db_query: unavailable({}, 'needs_setup'),
  office_ppt: service({ action: 'read', file_path: 'package.json' }, 'capabilities.office'),
  office_outlook: service({ action: 'list_folders' }, 'capabilities.office'),
  pdf_extract_tables: unavailable({ workspaceId, file_path: 'package.json' }, 'needs_setup'),
  docx_merge: service({ workspaceId, file_path: 'package.json', merge_paths: ['tsconfig.json'], target_path: 'runtime-contract-output.docx' }, 'workspaceInfo.info'),
  self_heal_plan: service({}, 'capabilities.shell'),
  self_heal_apply: service({}, 'capabilities.shell'),
  skills_import: unavailable({}, 'disabled'),
  agent_swarm_run: unavailable({}, 'disabled'),
} as const satisfies Readonly<Record<string, ToolRuntimeFixture>>;

export const TOOL_RUNTIME_FIXTURES: Readonly<Record<string, ToolRuntimeFixture>> = Object.freeze({
  ...CORE_TOOL_RUNTIME_FIXTURES,
  ...PHASE_5_TO_18_TOOL_RUNTIME_FIXTURES,
  ...PHASE_19_TO_33_TOOL_RUNTIME_FIXTURES,
  ...PHASE_34_TO_46_TOOL_RUNTIME_FIXTURES,
});

export const CORE_TOOL_SMOKE_INPUTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze(
  Object.fromEntries(Object.entries(CORE_TOOL_RUNTIME_FIXTURES).map(([name, fixture]) => [name, fixture.input])),
);
