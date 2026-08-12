import { describe, expect, it } from 'vitest';
import { permissionProfiles } from './profiles.js';
import { CommandPolicy } from './command-policy.js';

const policy = new CommandPolicy();

describe('CommandPolicy', () => {
  it('allows a detected project package command in Balanced', () => {
    expect(policy.decide(permissionProfiles.balanced, 'pnpm', 'project')).toBe('ALLOW');
  });

  it('asks before an unknown client executable in Balanced', () => {
    expect(policy.decide(permissionProfiles.balanced, 'custom-tool.exe', 'client')).toBe('ASK');
  });

  it('denies shell hosts even when presented as a project command', () => {
    expect(policy.decide(permissionProfiles.balanced, 'powershell.exe', 'project')).toBe('DENY');
    expect(policy.decide(permissionProfiles.full, 'cmd.exe', 'project')).toBe('DENY');
  });

  it('denies delete/remove executables', () => {
    expect(policy.decide(permissionProfiles.full, 'rm.exe', 'client', ['-rf', 'tmp'])).toBe('DENY');
    expect(policy.decide(permissionProfiles.full, 'del', 'client', ['file.txt'])).toBe('DENY');
  });

  it('asks before every execute operation in Safe', () => {
    expect(policy.decide(permissionProfiles.safe, 'pnpm', 'project')).toBe('ASK');
  });
});
