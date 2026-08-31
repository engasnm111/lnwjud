import path from 'node:path';
import { isProtectedCriticalPath, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
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
/**
 * Windows-style vs POSIX-style path classification. `path.win32.isAbsolute`
 * also returns true for POSIX-style `/root` paths (current-drive-relative),
 * which mangles POSIX workspace roots on macOS. Drive letters and UNC paths
 * are unambiguously Windows-style; a leading `/` is POSIX-style on POSIX
 * hosts while Windows-platform behavior stays unchanged.
 */
function isWindowsStylePathValue(value: string): boolean {
  if (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return true;
  if (value.startsWith('/') && process.platform !== 'win32') return false;
  return path.win32.isAbsolute(value);
}

function pathApiFor(value: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePathValue(value) ? path.win32 : path.posix;
}

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

  const root = pathApiFor(scope.rootPath).resolve(scope.rootPath);
  if (isDriveRoot(root)) return false;
  const value = asRecord(input);
  if (value === null) return false;
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : undefined;
  if (workspaceId !== undefined && workspaceId !== scope.workspaceId) return false;
  const cwd = scopedCwd(root, value.cwd);
  if (cwd === null) return false;

  if (approvalKey === 'delete_file') {
    return policy.recoverableDelete === true
      && toolName === 'delete_file'
      && typeof value.path === 'string'
      && safeTarget(root, root, value.path, policy);
  }

  if (approvalKey === 'git_rm') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'rm', ['-r', '--recursive']);
    return target !== null && safeTarget(root, cwd, target, policy);
  }
  if (approvalKey === 'git_clean') {
    const args = stringArray(value.args);
    const target = exactGitTarget(args, 'clean', ['-d', '--directories', '-x', '-X']);
    return target !== null && safeTarget(root, cwd, target, policy);
  }
  if (approvalKey === 'git_reset_restore') {
    const args = stringArray(value.args);
    if (args[0]?.toLowerCase() !== 'restore') return false;
    const target = exactGitTarget(args, 'restore', []);
    return target !== null && safeTarget(root, cwd, target, policy);
  }

  const executable = executableBasename(typeof value.executable === 'string' ? value.executable : '');
  const args = stringArray(value.arguments ?? value.args);
  if (approvalKey === 'shell_rm_unlink' || approvalKey === 'wsl_rm_unlink') {
    if (!['rm', 'unlink'].includes(executable) || hasOption(args, ['-r', '-R', '--recursive', '--dir'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy);
  }
  if (approvalKey === 'shell_rmdir' || approvalKey === 'wsl_rmdir') {
    if (executable !== 'rmdir' || hasOption(args, ['/s', '-p', '--parents'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy);
  }
  if (approvalKey === 'shell_del_erase') {
    if (!['del', 'erase'].includes(executable) || hasOption(args, ['/s'])) return false;
    const target = exactCommandTarget(args);
    return target !== null && safeTarget(root, cwd, target, policy);
  }
  return false;
}

function scopedCwd(root: string, input: unknown): string | null {
  if (input === undefined) return root;
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const api = pathApiFor(root);
  const cwd = api.isAbsolute(input) ? api.resolve(input) : api.resolve(root, input);
  return isWithin(root, cwd) ? cwd : null;
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

function safeTarget(root: string, cwd: string, target: string, policy: DestructiveAutoApprovalPolicy): boolean {
  if (target.length === 0 || hasPatternMagic(target)) return false;
  // A leading `/` is a foreign POSIX-absolute form only when the workspace
  // root itself is Windows-style; on POSIX hosts it is the native absolute
  // form and stays provable through containment below.
  if (target.startsWith('/') && pathApiFor(root) === path.win32) return false;
  const relative = relativeProjectPath(root, cwd, target);
  return relative !== null
    && relative.length > 0
    && (!policy.protectCriticalFiles || !isProtectedCriticalPath(relative));
}

function hasPatternMagic(value: string): boolean {
  return value.startsWith(':') || ['*', '?', '[', ']', '{', '}'].some((token) => value.includes(token));
}

function relativeProjectPath(root: string, cwd: string, target: string): string | null {
  if (target.includes('\0')) return null;
  const api = pathApiFor(root);
  const candidate = api.isAbsolute(target) ? api.resolve(target) : api.resolve(cwd, target);
  if (!isWithin(root, candidate)) return null;
  return api.relative(root, candidate).replaceAll('\\', '/');
}

function isWithin(root: string, candidate: string): boolean {
  const api = pathApiFor(root);
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  if (relative === '') return true;
  if (api.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(api.sep);
  return firstSegment !== '..';
}

function isDriveRoot(value: string): boolean {
  if (pathApiFor(value) === path.posix) return path.resolve(value) === '/';
  return /^[A-Za-z]:\\$/.test(path.win32.resolve(value));
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
