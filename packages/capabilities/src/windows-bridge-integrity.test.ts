import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerShellWindowsCapabilityBridge } from './windows-bridge.js';

const temporaryRoots: string[] = [];

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    child.stdin.on('finish', () => {
      child.stdout.write('{"ok":true,"value":{"trusted":true}}');
      child.emit('close', 0);
    });
    return child as ReturnType<typeof spawn>;
  });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PowerShellWindowsCapabilityBridge integrity', () => {
  it('executes a script only when its SHA-256 matches the embedded expectation', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const script = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, script, 'utf8');
    const expectedScriptSha256 = sha256(script);
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256, platform: 'win32' });

    await expect(bridge.execute({ capability: 'system_info', input: { action: 'summary' } })).resolves.toEqual({ ok: true, value: { trusted: true } });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['-File', scriptPath]), expect.objectContaining({ shell: false }));
  }, 15_000);

  it('fails closed after the script changes, even if it was valid on a previous call', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const trusted = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, trusted, 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256: sha256(trusted), platform: 'win32' });
    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({ ok: true });

    await writeFile(scriptPath, '$input | Out-Null; Write-Output \'{"ok":true,"value":{"tampered":true}}\'', 'utf8');

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge script integrity check failed' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('fails closed when the bridge byte count differs from the embedded expectation', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const trusted = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, trusted, 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({
      scriptPath,
      expectedScriptSha256: sha256(trusted),
      expectedScriptSizeBytes: Buffer.byteLength(trusted, 'utf8') + 1,
      platform: 'win32',
    });

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge script integrity check failed' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('never quits the user Outlook instance from read-only bridge actions', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');
    const outlookStart = script.indexOf("if ($App -eq 'outlook')");
    const outlookEnd = script.indexOf('throw "Unsupported office app: $App"', outlookStart);
    expect(outlookStart).toBeGreaterThanOrEqual(0);
    expect(outlookEnd).toBeGreaterThan(outlookStart);
    const outlookSection = script.slice(outlookStart, outlookEnd);
    expect(outlookSection).not.toContain('$outlook.Quit()');
    expect(outlookSection).toContain('Release-ComObject $outlook');
  });

  it('keeps UI Automation observations compatible with the Windows PowerShell 5.x baseline used by Windows 10/11', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('elements = $items.ToArray()');
    expect(script).not.toContain('elements = @($items)');
    expect(script).toContain('[System.Windows.Automation.AutomationElement]::RootElement');
    expect(script).toContain('[void]$Items.Add');
    expect(script).toContain('function Get-FiniteUiBounds');
    expect(script).toContain('[double]::IsInfinity($value)');
    expect(script).toContain('bounds = $bounds');
    expect(script).not.toContain('bounds = [ordered]@{ x = [double]$rect.X; y = [double]$rect.Y; width = [double]$rect.Width; height = [double]$rect.Height }');
    expect(script).toContain("$failureMessage = 'Windows native capability failed'");
    expect(script).toContain("$failureMessage = $failureMessage + ': ' + $detail");
  });

  it('prefers a visible capturable window for ambiguous selectors and accepts app.name aliases', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('[switch]$PreferCapturable');
    expect(script).toContain("$name = Get-Field $Parameters 'name'");
    expect(script).toContain("-PreferCapturable");
    expect(script).toContain("[bool]$_.visible -and -not [bool]$_.minimized");
    expect(script).toContain("[int]$_.bounds.width -gt 0 -and [int]$_.bounds.height -gt 0");
    expect(script).toContain("Sort-Object @{ Expression = { [int64]$_.bounds.width * [int64]$_.bounds.height }; Descending = $true }");
    expect(script).toContain("$failureCode = 'INVALID_INPUT'");
    expect(script).toContain("$failureMessage = $detail");
  });

  it('validates captured PNG bytes before returning them and includes round-trip integrity metadata', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('[System.IO.MemoryStream]::new($bytes, $false)');
    expect(script).toContain('[System.Drawing.Image]::FromStream($verifyStream, $true, $true)');
    expect(script).toContain("throw 'Capture image validation failed'");
    expect(script).toContain('[System.Security.Cryptography.SHA256]::Create()');
    expect(script).toContain('byte_length = [int]$bytes.Length');
    expect(script).toContain('sha256 = $sha256');
  });

  it('rejects a missing or malformed expected hash before starting PowerShell', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    await writeFile(scriptPath, 'Write-Output \'{}\'', 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256: 'missing', platform: 'win32' });

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge integrity manifest is missing or invalid' },
    });
  });
});

async function temporaryRoot(): Promise<string> {
  // GitHub Hosted Windows runners may expose os.tmpdir() through an infrastructure
  // junction. Canonicalize that parent first so the fixture itself is a regular,
  // non-reparse path while production integrity checks remain fail-closed.
  const canonicalTemp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(canonicalTemp, 'lnwjud-bridge-integrity-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
