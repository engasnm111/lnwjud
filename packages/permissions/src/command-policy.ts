import path from 'node:path';
import type { PermissionDecision, PermissionProfile } from './types.js';

export type CommandSource = 'client' | 'project';

const DELETE_EXECUTABLES = new Set([
  'del', 'del.exe', 'erase', 'erase.exe', 'rm', 'rm.exe', 'rmdir', 'rmdir.exe', 'rd', 'rd.exe',
  'unlink', 'unlink.exe', 'remove-item',
]);

export interface CommandPolicyOptions {
  /**
   * Full-access mode remains a compatibility switch for callers. Shell-host
   * identity is not itself a risk boundary; risky argv and cwd scope are
   * classified separately before dispatch.
   */
  readonly unrestricted?: boolean;
}

export class CommandPolicy {
  public constructor(private readonly options: CommandPolicyOptions = {}) {}

  public decide(profile: PermissionProfile, executable: string, source: CommandSource, args: readonly string[] = []): PermissionDecision {
    void this.options;
    void args;
    const basename = path.win32.basename(executable).toLowerCase();
    if (DELETE_EXECUTABLES.has(basename)) return 'ASK';

    if (source === 'project') {
      if (!profile.allowedProjectExecutables.includes(basename)) return 'DENY';
      return profile.defaults.EXECUTE;
    }
    if (!profile.allowedProjectExecutables.includes(basename) && profile.name !== 'full') return 'ASK';
    return profile.defaults.EXECUTE;
  }
}
