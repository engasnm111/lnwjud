import { isProtectedCriticalPath, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import { hostPathApi, isAbsoluteHostPath, isFilesystemRoot, isHostPathWithin, relativeHostPath, resolveHostPath } from '@lnwjud/workspace';
import type { MutationPolicyDecision } from './mutation-policy.js';

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly rootPath: string;
}

/** @deprecated Use WorkspaceScope for request-scoped resolution. */
export type ActiveProjectScope = WorkspaceScope;

/**
 * A destructive setting can bypass the prompt only when the exact action can be
 * proven to stay inside the host Active Project. Broad patterns, workspace roots,
 * recursive command forms, critical paths, and unparseable targets fail closed.
 */
export function isScopedAutoApprovalAllowed(
  toolName: string,
  input: unknown,
  decision: MutationPolicyDecision,
  policy: DestructiveAutoApprovalPolicy,
  scope: WorkspaceScope | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const approvalKey = decision.approvalKey;
  if (decision.kind !== 'delete'
    || approvalKey === undefined
    || policy.approvals[approvalKey] !== true
    || policy.protectCriticalFiles !== true
    || scope === null) return false;

  const root = resolveHostPath(scope.rootPath, platform);
  if (root === null || isFilesystemRoot(root, platform)) return false;
  const value = asRecord(input);
  if (value === null) return false;
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : undefined;
  if (workspaceId !== undefined && workspaceId !== scope.workspaceId) return false;
  const cwd = scopedCwd(root, value.cwd, platform);
  if (cwd === null) return false;

  if (approvalKey === 'delete_file') {
    return policy.recoverableDelete === true
      && toolName === 'delete_file'
      && typeof value.path === 'string'
      && safeTarget(root, root, value.path, policy, platform);
  }

  if (approvalKey === 'git_rm') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'rm', ['-r', '--recursive']);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }
  if (approvalKey === 'git_clean') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'clean', ['-d', '--directories', '-x', '-X']);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }
  if (approvalKey === 'git_reset_restore') {
    const args = stringArray(value.args);
    if (args[0]?.toLowerCase() !== 'restore') return false;
    const target = exactGitTarget(args, 'restore', []);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }

  const executable = executableBasename(typeof value.executable === 'string' ? value.executable : '');
  const args = stringArray(value.arguments ?? value.args);
  if (approvalKey === 'shell_rm_unlink' || approvalKey === 'wsl_rm_unlink') {
    if (!['rm', 'unlink'].includes(executable) || hasOption(args, ['-r', '-R', '--recursive', '--dir'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }
  if (approvalKey === 'shell_rmdir' || approvalKey === 'wsl_rmdir') {
    if (executable !== 'rmdir' || hasOption(args, ['/s', '-p', '--parents'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }
  if (approvalKey === 'shell_del_erase') {
    if (!['del', 'erase'].includes(executable) || hasOption(args, ['/s'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, platform);
  }
  return false;
}

function scopedCwd(root: string, input: unknown, platform: NodeJS.Platform): string | null {
  if (input === undefined) return root;
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const api = hostPathApi(platform);
  const cwd = isAbsoluteHostPath(input, platform)
    ? resolveHostPath(input, platform)
    : resolveHostPath(api.join(root, input), platform);
  return cwd !== null && isHostPathWithin(root, cwd, platform) ? cwd : null;
}

function exactGitTarget(args: readonly string[], expectedSubcommand: string, rejectedOptions: readonly string[]): string | null {
  if (args[0]?.toLowerCase() !== expectedSubcommand) return null;
  const delimiter = args.indexOf('--');
  if (delimiter < 0) return null;
  const beforeDelimiter = args.slice(1, delimiter);
  if (rejectedOptions.some((option) => hasOption(beforeDelimiter, [option]))) return null;
  const targets = args.slice(delimiter + 1);
  return targets.length === 1 ? targets[0]! : null;
}

function exactCommandTarget(args: readonly string[]): string | null {
  const targets = args.filter((arg) => arg !== '--' && !arg.startsWith('-') && !/^\/[A-Za-z?]$/.test(arg));
  return targets.length === 1 ? targets[0]! : null;
}

function hasOption(args: readonly string[], options: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  return options.some((option) => {
    const wanted = option.toLowerCase();
    if (wanted.length === 2 && wanted.startsWith('-') && !wanted.startsWith('--')) {
      const flag = wanted[1]!;
      return lower.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).toLowerCase().includes(flag));
    }
    return lower.some((arg) => arg === wanted || arg.startsWith(`${wanted}=`));
  });
}

function safeTarget(root: string, cwd: string, target: string, policy: DestructiveAutoApprovalPolicy, platform: NodeJS.Platform): boolean {
  // A leading slash is a rooted/option-like target on Windows, but is the
  // normal absolute-path form on POSIX. Containment below still must succeed.
  if (target.length === 0 || (platform === 'win32' && target.startsWith('/')) || hasPatternMagic(target)) return false;
  const relative = relativeProjectPath(root, cwd, target, platform);
  return relative !== null
    && relative.length > 0
    && (!policy.protectCriticalFiles || !isProtectedCriticalPath(relative));
}

function hasPatternMagic(value: string): boolean {
  return value.startsWith(':') || ['*', '?', '[', ']', '{', '}'].some((token) => value.includes(token));
}

function relativeProjectPath(root: string, cwd: string, target: string, platform: NodeJS.Platform): string | null {
  if (target.includes('\0')) return null;
  const candidate = isAbsoluteHostPath(target, platform)
    ? resolveHostPath(target, platform)
    : resolveHostPath(hostPathApi(platform).join(cwd, target), platform);
  if (candidate === null || !isHostPathWithin(root, candidate, platform)) return null;
  return relativeHostPath(root, candidate, platform)?.replaceAll(hostPathApi(platform).sep, '/') ?? null;
}

function executableBasename(executable: string): string {
  const raw = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return raw.replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
