import path from 'node:path';
import { isProtectedCriticalPath, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import type { MutationPolicyDecision } from './mutation-policy.js';

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly rootPath: string;
}

/** @deprecated Use WorkspaceScope for request-scoped resolution. */
export type ActiveProjectScope = WorkspaceScope;

type PlatformPathApi = typeof path.win32 | typeof path.posix;

/**
 * A destructive setting can bypass the prompt only when the exact action can be
 * proven to stay inside the host Active Project. Broad patterns, filesystem roots,
 * recursive command forms, critical paths, and unparseable targets fail closed.
 */
export function isScopedAutoApprovalAllowed(
  toolName: string,
  input: unknown,
  decision: MutationPolicyDecision,
  policy: DestructiveAutoApprovalPolicy,
  scope: WorkspaceScope | null,
): boolean {
  const approvalKey = decision.approvalKey;
  if (decision.kind !== 'delete'
    || approvalKey === undefined
    || policy.approvals[approvalKey] !== true
    || policy.protectCriticalFiles !== true
    || scope === null) return false;

  const pathApi = pathApiForRoot(scope.rootPath);
  const root = pathApi.resolve(scope.rootPath);
  if (isFilesystemRoot(root, pathApi)) return false;
  const value = asRecord(input);
  if (value === null) return false;
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : undefined;
  if (workspaceId !== undefined && workspaceId !== scope.workspaceId) return false;
  const cwd = scopedCwd(root, value.cwd, pathApi);
  if (cwd === null) return false;

  if (approvalKey === 'delete_file') {
    return policy.recoverableDelete === true
      && toolName === 'delete_file'
      && typeof value.path === 'string'
      && safeTarget(root, root, value.path, policy, pathApi);
  }

  if (approvalKey === 'git_rm') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'rm', ['-r', '--recursive']);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }
  if (approvalKey === 'git_clean') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'clean', ['-d', '--directories', '-x', '-X']);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }
  if (approvalKey === 'git_reset_restore') {
    const args = stringArray(value.args);
    if (args[0]?.toLowerCase() !== 'restore') return false;
    const target = exactGitTarget(args, 'restore', []);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }

  const executable = executableBasename(typeof value.executable === 'string' ? value.executable : '');
  const args = stringArray(value.arguments ?? value.args);
  if (approvalKey === 'shell_rm_unlink' || approvalKey === 'wsl_rm_unlink') {
    if (!['rm', 'unlink'].includes(executable) || hasOption(args, ['-r', '-R', '--recursive', '--dir'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }
  if (approvalKey === 'shell_rmdir' || approvalKey === 'wsl_rmdir') {
    if (executable !== 'rmdir' || hasOption(args, ['/s', '-p', '--parents'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }
  if (approvalKey === 'shell_del_erase') {
    if (!['del', 'erase'].includes(executable) || hasOption(args, ['/s'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy, pathApi);
  }
  return false;
}

function scopedCwd(root: string, input: unknown, pathApi: PlatformPathApi): string | null {
  if (input === undefined) return root;
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const cwd = pathApi.isAbsolute(input) ? pathApi.resolve(input) : pathApi.resolve(root, input);
  return isWithin(root, cwd, pathApi) ? cwd : null;
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

function safeTarget(root: string, cwd: string, target: string, policy: DestructiveAutoApprovalPolicy, pathApi: PlatformPathApi): boolean {
  if (target.length === 0 || hasPatternMagic(target)) return false;
  const relative = relativeProjectPath(root, cwd, target, pathApi);
  return relative !== null
    && relative.length > 0
    && (!policy.protectCriticalFiles || !isProtectedCriticalPath(relative));
}

function hasPatternMagic(value: string): boolean {
  return value.startsWith(':') || ['*', '?', '[', ']', '{', '}'].some((token) => value.includes(token));
}

function relativeProjectPath(root: string, cwd: string, target: string, pathApi: PlatformPathApi): string | null {
  if (target.includes('\0')) return null;
  const candidate = pathApi.isAbsolute(target) ? pathApi.resolve(target) : pathApi.resolve(cwd, target);
  if (!isWithin(root, candidate, pathApi)) return null;
  return pathApi.relative(root, candidate).replaceAll('\\', '/');
}

function isWithin(root: string, candidate: string, pathApi: PlatformPathApi): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  if (relative === '') return true;
  if (pathApi.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(pathApi.sep);
  return firstSegment !== '..';
}

function isFilesystemRoot(value: string, pathApi: PlatformPathApi): boolean {
  const resolved = pathApi.resolve(value);
  return resolved === pathApi.parse(resolved).root;
}

function pathApiForRoot(rootPath: string): PlatformPathApi {
  const trimmed = rootPath.trim();
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+/.test(trimmed)
    ? path.win32
    : path.posix;
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
