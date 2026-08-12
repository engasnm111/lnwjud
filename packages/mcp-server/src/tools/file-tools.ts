import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { applyPatchSchema, deleteFileSchema, moveFileSchema, readFileSchema, readFilesSchema, writeFileSchema } from './schemas.js';

export function fileTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'read_file',
      description: 'Read bounded UTF-8 text from a workspace file.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFileSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.readFile(context.actor, input.workspaceId, {
          path: input.path,
          ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
          ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        }),
    }),
    defineTool({
      name: 'read_files',
      description: 'Read up to twenty bounded UTF-8 workspace files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFilesSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.readFiles(context.actor, input.workspaceId, {
          files: input.files.map((file) => ({
            path: file.path,
            ...(file.startLine === undefined ? {} : { startLine: file.startLine }),
            ...(file.endLine === undefined ? {} : { endLine: file.endLine }),
          })),
        }),
    }),
    defineTool({
      name: 'write_file',
      description: 'Write UTF-8 text, checkpointing an existing target first.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: writeFileSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.writeFile(context.actor, input.workspaceId, { path: input.path, content: input.content }),
    }),
    defineTool({
      name: 'apply_patch',
      description: 'Validate and atomically apply bounded workspace file changes.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: applyPatchSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.applyPatch(context.actor, input.workspaceId, { files: input.files }),
    }),
    defineTool({
      name: 'move_file',
      description: 'Move a file within one authorized workspace.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: moveFileSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.moveFile(context.actor, input.workspaceId, { sourcePath: input.sourcePath, destinationPath: input.destinationPath }),
    }),
    defineTool({
      name: 'delete_file',
      description: 'Delete one file or an empty directory. Blocked until the user confirms in chat; then pass userConfirmed: true.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: deleteFileSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.deleteFile(context.actor, input.workspaceId, {
          path: input.path,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }),
    }),
  ];
}
