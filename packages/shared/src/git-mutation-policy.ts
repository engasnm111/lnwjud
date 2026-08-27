const ALWAYS_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'column',
  'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree',
  'for-each-ref', 'fsck', 'grep', 'help', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge-base', 'name-rev', 'rev-list', 'rev-parse', 'show',
  'show-branch', 'show-ref', 'status', 'verify-commit', 'verify-pack',
  'verify-tag', 'whatchanged',
]);

const AGENT_ALLOWED_GIT_SUBCOMMANDS = new Set([
  ...ALWAYS_READ_ONLY_GIT_SUBCOMMANDS,
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'commit',
  'config', 'fetch', 'gc', 'init', 'merge', 'mv', 'pull', 'push', 'rebase',
  'remote', 'reset', 'restore', 'revert', 'rm', 'clean', 'stash', 'switch', 'symbolic-ref',
  'tag', 'worktree',
]);

/** A deliberately small contract shared by the MCP gateway and Git backend. */
export function isProvablyReadOnlyGitInvocation(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!.toLowerCase();
  if (first.startsWith('-')) return args.length === 1 && (first === '--help' || first === '--version');
  const rest = args.slice(1);
  if (containsBroadPathspecMagic(rest)) return false;

  if (ALWAYS_READ_ONLY_GIT_SUBCOMMANDS.has(first)) return true;
  if (first === 'branch') return isReadOnlyBranch(rest);
  if (first === 'config') return isReadOnlyConfig(rest);
  if (first === 'remote') return rest.length === 0 || ['-v', '--verbose', 'get-url', 'show'].includes(rest[0]!.toLowerCase());
  if (first === 'reflog') return rest.length === 0 || ['show', 'exists'].includes(rest[0]!.toLowerCase());
  if (first === 'stash') return rest.length > 0 && ['list', 'show'].includes(rest[0]!.toLowerCase());
  if (first === 'symbolic-ref') return isReadOnlySymbolicRef(rest);
  if (first === 'tag') return isReadOnlyTag(rest);
  return false;
}

/**
 * Hard blocks only Git forms that escape the scoped cwd, inject aliases, or use
 * mutation shapes that the action-level policy cannot safely classify. Known
 * workspace delete/reset/restore families are handled by the destructive policy
 * so Full Access can ask or auto-approve them according to user settings.
 */
export function prohibitedAgentGitInvocationReason(args: readonly string[]): string | undefined {
  if (args.length === 0) return 'Git invocation has no explicit subcommand';
  const first = args[0]!.toLowerCase();
  if (first.startsWith('-')) {
    return args.length === 1 && (first === '--help' || first === '--version')
      ? undefined
      : 'Git global options can override the scoped working tree or inject aliases';
  }
  if (!AGENT_ALLOWED_GIT_SUBCOMMANDS.has(first)) {
    return `Git subcommand ${first} is not on the explicit agent allowlist; repository aliases are never executed`;
  }

  const rest = args.slice(1);
  const lower = rest.map((arg) => arg.toLowerCase());
  if (first === 'checkout') {
    if (lower.includes('--') || rest.includes('-B') || hasGitOption(lower, ['--force', '-f', '--ours', '--theirs', '--merge', '-m', '--conflict'])) {
      return 'git checkout mode can overwrite paths or force-move a branch without Recovery Trash';
    }
    const explicitlyCreatesBranch = hasGitOption(lower, ['-b', '--branch']);
    const explicitlyDetaches = hasGitOption(lower, ['--detach']);
    if (!explicitlyCreatesBranch && !explicitlyDetaches) {
      return 'git checkout target is ambiguous between a ref and a working-tree path; use git switch for branch changes or a reviewed staged-only restore';
    }
  }
  if (first === 'switch' && (rest.includes('-C') || hasGitOption(lower, ['--force', '-f', '--discard-changes', '--force-create']))) {
    return 'git switch mode can discard changes or force-reset a branch';
  }
  if (first === 'stash' && lower.some((arg) => ['drop', 'clear', 'pop'].includes(arg))) {
    return 'git stash operation deletes recovery history';
  }
  if (first === 'reflog' && lower.some((arg) => ['delete', 'expire'].includes(arg))) {
    return 'git reflog operation deletes recovery history';
  }
  if (first === 'branch' && (rest.includes('-M') || rest.includes('-C') || hasGitOption(lower, ['--delete', '-d', '--force', '-f']))) {
    return 'git branch operation deletes or force-moves a branch';
  }
  if (first === 'tag' && hasGitOption(lower, ['--delete', '-d', '--force', '-f'])) {
    return 'git tag operation deletes or force-replaces a tag';
  }
  if (first === 'worktree' && lower.some((arg) => ['remove', 'prune'].includes(arg))) {
    return 'git worktree operation removes worktree state';
  }
  if (first === 'remote' && lower.some((arg) => ['remove', 'rm', 'prune'].includes(arg))) {
    return 'git remote operation deletes configuration or remote-tracking refs';
  }
  if (first === 'fetch' && hasGitOption(lower, ['--prune', '-p', '--prune-tags'])) {
    return 'git fetch pruning deletes remote-tracking refs';
  }
  if (first === 'gc') return 'git gc can permanently prune otherwise recoverable objects';
  if (first === 'mv' && hasGitOption(lower, ['--force', '-f'])) return 'git mv --force can replace an existing path';
  if (first === 'push' && isDestructivePush(lower)) return 'git push invocation deletes or force-rewrites remote refs';
  return undefined;
}

function hasGitOption(args: readonly string[], options: readonly string[]): boolean {
  return args.some((arg) => options.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

function isDestructivePush(args: readonly string[]): boolean {
  if (hasGitOption(args, ['--force', '-f', '--force-with-lease', '--force-if-includes', '--delete', '--mirror', '--prune'])) return true;
  return args.some((arg) => arg.startsWith(':') || arg.startsWith('+'));
}

function containsBroadPathspecMagic(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith(':') || ['*', '?', '[', ']', '{', '}'].some((token) => arg.includes(token)));
}

function isReadOnlyBranch(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  const lower = args.map((arg) => arg.toLowerCase());
  if (hasGitOption(lower, ['--delete', '-d', '--force', '-f', '--move', '-m', '--copy', '-c', '--set-upstream-to', '-u', '--unset-upstream', '--edit-description'])) return false;
  if (args.some((arg) => arg === '-M' || arg === '-C')) return false;
  if (lower.includes('--show-current')) return lower.every((arg) => arg === '--show-current' || arg === '--color' || arg.startsWith('--color='));
  return lower.every((arg) =>
    arg === '--list' || arg === '-l' || arg === '-a' || arg === '--all' || arg === '-r' || arg === '--remotes' ||
    arg === '-v' || arg === '-vv' || arg === '--verbose' || arg === '--no-color' || arg === '--color' || arg.startsWith('--color=') ||
    ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--no-column'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ||
    (!arg.startsWith('-') && lower.some((value) => ['--list', '-l'].includes(value)))
  );
}

function isReadOnlyConfig(args: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  return lower.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope'].includes(arg));
}

function isReadOnlySymbolicRef(args: readonly string[]): boolean {
  const positional = args.filter((arg) => !['-q', '--quiet', '--short'].includes(arg.toLowerCase()));
  return positional.length === 1 && !positional[0]!.startsWith('-');
}

function isReadOnlyTag(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every((arg) => arg.startsWith('-l') || ['--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}
