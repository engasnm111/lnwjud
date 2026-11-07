import { z } from 'zod';
import type { UpgradeToolCatalogEntry } from './upgrade-catalog.js';
import type { McpToolAnnotations, McpToolExecution } from './tools/tool-types.js';
import { isOfficeSemanticToolName, officeToolInputSchema } from './office-tool-contracts.js';

const loopbackAddress = z.enum(['127.0.0.1', '::1']);
const debugPort = z.number().int().min(1).max(65_535);
const debugInteger = z.number().int().min(0).max(2_147_483_647);
const debugThread = z.number().int().min(1).max(2_147_483_647);
const debugWorkspace = z.string().trim().min(1).max(128);
const debugSession = z.string().uuid();
const debugCommon = { workspaceId: debugWorkspace, session_id: debugSession, dryRun: z.boolean().optional() };
const debugStepping = z.object({ threadId: debugThread, singleThread: z.boolean().optional(), granularity: z.enum(['statement', 'line', 'instruction']).optional() }).strict();
const emptyDebugArguments = z.object({}).strict();
const debugEventFields = { ...debugCommon, cursor: z.string().regex(/^(0|[1-9]\d*)$/).max(32).optional(), limit: z.number().int().min(1).max(1000).optional(), maxBytes: z.number().int().min(1).max(2_097_152).optional() };

export const debugAttachInputSchema = z.object({
  workspaceId: debugWorkspace,
  endpoint: z.string().max(2048).refine((value) => {
    try {
      const endpoint = new URL(value);
      return endpoint.protocol === 'tcp:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
        && endpoint.username === '' && endpoint.password === '' && endpoint.search === '' && endpoint.hash === ''
        && ['', '/'].includes(endpoint.pathname) && Number.isInteger(Number(endpoint.port))
        && Number(endpoint.port) >= 1 && Number(endpoint.port) <= 65_535;
    } catch { return false; }
  }, 'DAP endpoint must be an explicit numeric loopback TCP address and port'),
  adapterId: z.string().trim().min(1).max(128).optional(),
  configuration: z.object({
    processId: debugThread.optional(),
    port: debugPort.optional(),
    address: loopbackAddress.optional(),
    connect: z.object({ host: loopbackAddress, port: debugPort }).strict().optional(),
    justMyCode: z.boolean().optional(),
    stopOnEntry: z.boolean().optional(),
    continueOnAttach: z.boolean().optional(),
  }).strict().optional(),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
  dryRun: z.boolean().optional(),
}).strict();

export const debugStepInputSchema = z.union([
  z.object({ ...debugEventFields, action: z.literal('status') }).strict(),
  z.object({ ...debugEventFields, action: z.literal('events') }).strict(),
  z.object({ ...debugCommon, action: z.literal('disconnect') }).strict(),
  z.object({ ...debugCommon, action: z.enum(['next', 'stepIn', 'stepOut']), arguments: debugStepping }).strict(),
  z.object({ ...debugCommon, action: z.literal('continue'), arguments: z.object({ threadId: debugThread, singleThread: z.boolean().optional() }).strict() }).strict(),
  z.object({ ...debugCommon, action: z.literal('pause'), arguments: z.object({ threadId: debugThread }).strict() }).strict(),
  z.object({ ...debugCommon, action: z.literal('threads'), arguments: emptyDebugArguments.optional() }).strict(),
  z.object({ ...debugCommon, action: z.literal('stackTrace'), arguments: z.object({ threadId: debugThread, startFrame: debugInteger.optional(), levels: debugInteger.optional() }).strict() }).strict(),
  z.object({ ...debugCommon, action: z.literal('scopes'), arguments: z.object({ frameId: debugInteger }).strict() }).strict(),
  z.object({ ...debugCommon, action: z.literal('variables'), arguments: z.object({ variablesReference: debugInteger, filter: z.enum(['indexed', 'named']).optional(), start: debugInteger.optional(), count: debugInteger.optional() }).strict() }).strict(),
  z.object({ ...debugCommon, action: z.literal('evaluate'), arguments: z.object({ expression: z.string().min(1).max(65_536), frameId: debugInteger.optional(), context: z.enum(['watch', 'repl', 'hover', 'clipboard', 'variables']).optional() }).strict() }).strict(),
]);

export const handoffContextInputSchema = z.object({
  workspaceId: debugWorkspace,
  query: z.string().min(1).max(32_768).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  trackerPath: z.string().trim().min(1).max(4096).optional(),
  maxDiffBytes: z.number().int().min(1000).max(100_000).optional(),
}).strict();

type FieldName = keyof typeof FIELD_SCHEMAS;

const stringField = z.string().min(1).max(32_768).optional();
const workspaceIdField = z.string().min(1).max(128).optional();
const nonNegativeInt = z.number().int().nonnegative().optional();
const positiveInt = z.number().int().positive().optional();
const booleanField = z.boolean().optional();
const stringArray = z.array(z.string().max(32_768)).max(512).optional();
const recordField = z.record(z.string(), z.unknown()).optional();
const recordArray = z.array(z.record(z.string(), z.unknown())).max(256).optional();

const FIELD_SCHEMAS = {
  workspaceId: workspaceIdField,
  query: stringField,
  path: stringField,
  symbol: stringField,
  prompt: stringField,
  goal: stringField,
  goalId: z.string().min(1).max(128).optional(),
  name: stringField,
  title: stringField,
  tool: stringField,
  plugin: stringField,
  target: stringField,
  database: stringField,
  primary: stringField,
  baseline: stringField,
  actual: stringField,
  left_path: stringField,
  right_path: stringField,
  dryRun: booleanField,
  dry_run: booleanField,
  mode: stringField,
  service: stringField,
  key: stringField,
  log_name: stringField,
  logName: stringField,
  max_events: positiveInt,
  max_messages: positiveInt,
  top_count: positiveInt,
  server: stringField,
  executable: stringField,
  inputFile: stringField,
  inputSha256: stringField,
  command: stringField,
  cwd: stringField,
  arguments: stringArray,
  taskId: stringField,
  task_id: stringField,
  task: stringField,
  skillId: stringField,
  instruction: stringField,
  delegateId: stringField,
  eccAgentId: stringField,
  swarmId: stringField,
  idempotencyKey: stringField,
  maxConcurrency: positiveInt,
  tasks: recordArray,
  action: stringField,
  tab_id: stringField,
  tabId: stringField,
  selector: stringField,
  continuationToken: stringField,
  limit: positiveInt,
  topK: positiveInt,
  category: stringField,
  reranker: stringField,
  model: stringField,
  id: stringField,
  version: stringField,
  schema: recordField,
  permission: stringField,
  source: stringField,
  summary: z.string().max(65_536).optional(),
  file_path: stringField,
  baseline_path: stringField,
  actual_path: stringField,
  baseline_base64: z.string().max(8_388_608).optional(),
  actual_base64: z.string().max(8_388_608).optional(),
  left_base64: z.string().max(8_388_608).optional(),
  right_base64: z.string().max(8_388_608).optional(),
  profile: recordField,
  hours: positiveInt,
  files: z.array(z.union([z.string().max(4096), z.record(z.string(), z.unknown())])).max(512).optional(),
  file: stringField,
  newName: stringField,
  new_name: stringField,
  line: nonNegativeInt,
  character: nonNegativeInt,
  worktreePath: stringField,
  ref: stringField,
  merge_paths: stringArray,
  target_path: stringField,
  source_path: stringField,
  sourcePath: stringField,
  relativePath: stringField,
  operation: stringField,
  cursor: stringField,
  maxBytes: positiveInt,
  max_rows: positiveInt,
  parameters: z.array(z.unknown()).max(2048).optional(),
  input: recordField,
  stepArguments: z.record(z.string().max(128), z.record(z.string(), z.unknown())).refine((value) => Object.keys(value).length <= 16).optional(),
  since: stringField,
  phase: stringField,
  resultCode: stringField,
  toolName: stringField,
  correlationId: stringField,
  callId: stringField,
  traceId: stringField,
  scope: stringField,
  event: stringField,
  language: stringField,
  provider: stringField,
  kind: stringField,
  artifactId: stringField,
  hookProfile: stringField,
  userMemoryEnabled: booleanField,
  selectedRules: stringArray,
  body: z.string().max(131_072).optional(),
  sourceHarness: stringField,
  targetHarness: stringField,
  targetHarnesses: stringArray,
  tags: stringArray,
  links: stringArray,
  scopes: stringArray,
  connection: stringField,
  sql: z.string().max(262_144).optional(),
  params: z.array(z.unknown()).max(2048).optional(),
  timeoutMs: positiveInt,
  timeout_seconds: positiveInt,
  timeoutSeconds: positiveInt,
  jobId: stringField,
  planId: stringField,
  fixIds: stringArray,
  scenario: stringField,
  folder: stringField,
  iterations: positiveInt,
  maxResults: positiveInt,
  maxCommits: positiveInt,
  maxDepth: nonNegativeInt,
  includeIgnored: booleanField,
  includeGenerated: booleanField,
  includeBinary: booleanField,
  includeTests: booleanField,
  includeDependencies: booleanField,
  includeMetadata: booleanField,
  enabled: booleanField,
  streamable: booleanField,
  parallelSafe: booleanField,
  overwriteExisting: booleanField,
  overwrite_existing: booleanField,
} as const;

function mapEntries(names: readonly string[], fields: readonly FieldName[]): Readonly<Record<string, readonly FieldName[]>> {
  return Object.fromEntries(names.map((name) => [name, fields]));
}

const INPUT_FIELDS: Readonly<Record<string, readonly FieldName[]>> = Object.freeze({
  ...mapEntries(['symbol_search', 'find_definition', 'find_references', 'find_implementations', 'call_hierarchy', 'type_search'], ['workspaceId', 'query', 'limit']),
  ...mapEntries(['import_graph', 'dependency_graph', 'module_graph', 'dependency_context'], ['workspaceId', 'path', 'maxDepth']),
  trace_symbol: ['workspaceId', 'symbol', 'maxDepth'],
  context_ranking: ['query', 'limit'],
  ...mapEntries(['debug_context', 'review_context', 'change_context', 'symbol_context', 'test_context', 'git_context', 'frontend_context', 'backend_context', 'dev_context'], ['workspaceId', 'query', 'limit']),
  route_intent: ['prompt', 'query'],
  recipe_describe: ['name'],
  recipe_run: ['prompt', 'name', 'dryRun', 'workspaceId', 'tab_id', 'stepArguments'],
  dry_run: ['prompt', 'query'],
  review_changes: ['workspaceId', 'goalId'],
  changed_symbols: ['workspaceId', 'query', 'limit'],
  affected_modules: ['workspaceId'],
  git_history_context: ['workspaceId', 'limit', 'maxCommits'],
  git_blame_context: ['workspaceId', 'path'],
  discover_tests: ['workspaceId', 'query'],
  run_affected_tests: ['workspaceId', 'dryRun'],
  test_failures: ['workspaceId', 'limit'],
  coverage_context: ['workspaceId', 'path'],
  test_history: ['workspaceId', 'limit'],
  cache_stats: ['workspaceId'],
  cache_invalidate: ['path', 'scope'],
  hook_register: ['name', 'event'],
  hook_remove: ['name'],
  skill_match: ['query', 'prompt', 'source', 'limit'],
  skill_load: ['skillId', 'id', 'name', 'relativePath', 'path', 'workspaceId', 'goalId'],
  ...mapEntries(['plugin_install', 'plugin_enable', 'plugin_disable', 'plugin_remove'], ['name', 'plugin', 'source', 'version', 'enabled']),
  session_checkpoint: ['summary', 'prompt'],
  response_mode: ['mode'],
  ...mapEntries(['inspect_web_app', 'debug_ui', 'capture_ui_state', 'form_context', 'browser_debug_context', 'capture_screenshot', 'dom_snapshot', 'layout_metadata', 'visual_context'], ['tab_id', 'tabId', 'selector']),
  service_context: ['service', 'name'],
  process_context: ['top_count'],
  registry_context: ['key'],
  event_log_context: ['log_name', 'provider', 'max_events'],
  path_context: ['executable'],
  mcp_resources: ['server'],
  task_create: ['workspaceId', 'goalId', 'executable', 'command', 'arguments', 'cwd', 'timeoutMs', 'timeout_seconds'],
  ...mapEntries(['task_status', 'task_cancel', 'task_result'], ['workspaceId', 'taskId', 'task_id']),
  task_list: ['workspaceId'],
  delegate: ['workspaceId', 'instruction', 'prompt', 'task', 'taskId', 'idempotencyKey', 'eccAgentId'],
  ...mapEntries(['delegate_status', 'delegate_cancel'], ['workspaceId', 'delegateId', 'swarmId']),
  delegate_result: ['workspaceId', 'delegateId', 'swarmId', 'taskId', 'cursor', 'maxBytes'],
  parallel_delegate: ['workspaceId', 'tasks', 'idempotencyKey', 'maxConcurrency'],
  permission_check: ['action', 'permission', 'tool', 'input'],
  live_logs_query: ['workspaceId', 'limit', 'toolName', 'tool', 'correlationId', 'callId', 'traceId', 'phase', 'resultCode'],
  execution_plan: ['prompt', 'query'],
  recovery_status: ['workspaceId', 'goalId'],
  repo_map: ['workspaceId', 'path', 'maxDepth'],
  context_expand: ['workspaceId', 'path', 'query'],
  tool_schema_register: ['id', 'name', 'version', 'schema', 'permission', 'streamable', 'parallelSafe'],
  ...mapEntries(['tool_search', 'tool_dynamic_filter', 'tool_function_find'], ['query', 'prompt', 'limit', 'topK', 'category', 'reranker', 'model']),
  tool_describe: ['name', 'tool'],
  compare_screenshot: ['baseline_base64', 'actual_base64', 'left_base64', 'right_base64'],
  inspect_workbook: ['workspaceId', 'file_path', 'path', 'file'],
  compare_workbook_layout: ['workspaceId', 'baseline_path', 'actual_path', 'baseline', 'actual', 'left_path', 'right_path'],
  render_excel_preview: ['workspaceId', 'file_path', 'path', 'file'],
  inspect_pdf: ['workspaceId', 'file_path', 'path', 'file'],
  compare_pdf_pages: ['workspaceId', 'baseline_path', 'actual_path', 'baseline', 'actual', 'left_path', 'right_path'],
  project_profile_get: ['workspaceId'],
  project_profile_set: ['workspaceId', 'profile'],
  benchmark_run: ['workspaceId', 'name', 'iterations', 'dryRun', 'dry_run', 'scenario', 'timeoutMs'],
  regression_report: ['workspaceId'],
  event_watch: ['log_name', 'logName', 'provider', 'since', 'max_events'],
  crash_trace: ['log_name', 'logName', 'provider', 'since', 'hours', 'max_events'],
  lsp_diagnostics: ['workspaceId', 'files', 'file', 'language'],
  lsp_rename: ['workspaceId', 'files', 'file', 'language', 'newName', 'new_name', 'line', 'character'],
  git_worktree_spawn: ['workspaceId', 'worktreePath', 'ref', 'dryRun'],
  git_worktree_remove: ['workspaceId', 'worktreePath', 'dryRun'],
  db_inspect: ['workspaceId', 'target', 'path', 'database'],
  db_query: ['workspaceId', 'target', 'path', 'database', 'sql', 'params', 'parameters', 'max_rows'],
  office_ppt: ['workspaceId', 'action', 'file_path', 'path', 'target_path', 'target', 'dryRun', 'dry_run'],
  office_outlook: ['action', 'folder', 'max_messages'],
  pdf_extract_tables: ['workspaceId', 'file_path', 'path', 'file'],
  docx_merge: ['workspaceId', 'file_path', 'primary', 'merge_paths', 'target_path', 'target', 'dryRun', 'dry_run'],
  self_heal_plan: ['workspaceId'],
  self_heal_apply: ['workspaceId', 'id', 'planId', 'fixIds', 'dryRun', 'dry_run'],
  sandbox_exec: ['workspaceId', 'jobId', 'executable', 'inputFile', 'inputSha256', 'arguments', 'timeoutSeconds', 'dryRun'],
  skills_import: ['workspaceId', 'source_path', 'sourcePath', 'path', 'name', 'dryRun', 'dry_run', 'overwriteExisting', 'overwrite_existing'],
  agent_swarm_run: ['operation', 'workspaceId', 'instruction', 'prompt', 'task', 'taskId', 'delegateId', 'swarmId', 'cursor', 'maxBytes', 'tasks', 'idempotencyKey', 'maxConcurrency'],
  ecc_catalog: ['kind', 'query', 'limit'],
  ecc_load: ['id', 'artifactId'],
  ecc_configure: ['enabled', 'mode', 'hookProfile', 'userMemoryEnabled', 'selectedRules'],
  ecc_security_scan: ['workspaceId', 'target', 'timeoutSeconds', 'dryRun', 'dry_run'],
  ecc_memory_save: ['workspaceId', 'scope', 'title', 'body', 'kind', 'sourceHarness', 'targetHarnesses', 'tags', 'links'],
  ecc_memory_search: ['workspaceId', 'query', 'scopes', 'targetHarness', 'limit'],
  ecc_memory_read: ['workspaceId', 'id', 'scopes'],
  ecc_memory_doctor: ['workspaceId', 'scopes'],
});

// Empty-input tools are intentionally strict too: accidental or hallucinated fields
// are rejected instead of being silently ignored. Any tool absent from INPUT_FIELDS
// therefore accepts only an empty object before the shared approval/goal envelopes
// are applied by ToolRegistry.
export function upgradeToolInputSchema(entry: UpgradeToolCatalogEntry): z.ZodObject | typeof debugStepInputSchema {
  if (entry.name === 'debug_attach') return debugAttachInputSchema;
  if (entry.name === 'debug_step') return debugStepInputSchema;
  if (entry.name === 'handoff_context') return handoffContextInputSchema;
  if (isOfficeSemanticToolName(entry.name)) return officeToolInputSchema(entry.name);
  const fields = INPUT_FIELDS[entry.name] ?? [];
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) shape[field] = FIELD_SCHEMAS[field];
  return z.object(shape).strict();
}

export const upgradeToolOutputSchema = z.object({
  tool: z.string().optional(),
  status: z.string().optional(),
  available: z.boolean().optional(),
  ready: z.boolean().optional(),
  executed: z.boolean().optional(),
}).catchall(z.unknown());

const OPEN_WORLD_TAGS = new Set(['web', 'network', 'mcp', 'gateway', 'plugin', 'skills', 'outlook', 'external']);

export function upgradeToolAnnotations(entry: UpgradeToolCatalogEntry): McpToolAnnotations {
  return {
    readOnlyHint: entry.permission === 'READ',
    destructiveHint: entry.permission === 'DANGEROUS',
    idempotentHint: entry.permission === 'READ',
    openWorldHint: entry.tags.some((tag) => OPEN_WORLD_TAGS.has(tag.toLowerCase())),
  };
}

const TASK_CAPABLE_TOOLS = new Set([
  'task_create', 'benchmark_run', 'run_affected_tests', 'delegate', 'parallel_delegate',
  'agent_swarm_run', 'sandbox_exec', 'debug_attach', 'event_watch',
]);

export function upgradeToolExecution(entry: UpgradeToolCatalogEntry): McpToolExecution {
  // Modern task execution is wired in a later v4.55 phase. Keep the catalog
  // conservative until the transport extension is active, but centralize the
  // eligibility now so that phase can flip only these reviewed tools.
  return { taskSupport: TASK_CAPABLE_TOOLS.has(entry.name) ? 'forbidden' : 'forbidden' };
}

export function upgradeToolInputJsonSchema(entry: UpgradeToolCatalogEntry): Record<string, unknown> {
  const schema = z.toJSONSchema(upgradeToolInputSchema(entry));
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : { type: 'object', additionalProperties: false };
}

export function upgradeToolOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(upgradeToolOutputSchema);
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : { type: 'object' };
}
