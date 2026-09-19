import { describe, expect, it } from 'vitest';
import { AutomationExecutionPolicyService } from './automation-execution-policy.js';

const policy = new AutomationExecutionPolicyService();

function shell(
  executable: string,
  args: readonly string[],
  userConfirmed = false,
): ReturnType<AutomationExecutionPolicyService['decide']> {
  return policy.decide({
    policyProfile: 'coding_guarded',
    execution: {
      provider: 'shell' as const,
      executable,
      arguments: args,
    },
    userConfirmed,
  });
}

describe('AutomationExecutionPolicyService coding_guarded', () => {
  it('allows ordinary build and test execution', () => {
    expect(shell('pnpm.cmd', ['test'])).toMatchObject({
      allowed: true,
      code: 'allowed',
    });
    expect(shell('node.exe', ['scripts/check.mjs'])).toMatchObject({
      allowed: true,
    });
  });

  it.each([
    ['chrome.exe', ['https://example.com']],
    ['playwright.cmd', ['test']],
    ['node.exe', ['-e', "require('playwright').chromium.launch()"]],
    ['powershell.exe', ['-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("x")']],
  ])('hard-denies browser and desktop automation: %s', (executable, args) => {
    expect(shell(executable, args, true)).toMatchObject({
      allowed: false,
      code: 'browser_or_desktop_control_denied',
    });
  });

  it.each([
    ['git', ['clean', '-fdx']],
    ['git', ['reset', '--hard']],
    ['bash', ['-c', 'rm -rf ./repo']],
    ['powershell.exe', ['-Command', 'Remove-Item -Recurse -Force .\\repo']],
    ['cmd.exe', ['/c', 'rmdir /s /q repo']],
  ])('hard-denies destructive workspace operations: %s', (executable, args) => {
    expect(shell(executable, args, true)).toMatchObject({
      allowed: false,
      code: 'destructive_workspace_operation_denied',
    });
  });

  it.each([
    ['git', ['push', 'origin', 'main']],
    ['git', ['merge', 'feature']],
    ['gh', ['release', 'create', 'v1.0.0']],
    ['pnpm', ['publish']],
    ['docker', ['push', 'example/app:latest']],
  ])('requires explicit authorization for release-like operations: %s', (executable, args) => {
    expect(shell(executable, args)).toMatchObject({
      allowed: false,
      code: 'explicit_authorization_required',
    });
    expect(shell(executable, args, true)).toMatchObject({
      allowed: true,
      code: 'allowed',
    });
  });

  it('requires explicit authorization for opaque Codex workspace execution', () => {
    expect(policy.decide({
      policyProfile: 'coding_guarded',
      execution: { provider: 'codex', instruction: 'Implement the next milestone.' },
      userConfirmed: false,
    })).toMatchObject({
      allowed: false,
      code: 'explicit_authorization_required',
    });
    expect(policy.decide({
      policyProfile: 'coding_guarded',
      execution: { provider: 'codex', instruction: 'Implement the next milestone.' },
      userConfirmed: true,
    })).toMatchObject({
      allowed: true,
    });
  });

  it('fails closed for unknown policy profiles', () => {
    expect(policy.decide({
      policyProfile: 'future_policy',
      execution: { provider: 'shell', executable: 'node', arguments: ['--version'] },
      userConfirmed: true,
    })).toMatchObject({
      allowed: false,
      code: 'unknown_policy_profile',
    });
  });
});
