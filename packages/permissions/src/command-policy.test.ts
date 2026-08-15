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

describe('CommandPolicy unrestricted', () => {
  const unrestricted = new CommandPolicy({ unrestricted: true });

  it('allows shell hosts in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'powershell.exe', 'client')).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'cmd.exe', 'client')).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'pwsh', 'client')).toBe('ALLOW');
  });

  it('still denies delete/remove executables in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'rm.exe', 'client', ['-rf', 'tmp'])).toBe('DENY');
    expect(unrestricted.decide(permissionProfiles.full, 'del', 'client', ['file.txt'])).toBe('DENY');
    expect(unrestricted.decide(permissionProfiles.full, 'remove-item', 'client')).toBe('DENY');
  });

  it('still denies git clean/reset in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['clean', '-fd'])).toBe('DENY');
    expect(unrestricted.decide(permissionProfiles.full, 'git.exe', 'client', ['reset', '--hard'])).toBe('DENY');
  });
});
