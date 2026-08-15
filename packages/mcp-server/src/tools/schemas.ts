import { z } from 'zod';
import { MAX_SEARCH_RESULTS, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, MAX_MULTI_FILE_BYTES } from '@lnwjud/domain';

const MAX_PATH_LENGTH = 4096;
const MAX_WORKSPACE_ID_LENGTH = 128;
const MAX_INSTRUCTION_BYTES = 256 * 1024;

export const workspaceIdSchema = z.string().trim().min(1).max(MAX_WORKSPACE_ID_LENGTH);
export const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine((value) => !value.includes('\0'), 'Path is invalid');
export const lineRangeSchema = z.object({
  startLine: z.number().int().min(1).max(1_000_000).optional(),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
}).refine((value) => value.startLine === undefined || value.endLine === undefined || value.startLine <= value.endLine, 'Line range is invalid');

export const workspaceInfoSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const workspaceTreeSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema.optional(), maxDepth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(), maxEntries: z.number().int().min(1).max(MAX_TREE_ENTRIES).optional() }).strict();
export const projectSnapshotSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const readFileSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema, ...lineRangeSchema.shape }).strict().refine((value) => value.startLine === undefined || value.endLine === undefined || value.startLine <= value.endLine, 'Line range is invalid');
export const readFilesSchema = z.object({ workspaceId: workspaceIdSchema, files: z.array(readFileSchema.omit({ workspaceId: true })).min(1).max(20) }).strict();
export const searchFilesSchema = z.object({ workspaceId: workspaceIdSchema, glob: z.string().max(1024).optional(), maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional() }).strict();
export const searchTextSchema = searchFilesSchema.extend({ query: z.string().min(1).max(32_768) }).strict();
export const gitStatusSchema = workspaceInfoSchema;
export const gitDiffSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema.optional(), staged: z.boolean().optional(), maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional() }).strict();
export const gitLogSchema = z.object({ workspaceId: workspaceIdSchema, maxCommits: z.number().int().min(1).max(100).optional(), maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional() }).strict();
export const writeFileSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema, content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'File is too large') }).strict();
export const applyPatchSchema = z.object({ workspaceId: workspaceIdSchema, files: z.array(z.object({ path: pathSchema, content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MULTI_FILE_BYTES, 'File is too large') }).strict()).min(1).max(20) }).strict();
export const moveFileSchema = z.object({ workspaceId: workspaceIdSchema, sourcePath: pathSchema, destinationPath: pathSchema }).strict();
export const deleteFileSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: pathSchema,
  /** Must be true after the human confirms deletion in chat. Silent deletes are blocked. */
  userConfirmed: z.boolean().optional(),
}).strict();

export const workspaceListSchema = z.object({}).strict();
export const workspaceRegisterSchema = z.object({
  parentWorkspaceId: workspaceIdSchema,
  path: pathSchema,
  displayName: z.string().trim().min(1).max(256).optional(),
}).strict();
export const processStartSchema = z.object({ workspaceId: workspaceIdSchema, executable: z.string().trim().min(1).max(1024), args: z.array(z.string().max(32_768)).max(128), cwd: pathSchema.optional(), timeoutMs: z.number().int().min(1).max(4 * 60 * 60 * 1000).optional() }).strict();
export const processHandleSchema = z.object({ workspaceId: workspaceIdSchema, processId: z.string().trim().min(1).max(128) }).strict();
export const processLogsSchema = processHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();
export const codexStatusSchema = z.object({}).strict();
export const codexRunSchema = z.object({ workspaceId: workspaceIdSchema, instruction: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_INSTRUCTION_BYTES, 'Instruction is too large') }).strict();
export const codexTaskHandleSchema = z.object({ workspaceId: workspaceIdSchema, codexTaskId: z.string().trim().min(1).max(128) }).strict();
export const codexTaskLogsSchema = codexTaskHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();

const capabilityMetadataSchema = z.record(z.string(), z.unknown());
const capabilityParametersSchema = z.record(z.string(), z.unknown());
const capabilityApprovalSchema = z.enum(['use_policy', 'always_ask', 'skip']).default('use_policy');
const capabilityRequestSchema = {
  request_id: z.string().trim().min(1).max(128).optional(),
  metadata: capabilityMetadataSchema.optional(),
  dry_run: z.boolean().default(false),
};

export const shellCapabilitySchema = z.object({
  operation: z.enum(['run', 'status', 'wait', 'logs', 'result', 'cancel', 'resume', 'approve', 'deny']).default('run'),
  executable: z.string().trim().min(1).max(1024).optional(),
  arguments: z.array(z.string().max(32_768)).max(128).optional(),
  privilege: z.enum(['user', 'admin']).default('user'),
  cwd: pathSchema.optional(),
  execution: z.enum(['foreground', 'background', 'auto']).default('auto'),
  task_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  max_output_bytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
  tail_lines: z.number().int().min(0).max(10_000).optional(),
  include_stdout: z.boolean().default(true),
  include_stderr: z.boolean().default(true),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict();

const domStepSchema = z.object({
  action: z.string().trim().min(1).max(128),
  parameters: capabilityParametersSchema.optional(),
}).strict();

export const domCdpCapabilitySchema = z.object({
  action: z.enum(['launch', 'status', 'list_tabs', 'new_tab', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot']).optional(),
  parameters: capabilityParametersSchema.optional(),
  steps: z.array(domStepSchema).min(1).max(100).optional(),
  tab_id: z.string().trim().min(1).max(256).optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(3600).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict();

export const accessibilityCapabilitySchema = z.object({
  action: z.enum(['status', 'launch_app', 'activate_app', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'click', 'focus', 'read_value', 'set_value', 'select_item', 'menu_select', 'close_window', 'minimize_window', 'maximize_window', 'restore_window', 'set_window_frame']),
  parameters: capabilityParametersSchema.optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict();

export const inputEventCapabilitySchema = z.object({
  operation: z.enum(['type_text', 'paste_text', 'press_key', 'hotkey', 'key_down', 'key_up', 'mouse_move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'button_down', 'button_up', 'release_all', 'sequence']),
  parameters: capabilityParametersSchema.optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  approval: capabilityApprovalSchema,
  ...capabilityRequestSchema,
}).strict();

export const visionCapabilitySchema = z.object({
  action: z.enum(['capture_display', 'capture_region', 'capture_window', 'ocr']),
  region: capabilityParametersSchema.optional(),
  app: capabilityParametersSchema.optional(),
  window_index: z.number().int().min(0).optional(),
  text: z.string().max(32_768).optional(),
  exact: z.boolean().default(false),
  min_confidence: z.number().min(0).max(1).optional(),
  display_id: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

export const windowCapabilitySchema = z.object({
  operation: z.enum(['list', 'get_active', 'get_bounds', 'get_display', 'activate', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize', 'set_window_frame']),
  parameters: capabilityParametersSchema.optional(),
  timeout_seconds: z.number().min(0.1).max(14_400).optional(),
  ...capabilityRequestSchema,
}).strict();

export const healthCapabilitySchema = z.object({
  operation: z.enum(['check_all', 'check_tool']).default('check_all'),
  tool: z.enum(['shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health']).optional(),
  request_id: z.string().trim().min(1).max(128).optional(),
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
}).strict();
