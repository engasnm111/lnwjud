import { describe, expect, it } from 'vitest';
import { inspectMutationOperation, permissionLevelForMutationDecision, requiresMutationConfirmation } from './mutation-policy.js';
import type { McpPermissionLevel } from './tools/tool-types.js';

type MutationKind = 'read' | 'execute' | 'bounded_write' | 'replace' | 'delete' | 'opaque_mutation';

interface MutationCase {
  readonly label: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permission: McpPermissionLevel;
  readonly kind: MutationKind;
}

const cases: readonly MutationCase[] = [
  { label: 'read-only git status', tool: 'git', input: { args: ['status', '--short'] }, permission: 'EXECUTE', kind: 'read' },
  { label: 'git index replacement', tool: 'git', input: { args: ['add', '--', 'src/a.ts'] }, permission: 'EXECUTE', kind: 'replace' },
  { label: 'git scope override before clean', tool: 'git', input: { args: ['-C', 'E:\\outside', 'clean', '-fd'] }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'git config alias with an operand', tool: 'git', input: { args: ['-c', 'alias.wipe=!rm -rf .', 'wipe'] }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'git root pathspec deletion', tool: 'git', input: { args: ['rm', '--', ':/'] }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'git clean deletion', tool: 'git', input: { args: ['clean', '-f', '--', 'tmp.txt'] }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'git hard reset data loss', tool: 'git', input: { args: ['reset', '--hard'] }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'git working-tree restore data loss', tool: 'git', input: { args: ['restore', '--', 'src/file.ts'] }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'git exclusion pathspec restore', tool: 'git', input: { args: ['restore', '--staged', '--', ':!keep.txt'] }, permission: 'EXECUTE', kind: 'replace' },
  { label: 'git unknown external subcommand', tool: 'git', input: { args: ['mystery', 'arg'] }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'PowerShell encoded command', tool: 'shell', input: { operation: 'run', executable: 'pwsh.exe', arguments: ['-EncodedCommand', 'VwByAGkAdABlAC0ATwB1AHQAcAB1AHQA'] }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'PowerShell dynamic command', tool: 'process_start', input: { executable: 'powershell.exe', args: ['-Command', "& ('Remove'+'-Item') x"] }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'Node script', tool: 'shell', input: { operation: 'run', executable: 'node.exe', arguments: ['cleanup.js'] }, permission: 'EXECUTE', kind: 'execute' },
  { label: 'Python script', tool: 'process_start', input: { executable: 'python.exe', args: ['cleanup.py'] }, permission: 'EXECUTE', kind: 'execute' },
  { label: 'WSL executable run', tool: 'wsl_exec', input: { operation: 'run', executable: 'rm', arguments: ['victim.txt'] }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'shell task status', tool: 'shell', input: { operation: 'status', task_id: 'task-1' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'WSL task logs', tool: 'wsl_exec', input: { operation: 'logs', task_id: 'task-1' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'HTTP GET', tool: 'web_fetch', input: { method: 'GET', url: 'https://example.test/item' }, permission: 'READ', kind: 'read' },
  { label: 'HTTP POST side effect', tool: 'web_fetch', input: { method: 'POST', url: 'https://example.test/item' }, permission: 'READ', kind: 'opaque_mutation' },
  { label: 'HTTP POST dry run', tool: 'web_fetch', input: { method: 'POST', url: 'https://example.test/item', dry_run: true }, permission: 'READ', kind: 'read' },
  { label: 'HTTP PUT replacement', tool: 'web_fetch', input: { method: 'PUT', url: 'https://example.test/item' }, permission: 'READ', kind: 'replace' },
  { label: 'HTTP DELETE', tool: 'web_fetch', input: { method: 'DELETE', url: 'https://example.test/item' }, permission: 'READ', kind: 'delete' },
  { label: 'create-only file write', tool: 'write_file', input: { path: 'new.txt', content: 'value' }, permission: 'WRITE', kind: 'bounded_write' },
  { label: 'explicit file overwrite', tool: 'write_file', input: { path: 'old.txt', content: 'value', overwriteExisting: true }, permission: 'WRITE', kind: 'replace' },
  { label: 'legacy whole-file patch', tool: 'apply_patch', input: { files: [{ path: 'old.txt', content: 'value' }] }, permission: 'WRITE', kind: 'replace' },
  { label: 'exact file edit', tool: 'edit_file', input: { path: 'old.txt', edits: [{ oldText: 'a', newText: 'b' }] }, permission: 'WRITE', kind: 'bounded_write' },
  { label: 'file move removes the source path', tool: 'move_file', input: { sourcePath: 'old.txt', destinationPath: 'new.txt' }, permission: 'WRITE', kind: 'replace' },
  { label: 'checkpoint listing', tool: 'list_checkpoints', input: { workspaceId: 'w' }, permission: 'READ', kind: 'read' },
  { label: 'structured file delete', tool: 'delete_file', input: { path: 'old.txt' }, permission: 'DANGEROUS', kind: 'delete' },
  { label: 'Recovery Trash listing', tool: 'list_recovery_items', input: {}, permission: 'READ', kind: 'read' },
  { label: 'recovery restore can replace live state', tool: 'restore_recovery_item', input: { recoveryId: 'id' }, permission: 'WRITE', kind: 'replace' },
  { label: 'scheduler listing', tool: 'scheduler', input: { action: 'list' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'scheduler creation', tool: 'scheduler', input: { action: 'create' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'scheduler task run', tool: 'scheduler', input: { action: 'run' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'scheduler deletion', tool: 'scheduler', input: { action: 'delete' }, permission: 'EXECUTE', kind: 'delete' },
  { label: 'scheduler deletion dry run', tool: 'scheduler', input: { action: 'delete', dry_run: true }, permission: 'EXECUTE', kind: 'read' },
  { label: 'Office read', tool: 'office', input: { action: 'read' }, permission: 'WRITE', kind: 'read' },
  { label: 'Office Word text read', tool: 'office', input: { action: 'read_text' }, permission: 'WRITE', kind: 'read' },
  { label: 'Office replacement', tool: 'office', input: { action: 'replace' }, permission: 'WRITE', kind: 'replace' },
  { label: 'Office replacement dry run', tool: 'office', input: { action: 'replace', dry_run: true }, permission: 'WRITE', kind: 'read' },
  { label: 'DOCX merge preview by default', tool: 'docx_merge', input: {}, permission: 'WRITE', kind: 'read' },
  { label: 'DOCX merge apply', tool: 'docx_merge', input: { dryRun: false }, permission: 'WRITE', kind: 'replace' },
  { label: 'PowerPoint save-as preview by default', tool: 'office_ppt', input: { action: 'save_as' }, permission: 'WRITE', kind: 'read' },
  { label: 'PowerPoint save-as apply', tool: 'office_ppt', input: { action: 'save_as', dryRun: false }, permission: 'WRITE', kind: 'replace' },
  { label: 'browser launch is ordinary execution', tool: 'dom_cdp', input: { action: 'launch' }, permission: 'READ', kind: 'execute' },
  { label: 'opaque browser evaluation', tool: 'dom_cdp', input: { action: 'evaluate' }, permission: 'READ', kind: 'opaque_mutation' },
  { label: 'opaque browser typing', tool: 'dom_cdp', input: { action: 'type' }, permission: 'READ', kind: 'opaque_mutation' },
  { label: 'opaque browser navigation', tool: 'dom_cdp', input: { action: 'navigate' }, permission: 'READ', kind: 'opaque_mutation' },
  { label: 'computer use snapshot is read-only', tool: 'computer_use', input: { action: 'snapshot' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'computer use dry-run click is read-only', tool: 'computer_use', input: { action: 'click', dry_run: true }, permission: 'EXECUTE', kind: 'read' },
  { label: 'computer use pointer move is ordinary execution', tool: 'computer_use', input: { action: 'mouse_move' }, permission: 'EXECUTE', kind: 'execute' },
  { label: 'computer use click remains opaque', tool: 'computer_use', input: { action: 'click' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'accessibility focus is ordinary execution', tool: 'accessibility', input: { action: 'focus' }, permission: 'READ', kind: 'execute' },
  { label: 'accessibility click remains opaque', tool: 'accessibility', input: { action: 'click' }, permission: 'READ', kind: 'opaque_mutation' },
  { label: 'marked value read is read-only', tool: 'ui_target_action', input: { action: 'read_value' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'marked focus is ordinary execution', tool: 'ui_target_action', input: { action: 'focus' }, permission: 'EXECUTE', kind: 'execute' },
  { label: 'delegated coding agent', tool: 'codex_run', input: { instruction: 'edit files' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'child MCP call', tool: 'mcp_call', input: { server: 'child', tool: 'read_file' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'batch dispatcher delegates policy to each child', tool: 'tool_batch', input: { calls: [] }, permission: 'EXECUTE', kind: 'read' },
  { label: 'workspace registration listing', tool: 'workspace_list', input: {}, permission: 'READ', kind: 'read' },
  { label: 'bounded workspace registration', tool: 'workspace_register', input: {}, permission: 'WRITE', kind: 'bounded_write' },
  { label: 'skill catalog listing', tool: 'skills_list', input: {}, permission: 'READ', kind: 'read' },
  { label: 'skill content read', tool: 'skills_read', input: { skillId: 'a/b' }, permission: 'READ', kind: 'read' },
  { label: 'MCP server listing', tool: 'mcp_list', input: {}, permission: 'READ', kind: 'read' },
  { label: 'MCP server description', tool: 'mcp_describe', input: { server: 'child' }, permission: 'READ', kind: 'read' },
  { label: 'clipboard text read', tool: 'clipboard', input: { action: 'get_text' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'clipboard write', tool: 'clipboard', input: { action: 'set_text', text: 'value' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'audio recording is privacy-sensitive', tool: 'audio', input: { action: 'record', output_path: 'capture.wav' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'audio recording dry run', tool: 'audio', input: { action: 'record', output_path: 'capture.wav', dry_run: true }, permission: 'EXECUTE', kind: 'read' },
  { label: 'audio playback is ordinary execution', tool: 'audio', input: { action: 'play', file_path: 'capture.wav' }, permission: 'EXECUTE', kind: 'execute' },
  { label: 'screen recording status', tool: 'screen_record', input: { action: 'status' }, permission: 'EXECUTE', kind: 'read' },
  { label: 'screen recording start is privacy-sensitive', tool: 'screen_record', input: { action: 'start', output_path: 'capture.mp4' }, permission: 'EXECUTE', kind: 'opaque_mutation' },
  { label: 'screen recording dry run', tool: 'screen_record', input: { action: 'start', output_path: 'capture.mp4', dry_run: true }, permission: 'EXECUTE', kind: 'read' },
  { label: 'bounded read-only SQLite query', tool: 'db_query', input: { sql: 'SELECT 1' }, permission: 'READ', kind: 'read' },
  { label: 'plugin descriptor registration', tool: 'plugin_install', input: { name: 'example' }, permission: 'WRITE', kind: 'bounded_write' },
  { label: 'worktree creation preview', tool: 'git_worktree_spawn', input: { workspaceId: 'w', worktreePath: '.worktrees/a' }, permission: 'WRITE', kind: 'read' },
  { label: 'confined worktree creation', tool: 'git_worktree_spawn', input: { workspaceId: 'w', worktreePath: '.worktrees/a', dryRun: false }, permission: 'WRITE', kind: 'bounded_write' },
  { label: 'worktree removal preview', tool: 'git_worktree_remove', input: { workspaceId: 'w', worktreePath: '.worktrees/a' }, permission: 'DANGEROUS', kind: 'read' },
  { label: 'worktree removal apply', tool: 'git_worktree_remove', input: { workspaceId: 'w', worktreePath: '.worktrees/a', dryRun: false }, permission: 'DANGEROUS', kind: 'delete' },
  { label: 'self-heal apply preview', tool: 'self_heal_apply', input: {}, permission: 'DANGEROUS', kind: 'read' },
  { label: 'self-heal apply execution', tool: 'self_heal_apply', input: { dryRun: false }, permission: 'DANGEROUS', kind: 'opaque_mutation' },
  { label: 'unknown READ tool', tool: 'future_read_tool', input: {}, permission: 'READ', kind: 'read' },
  { label: 'unknown WRITE tool', tool: 'future_write_tool', input: {}, permission: 'WRITE', kind: 'opaque_mutation' },
  { label: 'unknown EXECUTE tool', tool: 'future_execute_tool', input: {}, permission: 'EXECUTE', kind: 'opaque_mutation' },
];

describe('central mutation policy', () => {
  it.each(cases)('$label is classified as $kind', ({ tool, input, permission, kind }) => {
    expect(inspectMutationOperation(tool, input, permission).kind).toBe(kind);
  });

  it('exposes auto-approval keys for configured destructive families', () => {
    expect(inspectMutationOperation('delete_file', { path: 'old.txt' }, 'DANGEROUS').approvalKey).toBe('delete_file');
    expect(inspectMutationOperation('git', { args: ['rm', '--', 'old.txt'] }, 'EXECUTE').approvalKey).toBe('git_rm');
    expect(inspectMutationOperation('git', { args: ['clean', '-f', '--', 'old.tmp'] }, 'EXECUTE').approvalKey).toBe('git_clean');
    expect(inspectMutationOperation('git', { args: ['restore', '--', 'old.txt'] }, 'EXECUTE').approvalKey).toBe('git_reset_restore');
    expect(inspectMutationOperation('shell', { operation: 'run', executable: 'rm', arguments: ['old.txt'] }, 'EXECUTE').approvalKey).toBe('shell_rm_unlink');
    expect(inspectMutationOperation('wsl_exec', { operation: 'run', executable: 'rmdir', arguments: ['empty-dir'] }, 'EXECUTE').approvalKey).toBe('wsl_rmdir');
  });

  it.each([
    ['read', false],
    ['execute', false],
    ['bounded_write', false],
    ['replace', true],
    ['delete', true],
    ['opaque_mutation', true],
  ] as const)('requires confirmation for %s = %s', (kind, expected) => {
    expect(requiresMutationConfirmation({ kind, reason: 'test' })).toBe(expected);
  });

  it.each([
    ['read', 'READ'],
    ['execute', 'EXECUTE'],
    ['bounded_write', 'WRITE'],
    ['replace', 'WRITE'],
    ['delete', 'DANGEROUS'],
    ['opaque_mutation', 'DANGEROUS'],
  ] as const)('maps %s to effective permission %s', (kind, expected) => {
    expect(permissionLevelForMutationDecision({ kind, reason: 'test' })).toBe(expected);
  });
});
