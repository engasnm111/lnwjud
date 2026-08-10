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
export const deleteFileSchema = z.object({ workspaceId: workspaceIdSchema, path: pathSchema }).strict();
export const processStartSchema = z.object({ workspaceId: workspaceIdSchema, executable: z.string().trim().min(1).max(1024), args: z.array(z.string().max(32_768)).max(128), cwd: pathSchema.optional(), timeoutMs: z.number().int().min(1).max(30 * 60 * 1000).optional() }).strict();
export const processHandleSchema = z.object({ workspaceId: workspaceIdSchema, processId: z.string().trim().min(1).max(128) }).strict();
export const processLogsSchema = processHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();
export const codexStatusSchema = z.object({}).strict();
export const codexRunSchema = z.object({ workspaceId: workspaceIdSchema, instruction: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_INSTRUCTION_BYTES, 'Instruction is too large') }).strict();
export const codexTaskHandleSchema = z.object({ workspaceId: workspaceIdSchema, codexTaskId: z.string().trim().min(1).max(128) }).strict();
export const codexTaskLogsSchema = codexTaskHandleSchema.extend({ tailLines: z.number().int().min(1).max(10_000).optional(), sinceSequence: z.number().int().min(0).optional() }).strict();
