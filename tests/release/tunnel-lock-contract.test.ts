import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PowerShell tunnel launcher ownership contract', () => {
  it('parses and delegates ownership to the side-effect-free helper without local lock definitions', async () => {
    const starter = path.resolve('scripts/start-lnwjud-tunnel.ps1').replace(/'/g, "''");
    const helper = path.resolve('scripts/lib/lnwjud-tunnel-lock.ps1').replace(/'/g, "''");
    const result = await runPowerShell(`
      $tokens=$null; $errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${starter}',[ref]$tokens,[ref]$errors)
      $helperTokens=$null; $helperErrors=$null
      $helperAst=[Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$helperTokens,[ref]$helperErrors)
      $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -like '*LnwjudTunnelLock*'},$true)).Count
      $dotSources=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot},$true) | ForEach-Object { $_.Extent.Text })
      $commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object { $_.GetCommandName() })
      $helperSideEffects=@($helperAst.EndBlock.Statements | Where-Object {$_ -isnot [Management.Automation.Language.FunctionDefinitionAst]}).Count
      [pscustomobject]@{ errors=$errors.Count; helperErrors=$helperErrors.Count; helperSideEffects=$helperSideEffects; functions=$functions; dotSources=$dotSources; enter=(@($commands | Where-Object {$_ -eq 'Enter-LnwjudTunnelLock'}).Count); release=(@($commands | Where-Object {$_ -eq 'Release-LnwjudTunnelLock'}).Count) } | ConvertTo-Json -Compress
    `);

    expect(JSON.parse(result)).toMatchObject({ errors: 0, helperErrors: 0, helperSideEffects: 0, functions: 0, enter: 1, release: 1 });
    expect(JSON.parse(result).dotSources).toEqual(expect.arrayContaining([expect.stringContaining('$lockHelperResolved')]));
    const starterSource = await readFile(path.resolve('scripts/start-lnwjud-tunnel.ps1'), 'utf8');
    expect(starterSource).toContain('lnwjud-tunnel-lock.ps1');
    expect(starterSource).toContain('Resolve-Path -LiteralPath $lockHelperRequested');
    expect(starterSource).toContain('[IO.FileAttributes]::ReparsePoint');
  });
});

async function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited ${code ?? 'unknown'}`)));
  });
}
