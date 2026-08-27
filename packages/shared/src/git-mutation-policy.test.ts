import { describe, expect, it } from 'vitest';
import { isProvablyReadOnlyGitInvocation, prohibitedAgentGitInvocationReason } from './git-mutation-policy.js';

describe('prohibitedAgentGitInvocationReason', () => {
  it.each([
    [['-C', 'E:\\outside', 'status'], 'global scope'],
    [['--git-dir=E:\\outside\\.git', 'status'], 'global scope'],
    [['--work-tree=E:\\outside', 'status'], 'global scope'],
    [['-c', 'alias.wipe=!rm -rf .', 'wipe'], 'alias injection'],
    [['wipe'], 'unknown/repository alias'],
    [['checkout', '--', 'src/file.ts'], 'checkout discard'],
    [['checkout', 'src/file.ts'], 'ambiguous checkout path discard'],
    [['checkout', '-f', 'main'], 'checkout force'],
    [['switch', '--discard-changes', 'main'], 'switch discard'],
    [['switch', '-C', 'main'], 'switch force-create'],
    [['stash', 'drop'], 'stash drop'],
    [['stash', 'clear'], 'stash clear'],
    [['stash', 'pop'], 'stash pop'],
    [['reflog', 'delete', 'HEAD@{1}'], 'reflog delete'],
    [['reflog', 'expire', '--expire=now', '--all'], 'reflog expire'],
    [['branch', '-D', 'old'], 'branch delete'],
    [['branch', '-f', 'main'], 'branch force'],
    [['branch', '-M', 'old', 'existing'], 'branch force rename'],
    [['branch', '-C', 'source', 'existing'], 'branch force copy'],
    [['tag', '-d', 'v1'], 'tag delete'],
    [['tag', '-f', 'v1'], 'tag force'],
    [['worktree', 'remove', 'tmp'], 'worktree remove'],
    [['worktree', 'prune'], 'worktree prune'],
    [['remote', 'remove', 'origin'], 'remote remove'],
    [['remote', 'prune', 'origin'], 'remote prune'],
    [['fetch', '--prune'], 'fetch prune'],
    [['gc'], 'gc'],
    [['mv', '-f', 'a', 'b'], 'forced mv'],
    [['push', '--force', 'origin', 'main'], 'force push'],
    [['push', '--delete', 'origin', 'old'], 'delete push'],
    [['push', '--mirror', 'origin'], 'mirror push'],
    [['push', '--prune', 'origin'], 'prune push'],
    [['push', 'origin', ':old'], 'delete refspec'],
    [['push', 'origin', '+main:main'], 'force refspec'],
  ] as const)('blocks %s (%s)', (args) => {
    expect(prohibitedAgentGitInvocationReason(args)).toBeTypeOf('string');
  });

  it.each([
    ['status', '--short'],
    ['diff', '--stat'],
    ['log', '-1'],
    ['add', '--', 'src/file.ts'],
    ['commit', '-m', 'safe local commit'],
    ['rm', '--', 'src/old.ts'],
    ['clean', '-fd'],
    ['reset', '--hard', 'HEAD~1'],
    ['reset', '--merge'],
    ['reset', '--keep'],
    ['reset', '--soft', 'HEAD~1'],
    ['restore', 'src/file.ts'],
    ['restore', '--worktree', 'src/file.ts'],
    ['restore', '--staged', 'src/file.ts'],
    ['remote', '-v'],
    ['stash', 'list'],
  ] as const)('keeps reviewed non-destructive form %s available', (...args) => {
    expect(prohibitedAgentGitInvocationReason(args)).toBeUndefined();
  });

  it('classifies demonstrably read-only forms separately from allowed writes', () => {
    expect(isProvablyReadOnlyGitInvocation(['status', '--short'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['remote', '-v'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--show-current'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--list'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--list', 'feature/*'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['branch', 'new-branch'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['branch', '-D', 'old'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['add', '--', 'src/file.ts'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['commit', '-m', 'message'])).toBe(false);
  });
});
