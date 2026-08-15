import path from 'node:path';
import type { PermissionDecision, PermissionProfile } from './types.js';

export type CommandSource = 'client' | 'project';

const SHELL_HOSTS = new Set(['bash', 'bash.exe', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'sh.exe']);
const DELETE_EXECUTABLES = new Set([
  'del', 'del.exe', 'erase', 'erase.exe', 'rm', 'rm.exe', 'rmdir', 'rmdir.exe', 'rd', 'rd.exe',
  'unlink', 'unlink.exe', 'remove-item',
]);

export interface CommandPolicyOptions {
  /**
   * Full-access mode: shell hosts (cmd/powershell/pwsh/bash/sh) are allowed.
   * Deletion commands and git clean/reset remain denied in every mode.
   */
  readonly unrestricted?: boolean;
}

export class CommandPolicy {
  public constructor(private readonly options: CommandPolicyOptions = {}) {}

  public decide(profile: PermissionProfile, executable: string, source: CommandSource, args: readonly string[] = []): PermissionDecision {
    const basename = path.win32.basename(executable).toLowerCase();
    if (this.options.unrestricted !== true && SHELL_HOSTS.has(basename)) return 'DENY';
    if (DELETE_EXECUTABLES.has(basename) || looksLikeDeleteInvocation(basename, args)) return 'DENY';

    if (source === 'project') {
      if (!profile.allowedProjectExecutables.includes(basename)) return 'DENY';
      return profile.defaults.EXECUTE;
    }
    if (!profile.allowedProjectExecutables.includes(basename) && profile.name !== 'full') return 'ASK';
    return profile.defaults.EXECUTE;
  }
}

function looksLikeDeleteInvocation(basename: string, args: readonly string[]): boolean {
  const joined = args.join(' ').toLowerCase();
  if (basename === 'git.exe' || basename === 'git') {
    return /\bclean\b/.test(joined) || /\breset\b/.test(joined);
  }
  return false;
}
