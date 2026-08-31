import { z } from 'zod';
import { MAX_SEARCH_RESULTS, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, MAX_MULTI_FILE_BYTES } from '@lnwjud/domain';

const MAX_PATH_LENGTH = 4096;
const MAX_WORKSPACE_ID_LENGTH = 128;
const MAX_INSTRUCTION_BYTES = 256 * 1024;

export const workspaceIdSchema = z.string().trim().min(1).max(MAX_WORKSPACE_ID_LENGTH);
export const optionalWorkspaceIdSchema = workspaceIdSchema.optional();
export const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine((value) => !value.includes('\0'), 'Path is invalid');
export const lineRangeSchema = z.object({
  startLine: z.number().int().min(1).max(1_000_000).optional(),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
}).refine((value) => value.startLine === undefined || value.endLine === undefined || value.startLine <= value.endLine, 'Line range is invalid');

export const workspaceInfoSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const workspaceTreeSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, path: pathSchema.optional(), maxDepth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(), maxEntries: z.number().int().min(1).max(MAX_TREE_ENTRIES).optional() }).strict();
export const projectSnapshotSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const readFileSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, path: pathSchema, ...lineRangeSchema.shape }).strict().refine((value) => value.startLine === undefined || value.endLine === undefined || value.startLine <= value.endLine, 'Line range is invalid');
export const readFilePageSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema,
  startLine: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(5_000).optional(),
  responseTargetBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
}).strict();
export const readFilePageContinueSchema = z.object({
  continuationToken: z.string().trim().min(1).max(128),
  pageSize: z.number().int().min(1).max(5_000).optional(),
}).strict();
export const readFilesSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, files: z.array(readFileSchema.omit({ workspaceId: true })).min(1).max(20) }).strict();
export const searchFilesSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, path: pathSchema.optional(), glob: z.string().max(1024).optional(), maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(), includeIgnored: z.boolean().default(false) }).strict();
export const searchTextSchema = searchFilesSchema.extend({ query: z.string().min(1).max(32_768) }).strict();
export const gitStatusSchema = workspaceInfoSchema;
export const gitDiffSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema.optional(), staged: z.boolean().optional(), maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional() }).strict();
export const gitLogSchema = z.object({ workspaceId: workspaceIdSchema, maxCommits: z.number().int().min(1).max(100).optional(), maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional() }).strict();
export const gitRunSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  cwd: pathSchema.optional(),
  args: z.array(z.string().min(1).max(32_768)).min(1).max(128),
  timeoutSeconds: z.number().min(0.1).max(300).optional(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const writeFileSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema,
  content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'File is too large'),
  overwriteExisting: z.boolean().optional(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const applyPatchSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, files: z.array(z.object({ path: pathSchema, content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'File is too large') }).strict()).min(1).max(20), userConfirmed: z.boolean().optional() }).strict();
export const editFileSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema,
  oldText: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'Match text is too large'),
  newText: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'Replacement text is too large'),
  expectedOccurrences: z.number().int().min(1).max(100).optional(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const moveFileSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  sourcePath: pathSchema,
  destinationPath: pathSchema,
  userConfirmed: z.boolean().optional(),
}).strict();
export const copyFileSchema = z.object({ workspaceId: optionalWorkspaceIdSchema, sourcePath: pathSchema, destinationPath: pathSchema }).strict();
export const deleteFileSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema,
  /** True only after caller-supplied human confirmation. Trusted policy/Full Bypass authorization is carried out-of-band and never forged into this field. */
  userConfirmed: z.boolean().optional(),
}).strict();
export const restoreDeletedFileSchema = z.object({
  workspaceId: workspaceIdSchema,
  recoveryId: z.string().uuid(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const listRecoveryItemsSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const listCheckpointsSchema = z.object({
  workspaceId: workspaceIdSchema,
  limit: z.number().int().min(1).max(500).optional(),
}).strict();
export const restoreCheckpointSchema = z.object({
  workspaceId: workspaceIdSchema,
  checkpointId: z.string().uuid(),
  userConfirmed: z.boolean().optional(),
}).strict();

export const workspaceListSchema = z.object({}).strict();
export const workspaceRegisterSchema = z.object({
  parentWorkspaceId: optionalWorkspaceIdSchema,
  path: pathSchema,
  displayName: z.string().trim().min(1).max(256).optional(),
}).strict();
export const processStartSchema = z.object({ workspaceId: workspaceIdSchema, executable: z.string().trim().min(1).max(1024), args: z.array(z.string().max(32_768)).max(128), cwd: pathSchema.optional(), timeoutMs: z.number().int().min(1).max(4 * 60 * 60 * 1000).optional(), userConfirmed: z.boolean().optional() }).strict();
export const processHandleSchema = z.object({ workspaceId: workspaceIdSchema, processId: z.string().trim().min(1).max(128) }).strict();
export const processStopSchema = processHandleSchema.extend({ userConfirmed: z.boolean().optional() }).strict();
export const projectCommandSchema = z.object({ workspaceId: workspaceIdSchema, userConfirmed: z.boolean().optional() }).strict();
export const processLogsSchema = processHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();
export const codexStatusSchema = z.object({}).strict();
export const codexRunSchema = z.object({ workspaceId: workspaceIdSchema, instruction: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_INSTRUCTION_BYTES, 'Instruction is too large'), userConfirmed: z.boolean().optional() }).strict();
export const codexTaskHandleSchema = z.object({ workspaceId: workspaceIdSchema, codexTaskId: z.string().trim().min(1).max(128) }).strict();
export const codexStopSchema = codexTaskHandleSchema.extend({ userConfirmed: z.boolean().optional() }).strict();
export const codexTaskLogsSchema = codexTaskHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();

const batchCallSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  tool: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
  timeoutMs: z.number().int().min(1).max(4 * 60 * 60 * 1000).optional(),
}).strict();

const batchGroupSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  parallel: z.boolean().default(true),
  calls: z.array(batchCallSchema).min(1).max(50),
}).strict();

export const toolBatchSchema = z.object({
  parallel: z.boolean().default(true),
  calls: z.array(batchCallSchema).max(50).optional(),
  groups: z.array(batchGroupSchema).max(20).optional(),
}).strict()
  .refine((value) => (value.calls?.length ?? 0) > 0 || (value.groups?.length ?? 0) > 0, 'At least one batch call is required')
  .refine((value) => {
    const grouped = value.groups?.reduce((total, group) => total + group.calls.length, 0) ?? 0;
    return (value.calls?.length ?? 0) + grouped <= 50;
  }, 'A batch cannot contain more than 50 calls');

export const workspaceContextSchema = z.object({
  query: z.string().trim().min(1).max(32_768),
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema.optional(),
  intent: z.enum(['auto', 'debug', 'implement', 'review', 'trace', 'explore']).default('auto'),
  mode: z.enum(['optimized', 'full', 'exhaustive']).default('optimized'),
  includeIgnored: z.boolean().default(false),
  responseTargetBytes: z.number().int().min(1024).max(8 * 1024 * 1024).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
}).strict();
export const workspaceContextContinueSchema = z.object({
  continuationToken: z.string().trim().min(1).max(128),
  pageSize: z.number().int().min(1).max(500).optional(),
}).strict();
export const workspaceFullScanSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema.optional(),
  glob: z.string().max(1024).optional(),
  includeIgnored: z.boolean().default(true),
  pageSize: z.number().int().min(1).max(500).optional(),
}).strict();
export const workspaceFullScanContinueSchema = workspaceContextContinueSchema;
export const workspaceSnapshotSchema = workspaceInfoSchema;
export const searchAllSchema = z.object({
  query: z.string().trim().min(1).max(32_768),
  workspaceId: optionalWorkspaceIdSchema,
  path: pathSchema.optional(),
  glob: z.string().max(1024).optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
  includeIgnored: z.boolean().default(false),
}).strict();
export const readManyFilesSchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  files: z.array(readFileSchema.omit({ workspaceId: true })).min(1).max(500),
}).strict();
export const workspaceIndexSchema = z.object({
  workspaceId: workspaceIdSchema,
  rebuild: z.boolean().default(false),
  includeIgnored: z.boolean().default(false),
}).strict();
export const workspaceIndexStatusSchema = workspaceInfoSchema;
export const workspaceIndexWatchSchema = z.object({
  workspaceId: workspaceIdSchema,
  debounceMs: z.number().int().min(0).max(60_000).optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
}).strict();
export const workspaceIndexStopSchema = workspaceInfoSchema;

const capabilityMetadataSchema = z.record(z.string(), z.unknown());
const capabilityParametersSchema = z.record(z.string(), z.unknown());

function hasFiniteParameter(parameters: Record<string, unknown> | undefined, name: string): boolean {
  return typeof parameters?.[name] === 'number' && Number.isFinite(parameters[name]);
}

function hasPositiveParameter(parameters: Record<string, unknown> | undefined, name: string): boolean {
  return hasFiniteParameter(parameters, name) && (parameters?.[name] as number) > 0;
}

function hasNonEmptyStringParameter(parameters: Record<string, unknown> | undefined, name: string): boolean {
  return typeof parameters?.[name] === 'string' && (parameters[name] as string).trim().length > 0;
}

function hasWindowSelector(parameters: Record<string, unknown> | undefined): boolean {
  return parameters !== undefined && (
    hasFiniteParameter(parameters, 'hwnd')
    || hasFiniteParameter(parameters, 'window_index')
    || hasNonEmptyStringParameter(parameters, 'title')
    || hasNonEmptyStringParameter(parameters, 'process_name')
  );
}

function hasSemanticUiTarget(parameters: Record<string, unknown> | undefined): boolean {
  return hasNonEmptyStringParameter(parameters, 'automation_id') || hasNonEmptyStringParameter(parameters, 'name');
}

function addParameterIssue(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parameters'], message });
}
const capabilityApprovalSchema = z.enum(['use_policy', 'always_ask', 'skip']).default('use_policy');
const capabilityRequestSchema = {
  request_id: z.string().trim().min(1).max(128).optional(),
  metadata: capabilityMetadataSchema.optional(),
  dry_run: z.boolean().default(false),
  userConfirmed: z.boolean().optional(),
};

export const shellCapabilitySchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  operation: z.enum(['run', 'list', 'status', 'wait', 'logs', 'result', 'cancel', 'resume', 'approve', 'deny']).default('run'),
  executable: z.string().trim().min(1).max(1024).optional(),
  arguments: z.array(z.string().max(32_768)).max(128).optional(),
  privilege: z.enum(['user', 'admin']).default('user'),
  cwd: pathSchema.optional(),
  execution: z.enum(['foreground', 'background', 'auto']).default('background'),
  task_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(604_800).optional(),
  max_output_bytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
  tail_lines: z.number().int().min(0).max(10_000).optional(),
  include_stdout: z.boolean().default(true),
  include_stderr: z.boolean().default(true),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict();

const wslEnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4_096)).refine((value) => Object.keys(value).length <= 64, 'WSL environment has too many entries');

export const wslCapabilitySchema = z.object({
  operation: z.enum(['run', 'status', 'wait', 'logs', 'result', 'cancel']).default('run'),
  workspaceId: workspaceIdSchema.optional(),
  distro: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
  executable: z.string().trim().min(1).max(1_024).optional(),
  arguments: z.array(z.string().max(32_768)).max(128).optional(),
  cwd: pathSchema.optional(),
  environment: wslEnvironmentSchema.optional(),
  execution: z.enum(['foreground', 'background', 'auto']).default('background'),
  task_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  max_output_bytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
  tail_lines: z.number().int().min(0).max(10_000).optional(),
  include_stdout: z.boolean().default(true),
  include_stderr: z.boolean().default(true),
  ...capabilityRequestSchema,
}).strict();

export const wslFilesystemCapabilitySchema = z.object({
  operation: z.enum(['status', 'translate', 'metadata']).default('translate'),
  workspaceId: workspaceIdSchema.optional(),
  direction: z.enum(['windows_to_wsl', 'wsl_to_windows']).optional(),
  distro: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
  path: pathSchema.optional(),
  ...capabilityRequestSchema,
}).strict();

const domActionSchema = z.enum([
  'launch', 'status', 'list_tabs', 'new_tab', 'close_tab', 'navigate',
  'evaluate', 'query', 'click', 'type', 'wait', 'screenshot',
]);
const domTargetActions = new Set([
  'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot',
]);

const domStepSchema = z.object({
  action: domActionSchema,
  parameters: capabilityParametersSchema.optional(),
}).strict();

export const domCdpCapabilitySchema = z.object({
  action: domActionSchema.optional(),
  parameters: capabilityParametersSchema.optional(),
  steps: z.array(domStepSchema).min(1).max(100).optional(),
  tab_id: z.string().trim().min(1).max(256).optional(),
  allow_protected_tab_action: z.boolean().default(false),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(3600).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.action === undefined) === (value.steps === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of action or steps' });
  }
  const actions = value.steps?.map((step) => step.action) ?? (value.action === undefined ? [] : [value.action]);
  if (actions.some((action) => domTargetActions.has(action)) && value.tab_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tab_id'], message: 'Target-scoped DOM actions require tab_id' });
  }
  value.steps?.forEach((step, index) => {
    if (step.parameters !== undefined && 'tab_id' in step.parameters) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'parameters', 'tab_id'], message: 'Use the top-level tab_id for the whole batch' });
    }
  });
});

export const accessibilityCapabilitySchema = z.object({
  action: z.enum(['status', 'launch_app', 'activate_app', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'click', 'focus', 'read_value', 'set_value', 'select_item', 'menu_select', 'close_window', 'minimize_window', 'maximize_window', 'restore_window', 'set_window_frame']),
  parameters: capabilityParametersSchema.optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict().superRefine((value, ctx) => {
  const parameters = value.parameters;
  if (value.action === 'launch_app' && !hasNonEmptyStringParameter(parameters, 'executable')) {
    addParameterIssue(ctx, 'accessibility launch_app requires parameters.executable');
  }
  if (['activate_app', 'close_window', 'minimize_window', 'maximize_window', 'restore_window', 'set_window_frame'].includes(value.action) && !hasWindowSelector(parameters)) {
    addParameterIssue(ctx, `accessibility ${value.action} requires a window selector`);
  }
  if (['find_element', 'click', 'focus', 'read_value', 'set_value', 'select_item', 'menu_select'].includes(value.action) && !hasSemanticUiTarget(parameters)) {
    addParameterIssue(ctx, `accessibility ${value.action} requires parameters.name or parameters.automation_id`);
  }
  if (value.action === 'set_window_frame' && (!hasFiniteParameter(parameters, 'x') || !hasFiniteParameter(parameters, 'y') || !hasPositiveParameter(parameters, 'width') || !hasPositiveParameter(parameters, 'height'))) {
    addParameterIssue(ctx, 'accessibility set_window_frame requires finite x/y and positive width/height');
  }
});

export const inputEventCapabilitySchema = z.object({
  operation: z.enum(['type_text', 'paste_text', 'press_key', 'hotkey', 'key_down', 'key_up', 'mouse_move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'button_down', 'button_up', 'release_all', 'sequence']),
  parameters: capabilityParametersSchema.optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict().superRefine((value, ctx) => {
  const parameters = value.parameters;
  if (['type_text', 'paste_text'].includes(value.operation) && typeof parameters?.text !== 'string') {
    addParameterIssue(ctx, `input_event ${value.operation} requires parameters.text`);
  }
  if (['press_key', 'hotkey', 'key_down', 'key_up'].includes(value.operation) && !(typeof parameters?.key === 'string' || typeof parameters?.key === 'number')) {
    addParameterIssue(ctx, `input_event ${value.operation} requires parameters.key`);
  }
  if (value.operation === 'hotkey' && (!Array.isArray(parameters?.modifiers) || parameters.modifiers.length < 1)) {
    addParameterIssue(ctx, 'input_event hotkey requires a non-empty parameters.modifiers array');
  }
  if (['mouse_move', 'click', 'double_click', 'right_click'].includes(value.operation) && (!hasFiniteParameter(parameters, 'x') || !hasFiniteParameter(parameters, 'y'))) {
    addParameterIssue(ctx, `input_event ${value.operation} requires finite parameters.x/y`);
  }
  if (value.operation === 'scroll' && !hasFiniteParameter(parameters, 'delta_y')) {
    addParameterIssue(ctx, 'input_event scroll requires finite parameters.delta_y');
  }
  if (value.operation === 'drag') {
    const from = parameters?.from;
    const to = parameters?.to;
    const validPoint = (point: unknown): boolean => typeof point === 'object' && point !== null && !Array.isArray(point)
      && typeof (point as Record<string, unknown>).x === 'number' && Number.isFinite((point as Record<string, unknown>).x)
      && typeof (point as Record<string, unknown>).y === 'number' && Number.isFinite((point as Record<string, unknown>).y);
    if (!validPoint(from) || !validPoint(to)) addParameterIssue(ctx, 'input_event drag requires finite parameters.from/to x/y points');
  }
  if (value.operation === 'sequence' && (!Array.isArray(parameters?.steps) || parameters.steps.length < 1 || parameters.steps.length > 100)) {
    addParameterIssue(ctx, 'input_event sequence requires 1 to 100 parameters.steps');
  }
});

export const visionCapabilitySchema = z.object({
  action: z.enum(['capture_display', 'capture_region', 'capture_window', 'annotate', 'ocr']),
  region: capabilityParametersSchema.optional(),
  app: capabilityParametersSchema.optional(),
  window_index: z.number().int().min(0).optional(),
  image_base64: z.string().min(1).max(16 * 1024 * 1024).optional(),
  marks: z.array(z.object({
    mark_id: z.string().trim().min(1).max(32),
    label: z.string().max(256).optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict(),
  }).strict()).max(500).optional(),
  text: z.string().max(32_768).optional(),
  exact: z.boolean().default(false),
  min_confidence: z.number().min(0).max(1).optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

export const visionAnnotatedCaptureSchema = z.object({
  workspaceId: workspaceIdSchema,
  capture: z.enum(['display', 'region', 'window']).default('display'),
  region: capabilityParametersSchema.optional(),
  app: capabilityParametersSchema.optional(),
  window_index: z.number().int().min(0).optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  max_depth: z.number().int().min(0).max(12).optional(),
  max_marks: z.number().int().min(1).max(500).optional(),
  ttl_seconds: z.number().min(1).max(300).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

export const uiTargetActionSchema = z.object({
  workspaceId: workspaceIdSchema,
  observationId: z.string().trim().min(1).max(128),
  markId: z.string().trim().min(1).max(32),
  observationHash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
  action: z.enum(['click', 'focus', 'read_value', 'set_value', 'select_item', 'menu_select']).default('click'),
  value: z.string().max(1_000_000).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

const computerUseTargetSchema = z.object({
  name: z.string().trim().min(1).max(512).optional(),
  automation_id: z.string().trim().min(1).max(512).optional(),
  observationId: z.string().trim().min(1).max(128).optional(),
  observationHash: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
  markId: z.string().trim().min(1).max(32).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
}).strict();

const computerUsePointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const computerUseSchema = z.object({
  workspaceId: workspaceIdSchema,
  action: z.enum(['snapshot', 'inspect', 'click', 'double_click', 'right_click', 'mouse_move', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag', 'activate_window']),
  app: capabilityParametersSchema.optional(),
  window_index: z.number().int().min(0).optional(),
  capture: z.enum(['display', 'region', 'window']).default('display'),
  region: capabilityParametersSchema.optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  target: computerUseTargetSchema.optional(),
  text: z.string().max(1_000_000).optional(),
  key: z.union([z.string().trim().min(1).max(64), z.number().int().min(0).max(65535)]).optional(),
  modifiers: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
  delta_y: z.number().int().min(-120_000).max(120_000).optional(),
  from: computerUsePointSchema.optional(),
  to: computerUsePointSchema.optional(),
  max_depth: z.number().int().min(0).max(12).optional(),
  max_items: z.number().int().min(1).max(2_000).optional(),
  max_marks: z.number().int().min(1).max(500).optional(),
  ttl_seconds: z.number().min(1).max(300).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

export const windowCapabilitySchema = z.object({
  operation: z.enum(['list', 'get_active', 'get_bounds', 'get_display', 'activate', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize', 'set_window_frame']),
  parameters: capabilityParametersSchema.optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict().superRefine((value, ctx) => {
  const parameters = value.parameters;
  if (!['list', 'get_active'].includes(value.operation) && !hasWindowSelector(parameters)) {
    addParameterIssue(ctx, `window ${value.operation} requires a window selector`);
  }
  if (value.operation === 'move' && (!hasFiniteParameter(parameters, 'x') || !hasFiniteParameter(parameters, 'y'))) {
    addParameterIssue(ctx, 'window move requires finite parameters.x/y');
  }
  if (value.operation === 'resize' && (!hasPositiveParameter(parameters, 'width') || !hasPositiveParameter(parameters, 'height'))) {
    addParameterIssue(ctx, 'window resize requires positive parameters.width/height');
  }
  if (value.operation === 'set_window_frame' && (!hasFiniteParameter(parameters, 'x') || !hasFiniteParameter(parameters, 'y') || !hasPositiveParameter(parameters, 'width') || !hasPositiveParameter(parameters, 'height'))) {
    addParameterIssue(ctx, 'window set_window_frame requires finite x/y and positive width/height');
  }
});

export const healthCapabilitySchema = z.object({
  operation: z.enum(['check_all', 'check_tool']).default('check_all'),
  tool: z.enum(['shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health', 'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch', 'audio', 'screen_record', 'office', 'scheduler', 'wsl_exec', 'wsl_fs']).optional(),
  request_id: z.string().trim().min(1).max(128).optional(),
}).strict();

export const systemInfoCapabilitySchema = z.object({
  operation: z.enum(['all', 'cpu', 'memory', 'disks', 'battery', 'uptime', 'os', 'processes']).default('all'),
  top_count: z.number().int().min(1).max(50).optional(),
  ...capabilityRequestSchema,
}).strict();

export const notificationCapabilitySchema = z.object({
  action: z.enum(['show']).default('show'),
  title: z.string().trim().min(1).max(120),
  message: z.string().min(1).max(2_000),
  ...capabilityRequestSchema,
}).strict();

export const fileDialogCapabilitySchema = z.object({
  action: z.enum(['open', 'save']),
  initial_directory: z.string().max(MAX_PATH_LENGTH).optional(),
  filter: z.string().max(512).optional(),
  multi_select: z.boolean().optional(),
  file_name: z.string().max(MAX_PATH_LENGTH).optional(),
  ...capabilityRequestSchema,
}).strict();

export const clipboardCapabilitySchema = z.object({
  action: z.enum(['get_text', 'set_text', 'get_image']),
  text: z.string().max(1_000_000).optional(),
  ...capabilityRequestSchema,
}).strict();

export const webFetchCapabilitySchema = z.object({
  url: z.string().trim().min(1).max(8_192),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD']).default('GET'),
  headers: z.array(z.object({ name: z.string().min(1).max(256), value: z.string().max(4_096) }).strict()).max(64).optional(),
  body: z.string().max(1_000_000).optional(),
  max_bytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
  timeout_seconds: z.number().min(1).max(600).optional(),
  ...capabilityRequestSchema,
}).strict();

export const audioCapabilitySchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  action: z.enum(['record', 'play', 'stop']),
  output_path: z.string().max(MAX_PATH_LENGTH).optional(),
  file_path: z.string().max(MAX_PATH_LENGTH).optional(),
  duration_seconds: z.number().int().min(1).max(600).optional(),
  ...capabilityRequestSchema,
}).strict();

export const screenRecordCapabilitySchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  action: z.enum(['start', 'stop', 'status']),
  output_path: z.string().max(MAX_PATH_LENGTH).optional(),
  offset_x: z.number().int().min(-16_384).max(16_384).optional(),
  offset_y: z.number().int().min(-16_384).max(16_384).optional(),
  width: z.number().int().min(1).max(7_680).optional(),
  height: z.number().int().min(1).max(4_320).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  ...capabilityRequestSchema,
}).strict();

export const officeCapabilitySchema = z.object({
  workspaceId: optionalWorkspaceIdSchema,
  app: z.enum(['excel', 'word', 'powerpoint', 'outlook']),
  action: z.enum(['read', 'write', 'read_text', 'replace', 'save_as', 'sheets', 'merge', 'list_folders', 'list_messages']),
  file_path: z.string().max(MAX_PATH_LENGTH).optional(),
  target_path: z.string().max(MAX_PATH_LENGTH).optional(),
  merge_paths: z.array(z.string().max(MAX_PATH_LENGTH)).max(32).optional(),
  folder: z.string().max(512).optional(),
  max_messages: z.number().int().min(1).max(100).optional(),
  sheet: z.string().max(256).optional(),
  range: z.string().max(256).optional(),
  values: capabilityParametersSchema.optional(),
  find: z.string().max(32_768).optional(),
  replace_with: z.string().max(32_768).optional(),
  ...capabilityRequestSchema,
}).strict();

export const schedulerCapabilitySchema = z.object({
  action: z.enum(['list', 'create', 'delete', 'run']).default('list'),
  task_name: z.string().regex(/^[\w .-]{1,200}$/).optional(),
  command: z.string().max(2_048).optional(),
  arguments: z.array(z.string().max(2_048)).max(64).optional(),
  schedule: z.string().regex(/^[A-Z]{1,16}$/i).optional(),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  ...capabilityRequestSchema,
}).strict();

export const skillsListSchema = z.object({
  query: z.string().max(1024).optional(),
  source: z.string().trim().min(1).max(256).optional(),
}).strict();

export const skillsReadSchema = z.object({
  skillId: z.string().trim().min(1).max(512),
  relativePath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
}).strict();

export const mcpListSchema = z.object({}).strict();

export const mcpDescribeSchema = z.object({
  server: z.string().trim().min(1).max(256),
}).strict();

export const mcpCallSchema = z.object({
  server: z.string().trim().min(1).max(256),
  tool: z.string().trim().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
  userConfirmed: z.boolean().optional(),
}).strict();
