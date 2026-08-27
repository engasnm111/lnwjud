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

  it('allows normal shell hosts in Balanced and leaves Safe approval semantics intact', () => {
    expect(policy.decide(permissionProfiles.balanced, 'powershell.exe', 'project')).toBe('ALLOW');
    expect(policy.decide(permissionProfiles.balanced, 'cmd.exe', 'client')).toBe('ALLOW');
    expect(policy.decide(permissionProfiles.balanced, 'python.exe', 'client')).toBe('ALLOW');
    expect(policy.decide(permissionProfiles.safe, 'powershell.exe', 'client')).toBe('ASK');
  });

  it('asks before delete/remove executables', () => {
    expect(policy.decide(permissionProfiles.full, 'rm.exe', 'client', ['-rf', 'tmp'])).toBe('ASK');
    expect(policy.decide(permissionProfiles.full, 'del', 'client', ['file.txt'])).toBe('ASK');
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

  it('asks before delete/remove executables in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'rm.exe', 'client', ['-rf', 'tmp'])).toBe('ASK');
    expect(unrestricted.decide(permissionProfiles.full, 'del', 'client', ['file.txt'])).toBe('ASK');
    expect(unrestricted.decide(permissionProfiles.full, 'remove-item', 'client')).toBe('ASK');
  });

  it('allows every git subcommand including rm, clean, and reset at this layer', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['init'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['rm', '-rf', 'old.txt'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['clean', '-fd'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git.exe', 'client', ['reset', '--hard'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['push', '-u', 'origin', 'main'])).toBe('ALLOW');
  });
});
