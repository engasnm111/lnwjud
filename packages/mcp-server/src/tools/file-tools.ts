import { appError, err } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import {
  applyPatchSchema,
  copyFileSchema,
  deleteFileSchema,
  editFileSchema,
  listRecoveryItemsSchema,
  listCheckpointsSchema,
  moveFileSchema,
  readFileSchema,
  readFilesSchema,
  restoreDeletedFileSchema,
  restoreCheckpointSchema,
  writeFileSchema,
} from './schemas.js';

export function fileTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'read_file',
      description: 'Read a workspace file as UTF-8 text or as an image/binary payload. Absolute paths (C:\\...) do not require workspaceId. For large files or an unknown location, prefer search_text first and then read_file_page for the relevant range instead of reading the whole file.',
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
      description: 'Read up to twenty bounded workspace files in parallel. Absolute paths do not require workspaceId. For large files, locate text with search_text and page with read_file_page instead of loading entire files.',
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
      description: 'Create or replace a UTF-8 text file and missing parents. Balanced/Safe refuse existing targets unless overwriteExisting is explicit; Full may replace an existing target without a confirmation prompt and still creates a checkpoint. Prefer edit_file for narrow repairs. Use this instead of shell scripts that call fs.writeFile, writeFileSync, Set-Content, or equivalent when the task is simply to create or replace guarded text.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: writeFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.writeFile(context.actor, input.workspaceId, {
          path: input.path,
          content: input.content,
          ...(input.overwriteExisting === undefined ? {} : { overwriteExisting: input.overwriteExisting }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'apply_patch',
      description: 'Apply reviewed whole-file replacement content to at most twenty files. Existing targets are checkpointed first; Full profile does not prompt for non-destructive replacement. Prefer edit_file for narrow repairs. Use this instead of shell-generated whole-file rewrites when several reviewed text files must change.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: applyPatchSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.applyPatch(context.actor, input.workspaceId, {
          files: input.files,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'edit_file',
      description: 'First choice for narrow source, config, and text repairs. Replaces exact text only when the expected occurrence count matches, checkpoints the original, and refuses conflicts instead of rewriting an unverified whole file. Use edit_file instead of shell, node -e, python -c, PowerShell Set-Content, or inline filesystem scripts when a guarded text edit can express the change. Full Access performs ordinary edits without a confirmation prompt; destructive deletion remains separately guarded.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: editFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.editFile(context.actor, input.workspaceId, {
          path: input.path,
          oldText: input.oldText,
          newText: input.newText,
          ...(input.expectedOccurrences === undefined ? {} : { expectedOccurrences: input.expectedOccurrences }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'move_file',
      description: 'Move a file or directory within the Active Project, creating missing destination parents. Full Access performs ordinary moves without a confirmation prompt; conflicting or destructive forms remain policy-gated.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: moveFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.moveFile(context.actor, input.workspaceId, {
          sourcePath: input.sourcePath,
          destinationPath: input.destinationPath,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'copy_file',
      description: 'Copy a file or directory within one workspace, creating missing destination parents.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: copyFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.copyFile(context.actor, input.workspaceId, { sourcePath: input.sourcePath, destinationPath: input.destinationPath }, signal),
    }),
    defineTool({
      name: 'delete_file',
      description: 'Move one file or empty directory from the host-selected Active Project into Recovery Trash. This structured delete can be auto-approved when its saved setting is enabled and the exact target is proven safe. Other destructive Git/shell/WSL families have separate exact-scope settings; critical paths, workspace roots, non-empty directories, ambiguous paths, and mismatched workspaces remain guarded. Returns a recoveryId and local recovery path.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: deleteFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.deleteFile(context.actor, input.workspaceId, {
          path: input.path,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'list_recovery_items',
      description: 'List trusted Recovery Trash entries for one workspace, including deleted items, binary pre-replacement backups, original paths, timestamps, payload availability, and the local Recovery Trash root.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: listRecoveryItemsSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.listRecoveryItems(input.workspaceId),
    }),
    defineTool({
      name: 'restore_deleted_file',
      description: 'Restore one Recovery Trash item to its original path. Deleted-item restores refuse existing targets. A pre-replacement restore first backs up the current live version for undo, then restores the older binary or text payload. Full runs recoverable restores without an extra prompt; stricter profiles may require confirmation. The operation remains scoped to the recorded workspace.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: restoreDeletedFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.restoreDeletedFile(context.actor, input.workspaceId, {
          recoveryId: input.recoveryId,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'list_checkpoints',
      description: 'List encrypted pre-mutation checkpoints for one workspace without returning saved file content.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: listCheckpointsSchema,
      handler: async (input) => context.services.checkpoint === undefined
        ? missingService()
        : context.services.checkpoint.list(input.workspaceId, input.limit),
    }),
    defineTool({
      name: 'restore_checkpoint',
      description: 'Restore a reviewed pre-mutation checkpoint. Requires explicit confirmation and creates a new rollback checkpoint before replacing current content.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: restoreCheckpointSchema,
      handler: async (input) => {
        if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Checkpoint restore requires explicit user confirmation'));
        return context.services.checkpoint === undefined
          ? missingService()
          : context.services.checkpoint.restore(context.actor, input.workspaceId, input.checkpointId, { userConfirmed: true });
      },
    }),
  ];
}
