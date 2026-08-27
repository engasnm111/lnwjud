import { describe, expect, it } from 'vitest';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveApprovalKey, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import { isScopedAutoApprovalAllowed } from './destructive-scope.js';
import { inspectMutationOperation } from './mutation-policy.js';

const scope = { workspaceId: 'workspace-1', rootPath: 'E:\\project' };

function policy(enabled: readonly DestructiveApprovalKey[], protectCriticalFiles = true): DestructiveAutoApprovalPolicy {
  return {
    ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
    protectCriticalFiles,
    approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, ...Object.fromEntries(enabled.map((key) => [key, true])) },
  };
}

function allowed(toolName: string, input: Record<string, unknown>, activePolicy: DestructiveAutoApprovalPolicy): boolean {
  return isScopedAutoApprovalAllowed(toolName, input, inspectMutationOperation(toolName, input, 'DANGEROUS'), activePolicy, scope);
}

describe('scoped destructive auto approval', () => {
  it('allows selected exact destructive families inside the active project', () => {
    const current = policy(['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir']);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: 'src\\old.txt' }, current)).toBe(true);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'src\\old.ts'] }, current)).toBe(true);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['clean', '-f', '--', 'tmp.txt'] }, current)).toBe(true);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['restore', '--', 'src\\old.ts'] }, current)).toBe(true);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['src\\old.tmp'] }, current)).toBe(true);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rmdir', arguments: ['empty-dir'] }, current)).toBe(true);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'del', arguments: ['src\\old.tmp'] }, current)).toBe(true);
    expect(allowed('wsl_exec', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['src/old.tmp'] }, current)).toBe(true);
    expect(allowed('wsl_exec', { workspaceId: 'workspace-1', operation: 'run', executable: 'rmdir', arguments: ['empty-dir'] }, current)).toBe(true);
  });

  it('requires the matching setting and active workspace', () => {
    const current = policy(['delete_file']);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'src\\old.ts'] }, current)).toBe(false);
    expect(allowed('delete_file', { workspaceId: 'workspace-2', path: 'src\\old.txt' }, current)).toBe(false);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '..\\outside.txt' }, current)).toBe(false);
  });

  it('requires recovery for structured delete_file but not command-family settings', () => {
    const unsafeRecovery = { ...policy(['delete_file', 'shell_rm_unlink']), recoverableDelete: false };
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: 'src\\old.txt' }, unsafeRecovery)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['src\\old.tmp'] }, unsafeRecovery)).toBe(true);
  });

  it('keeps root, critical, broad, recursive, and unparseable destructive forms approval-gated', () => {
    const current = policy(['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir']);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '.' }, current)).toBe(false);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '.env' }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'package.json'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['reset', '--hard'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['restore', '--', '*.ts'] }, current)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['-rf', 'src'] }, current)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['*.tmp'] }, current)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'del', arguments: ['/s', 'src\\old.tmp'] }, current)).toBe(false);
    expect(allowed('wsl_exec', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['/tmp/outside'] }, current)).toBe(false);
  });

  it('never auto-approves a whole-drive active project', () => {
    const current = policy(['delete_file', 'shell_rm_unlink']);
    const decision = inspectMutationOperation('delete_file', { workspaceId: 'drive', path: 'temp.txt' }, 'DANGEROUS');
    expect(isScopedAutoApprovalAllowed('delete_file', { workspaceId: 'drive', path: 'temp.txt' }, decision, current, { workspaceId: 'drive', rootPath: 'E:\\' })).toBe(false);
  });
});
