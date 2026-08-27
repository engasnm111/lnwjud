import { describe, expect, it } from 'vitest';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';

describe('agent command policy', () => {
  it.each([
    ['format.com', ['C:']],
    ['diskpart.exe', []],
    ['shutdown.exe', ['/s']],
    ['powershell.exe', ['-Command', 'Restart-Computer']],
  ] as const)('hard-blocks machine-level command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['rm.exe', ['-rf', 'target']],
    ['C:/Windows/System32/DEL.CMD', ['target']],
    ['Remove-Item.bat', ['target']],
    ['powershell.exe', ['-Command', 'Remove-Item target']],
    ['pwsh', ['-EncodedCommand', 'AAAA']],
    ['cmd.exe', ['/C', 'del target']],
    ['bash', ['-lc', 'rm -rf target']],
    ['node.exe', ['--eval', 'require("fs").rmSync("x")']],
    ['python3.exe', ['-c', 'import os; os.remove("x")']],
    ['robocopy.exe', ['source', 'target', '/MIR']],
    ['rsync', ['-a', '--delete', 'source/', 'target/']],
    ['sed', ['-i.bak', 's/a/b/', 'target']],
  ] as const)('requires confirmation for risky command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    [['clean', '-fd']],
    [['reset', '--hard']],
    [['restore', '--worktree', '.']],
    [['push', '--force', 'origin', 'main']],
  ] as const)('requires confirmation for destructive git invocation %j', (args) => {
    expect(riskyAgentCommandReason('git.exe', args)).toBeDefined();
  });

  it.each([
    ['pnpm.cmd', ['test']],
    ['cp.com', ['source', 'target']],
    ['MV.EXE', ['source', 'target']],
    ['xcopy.exe', ['source', 'target']],
    ['node.exe', ['script.js']],
    ['python.exe', ['script.py']],
    ['powershell.exe', ['-NoProfile', '-File', 'script.ps1']],
    ['powershell.exe', ['-Command', 'Get-ChildItem']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p='artifact.exe'; $i=Get-Item -LiteralPath $p; $h=Get-FileHash -Algorithm SHA256 -LiteralPath $p; [pscustomobject]@{Path=$i.FullName; Length=$i.Length; SHA256=$h.Hash} | ConvertTo-Json -Compress"]],
    ['cmd.exe', ['/C', 'echo ok']],
    ['git.exe', ['status', '--short']],
  ] as const)('allows normal command without confirmation: %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeUndefined();
  });

  it('treats dynamically constructed PowerShell as risky', () => {
    expect(riskyAgentCommandReason('powershell.exe', ['-Command', "& ('Remove'+'-Item') x"])).toBeDefined();
  });
});
