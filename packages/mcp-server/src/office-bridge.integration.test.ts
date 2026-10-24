import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PowerShellWindowsCapabilityBridge } from '@lnwjud/capabilities';

describe.skipIf(process.platform !== 'win32')('Windows Office bridge boundary integration', () => {
  it('executes the integrity-checked bridge from a literal path containing spaces, apostrophes, Thai and emoji', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "lnwjud Office O'Brien ไทย 😀-"));
    try {
      const source = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
      const scriptPath = path.join(root, "bridge O'Brien ไทย 😀.ps1");
      await copyFile(source, scriptPath);
      const bytes = await readFile(scriptPath);
      const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256: createHash('sha256').update(bytes).digest('hex'), expectedScriptSizeBytes: bytes.length });
      const app = "ไทย 😀 O'Brien $(Get-Process)";
      // Hosted Windows CI sometimes cold-starts PowerShell beyond 60s under load;
      // never accept PROCESS_TIMEOUT instead of the exact Unicode error.
      await expect(bridge.execute({ capability: 'office', input: { app, action: 'status', timeout_seconds: 120 } })).resolves.toMatchObject({ ok: false, error: { message: `Windows native capability failed: Unsupported office app: ${app}` } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 145_000);
  it('preserves Thai and supplementary characters through the actual process boundary without COM dispatch', async () => {
    const scriptPath = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath });
    const app = 'ไทย 😀';
    const result = await bridge.execute({ capability: 'office', input: { app, action: 'status', timeout_seconds: 20 } });
    expect(result).toMatchObject({ ok: false, error: { message: `Windows native capability failed: Unsupported office app: ${app}` } });
  }, 30_000);
  it('uses the UTF-8 protocol even when the parent console starts with another code page', async () => {
    const scriptPath = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
    const app = 'ไทย 😀';
    const payload = Buffer.from(JSON.stringify({ capability: 'office', input: { app, action: 'status' } }), 'utf8').toString('base64');
    const command = `[Console]::InputEncoding=[Text.Encoding]::GetEncoding(1252); [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(1252); $requestJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')); $requestJson | & '${scriptPath.replaceAll("'", "''")}'`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, output) => { if (error !== null) reject(error); else resolve(output); });
      child.stdin?.end(JSON.stringify({ capability: 'office', input: { app, action: 'status' } }), 'utf8');
    });
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { message: `Windows native capability failed: Unsupported office app: ${app}` } });
  }, 30_000);
  it('passes real PowerShell parsing and extracted helper execution with controlled provider objects', async () => {
    const script = fileURLToPath(new URL('../../../scripts/test-office-bridge-helpers.ps1', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(stderr).toBe('');
    expect(stdout).toContain('Office bridge helper boundary, Unicode, macro/link policy, readback and lifecycle checks passed.');
  }, 45_000);
  it('captures all Office account action effects without using a real account or sending', async () => {
    const script = fileURLToPath(new URL('../../../scripts/test-office-account-dispatch.ps1', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(stderr).toBe('');
    expect(stdout).toContain('All 17 Office account actions passed captured-provider checks.');
  });
  it('preserves borrowed PowerPoint applications and bounds cross-process ownership contention', async () => {
    const script = fileURLToPath(new URL('../../../scripts/test-office-powerpoint-lifetime.ps1', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(stderr).toBe('');
    expect(stdout).toContain('PowerPoint borrowed/created ownership, bounded contention and abandoned-lock recovery passed.');
  });
});

describe.skipIf(process.platform !== 'win32' || process.env.LNWJUD_RUN_OFFICE_COM_ACCEPTANCE !== '1')('Windows Office disposable COM artifact acceptance', () => {
  it('keeps UTF16 run boundaries lossless across actual UTF8 process output and bounded continuation', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'lnwjud Word Unicode runs-'));
    try {
      const scriptPath = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
      const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath });
      const file = path.join(root, 'runs.docx');
      const text = '😀ไทย😀x';
      await expect(bridge.execute({ capability: 'office', input: { app: 'word', action: 'create', file_path: file, text, timeout_seconds: 30 } })).resolves.toMatchObject({ ok: true });
      const pageSchema = z.object({ runs: z.array(z.object({ text: z.string() })), next_start: z.number(), range_end: z.number(), boundary_adjustment_utf16_units: z.number(), returned_utf16_units: z.number(), maximum_returned_utf16_units: z.number() });
      const leading = await bridge.execute({ capability: 'office', input: { app: 'word', action: 'get_runs', file_path: file, parameters: { max_characters: 1 }, timeout_seconds: 30 } });
      const first = pageSchema.parse(leading.ok ? leading.value : undefined);
      expect(first.runs.map((run) => run.text).join('')).toBe('😀');
      expect(first).toMatchObject({ next_start: 2, returned_utf16_units: 2, maximum_returned_utf16_units: 2, boundary_adjustment_utf16_units: 1 });
      const middleResult = await bridge.execute({ capability: 'office', input: { app: 'word', action: 'get_runs', file_path: file, range: { start: first.next_start, end: first.range_end }, parameters: { max_characters: 4 }, timeout_seconds: 30 } });
      const middle = pageSchema.parse(middleResult.ok ? middleResult.value : undefined);
      expect(middle.runs.map((run) => run.text).join('')).toBe('ไทย😀');
      expect(middle).toMatchObject({ next_start: 7, returned_utf16_units: 5, maximum_returned_utf16_units: 5, boundary_adjustment_utf16_units: 1 });
      const tailResult = await bridge.execute({ capability: 'office', input: { app: 'word', action: 'get_runs', file_path: file, range: { start: middle.next_start, end: middle.range_end }, parameters: { max_characters: 4 }, timeout_seconds: 30 } });
      const tail = pageSchema.parse(tailResult.ok ? tailResult.value : undefined);
      expect([...first.runs, ...middle.runs, ...tail.runs].map((run) => run.text).join('')).toBe(`${text}\r`);
      for (const range of [{ start: 6, end: middle.range_end }, { start: 2, end: 6 }]) {
        await expect(bridge.execute({ capability: 'office', input: { app: 'word', action: 'get_runs', file_path: file, range, timeout_seconds: 30 } })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('splits a Unicode surrogate pair') } });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000);
  it('persists exact Unicode and whitespace through Node stdin, closed DOCX and a fresh provider reopening', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "lnwjud O'Brien ไทย 😀-"));
    try {
      const scriptPath = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
      const file = path.join(root, "document O'Brien ไทย 😀.docx");
      const text = "  ไทย 😀 O'Brien $(Get-Process) literal \\u0e44  ";
      const creator = new PowerShellWindowsCapabilityBridge({ scriptPath });
      await expect(creator.execute({ capability: 'office', input: { app: 'word', action: 'create', file_path: file, text, timeout_seconds: 30 } })).resolves.toMatchObject({ ok: true, value: { saved: true } });
      const bytes = await readFile(file);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      const reopened = new PowerShellWindowsCapabilityBridge({ scriptPath });
      await expect(reopened.execute({ capability: 'office', input: { app: 'word', action: 'read_text', file_path: file, timeout_seconds: 30 } })).resolves.toMatchObject({ ok: true, value: { text: `${text}\r` } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 75_000);
  it('retains Excel row and column identities, literal escapes, Unicode and empty cells after reopening', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'lnwjud-excel-'));
    try {
      const scriptPath = fileURLToPath(new URL('../../capabilities/src/windows-capability-bridge.ps1', import.meta.url));
      const file = path.join(root, 'book.xlsx');
      const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath });
      const invoke = (action: string, input: Record<string, unknown> = {}): ReturnType<typeof bridge.execute> => bridge.execute({ capability: 'office', input: { app: 'excel', action, file_path: file, timeout_seconds: 30, ...input } });
      await expect(invoke('create')).resolves.toMatchObject({ ok: true, value: { saved: true } });
      const values = [['  ไทย 😀  ', 'literal \\u0e44'], [42, null]];
      await expect(invoke('write_values', { range: 'A1:B2', values })).resolves.toMatchObject({ ok: true, value: { saved: true } });
      const reopened = new PowerShellWindowsCapabilityBridge({ scriptPath });
      await expect(reopened.execute({ capability: 'office', input: { app: 'excel', action: 'read_values', file_path: file, range: 'A1:B2', timeout_seconds: 30 } })).resolves.toMatchObject({ ok: true, value: { values, rows: 2, columns: 2 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 110_000);
});
