import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
const helperPath = path.resolve('scripts/lib/lnwjud-tunnel-lock.ps1');
const starterPath = path.resolve('scripts/start-lnwjud-tunnel.ps1');

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('PowerShell tunnel lock helper', () => {
  it('acquires a complete record and removes every publish temporary file', async () => {
    const root = await temporaryDirectory();
    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 7 -OwnerStartedAt '2026-08-20T00:00:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} }
      $claim | ConvertTo-Json -Compress
    `);

    expect(JSON.parse(result.stdout)).toMatchObject({ acquired: true, owner: { pid: 7 } });
    expect(JSON.parse(await readFile(path.join(root, 'lnwjud.tunnel.lock'), 'utf8'))).toMatchObject({ version: 1, pid: 7 });
    expect((await readdir(root)).filter((name) => name.includes('.publish.'))).toEqual([]);
  });

  it('rejects a real concurrent second process, reports the owner, and cleans its publish file', async () => {
    const root = await temporaryDirectory();
    const releaseSignal = path.join(root, 'release');
    const holder = await startHolder(root, releaseSignal);
    try {
      const result = await runPowerShell(`
        . '${quote(helperPath)}'
        $started = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid $PID -OwnerStartedAt $started -ProcessStartProvider { param($id) $p=Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop; if($null -eq $p){[pscustomobject]@{state='gone'}}else{[pscustomobject]@{state='live';processStartedAt=$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)}} }
        $claim | ConvertTo-Json -Compress
      `);

      expect(JSON.parse(result.stdout)).toMatchObject({ acquired: false, owner: { pid: holder.pid } });
      expect((await readdir(root)).filter((name) => name.includes('.publish.'))).toEqual([]);
    } finally {
      await writeFile(releaseSignal, '', 'utf8');
      await waitForExit(holder.child);
    }
  });

  it.each([
    ['owner process is gone', null],
    ['PID start time changed', '2026-08-20T00:01:00.000Z'],
  ])('recovers a stale lock when %s', async (_name, actualStart) => {
    const root = await temporaryDirectory();
    await writeLock(root, { version: 1, pid: 7, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' });
    const provider = actualStart === null ? "[pscustomobject]@{state='gone'}" : `[pscustomobject]@{state='live';processStartedAt='${actualStart}'}`;

    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 8 -OwnerStartedAt '2026-08-20T00:02:00.000Z' -ProcessStartProvider { param($id) ${provider} }
      $claim | ConvertTo-Json -Compress
    `);

    expect(JSON.parse(result.stdout)).toMatchObject({ acquired: true, owner: { pid: 8 } });
    expect((await readdir(root)).filter((name) => name.includes('.stale.') || name.includes('.publish.'))).toEqual([]);
  });

  it('leaves the lock intact for a wrong owner and releases it for the exact owner', async () => {
    const root = await temporaryDirectory();
    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 7 -OwnerStartedAt '2026-08-20T00:00:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} }
      $wrong = [pscustomobject]@{ pid=7; processStartedAt='2026-08-20T00:00:00.000Z'; acquiredAt='2026-08-20T00:00:00.001Z' }
      $wrongReleased = Release-LnwjudTunnelLock -ProfileDir '${quote(root)}' -Owner $wrong
      $stillThere = Test-Path -LiteralPath (Join-Path '${quote(root)}' 'lnwjud.tunnel.lock')
      $rightReleased = Release-LnwjudTunnelLock -ProfileDir '${quote(root)}' -Owner $claim.owner
      [pscustomobject]@{ wrongReleased=$wrongReleased; stillThere=$stillThere; rightReleased=$rightReleased; existsAfter=(Test-Path -LiteralPath (Join-Path '${quote(root)}' 'lnwjud.tunnel.lock')) } | ConvertTo-Json -Compress
    `);

    expect(JSON.parse(result.stdout)).toEqual({ wrongReleased: false, stillThere: true, rightReleased: true, existsAfter: false });
    expect((await readdir(root)).filter((name) => name.includes('.released.') || name.includes('.publish.'))).toEqual([]);
  });

  it.each([
    ['string version', { version: '1', pid: 7, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['nonpositive version', { version: 0, pid: 7, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['string PID', { version: 1, pid: '7', processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['zero PID', { version: 1, pid: 0, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['negative PID', { version: 1, pid: -1, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['overflow PID', { version: 1, pid: 2_147_483_648, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['missing milliseconds', { version: 1, pid: 7, processStartedAt: '2026-08-20T00:00:00Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['non-UTC timestamp', { version: 1, pid: 7, processStartedAt: '2026-08-20T00:00:00.000+00:00', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['impossible date', { version: 1, pid: 7, processStartedAt: '2026-02-30T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
  ])('rejects invalid schema: %s', async (_name, record) => {
    const root = await temporaryDirectory();
    await writeLock(root, record);

    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      $record = Read-LnwjudTunnelLockRecord -LockPath (Join-Path '${quote(root)}' 'lnwjud.tunnel.lock')
      if($null -eq $record){'INVALID'}else{'VALID'}
    `);

    expect(result.stdout).toBe('INVALID');
    expect(JSON.parse(await readFile(path.join(root, 'lnwjud.tunnel.lock'), 'utf8'))).toEqual(record);
  });

  it('cleans its publish file when invalid fixed metadata rejects acquisition', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'lnwjud.tunnel.lock'), '{broken', 'utf8');

    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      try { Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 7 -OwnerStartedAt '2026-08-20T00:00:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} }; exit 2 } catch { Write-Output $_.Exception.Message }
    `);

    expect(result.stdout).toContain('invalid owner metadata');
    expect((await readdir(root)).filter((name) => name.includes('.publish.'))).toEqual([]);
  });

  it('fails closed and preserves the lock when the process probe is unverifiable', async () => {
    const root = await temporaryDirectory();
    const existing = { version: 1, pid: 77, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' };
    await writeLock(root, existing);
    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      try { Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 88 -OwnerStartedAt '2026-08-20T00:01:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='unverifiable';reason='access_denied'} }; exit 2 } catch { Write-Output $_.Exception.Message }
    `);
    expect(result.stdout).toContain('owner liveness is unverifiable: access_denied');
    expect(JSON.parse(await readFile(path.join(root, 'lnwjud.tunnel.lock'), 'utf8'))).toEqual(existing);
  });

  it('keeps the newly published owner acquired when stale quarantine cleanup is obstructed', async () => {
    const root = await temporaryDirectory();
    await writeLock(root, { version: 1, pid: 970, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' });
    const result = await runPowerShell(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 971 -OwnerStartedAt '2026-08-20T00:01:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} } -AfterStaleQuarantine {
        $quarantine = Get-ChildItem -LiteralPath '${quote(root)}' -Filter 'lnwjud.tunnel.lock.stale.*' | Select-Object -First 1
        Remove-Item -LiteralPath $quarantine.FullName -Force
        New-Item -ItemType Directory -Path $quarantine.FullName | Out-Null
        Set-Content -LiteralPath (Join-Path $quarantine.FullName 'obstruction') -Value 'fixture'
      }
      $claim | ConvertTo-Json -Compress
    `);

    expect(JSON.parse(result.stdout)).toMatchObject({ acquired: true, owner: { pid: 971 } });
    expect(JSON.parse(await readFile(path.join(root, 'lnwjud.tunnel.lock'), 'utf8'))).toMatchObject({ pid: 971 });
  });

  it('serializes a PowerShell stale reclaimer against a second reclaimer and fresh third publisher', async () => {
    const root = await temporaryDirectory();
    const releaseSignal = path.join(root, 'allow-publish');
    await writeLock(root, { version: 1, pid: 980, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' });
    const first = spawnPowerShellCapture(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid 981 -OwnerStartedAt '2026-08-20T00:01:00.000Z' -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} } -AfterStaleQuarantine {
        [Console]::Out.WriteLine('QUARANTINED'); [Console]::Out.Flush()
        while(-not (Test-Path -LiteralPath '${quote(releaseSignal)}')) { Start-Sleep -Milliseconds 10 }
      }
      $claim | ConvertTo-Json -Compress
    `);
    await first.waitFor('QUARANTINED');

    let secondSettled = false;
    let thirdSettled = false;
    const contender = (pid: number, startedAt: string): Promise<{ stdout: string; stderr: string }> => runPowerShell(`
      . '${quote(helperPath)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(root)}' -OwnerPid ${pid} -OwnerStartedAt '${startedAt}' -ProcessStartProvider { param($id) if($id -eq 981){[pscustomobject]@{state='live';processStartedAt='2026-08-20T00:01:00.000Z'}}else{[pscustomobject]@{state='gone'}} }
      $claim | ConvertTo-Json -Compress
    `);
    const second = contender(982, '2026-08-20T00:02:00.000Z').finally(() => { secondSettled = true; });
    const third = contender(983, '2026-08-20T00:03:00.000Z').finally(() => { thirdSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);
    expect(thirdSettled).toBe(false);

    await writeFile(releaseSignal, '', 'utf8');
    await first.completed;
    const results = await Promise.all([second, third]);
    expect(results.map((result) => JSON.parse(result.stdout))).toEqual([
      expect.objectContaining({ acquired: false, owner: expect.objectContaining({ pid: 981 }) }),
      expect.objectContaining({ acquired: false, owner: expect.objectContaining({ pid: 981 }) }),
    ]);
    expect(await readFile(path.join(root, 'lnwjud.tunnel.lock'), 'utf8')).toContain('"pid":981');
  });
});

describe.runIf(process.platform === 'win32')('production PowerShell tunnel starter integration', () => {
  it('loads the helper, reports its real concurrent owner, and never invokes the configured client', async () => {
    const root = await temporaryDirectory();
    const profileDir = path.join(root, 'tunnel-client');
    const releaseSignal = path.join(root, 'release');
    const sentinel = path.join(root, 'client-invoked');
    const fakeClient = path.join(root, 'fake-tunnel-client.cmd');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'not-read-while-lock-is-owned', 'utf8');
    await writeFile(fakeClient, `@echo invoked>"${sentinel}"\r\n@exit /b 99\r\n`, 'utf8');
    const holder = await startHolder(profileDir, releaseSignal);
    try {
      const result = await runPowerShellFile(starterPath, [
        '-TunnelClientPath', fakeClient,
        '-NoViewer',
        '-Once',
      ], { APPDATA: root, USERPROFILE: root, LOCALAPPDATA: root });

      expect(result.stdout).toContain(`already owned by PID ${holder.pid}`);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await writeFile(releaseSignal, '', 'utf8');
      await waitForExit(holder.child);
    }
  });

  it('does not erase the active owner stop marker when the starter loses the lock', async () => {
    const root = await temporaryDirectory();
    const profileDir = path.join(root, 'tunnel-client');
    const releaseSignal = path.join(root, 'release');
    const marker = path.join(profileDir, 'lnwjud.tunnel.stop');
    const fakeClient = path.join(root, 'fake-tunnel-client.cmd');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'not-read', 'utf8');
    await writeFile(marker, 'active-owner-stop', 'utf8');
    await writeFile(fakeClient, '@exit /b 99\r\n', 'utf8');
    const holder = await startHolder(profileDir, releaseSignal);
    try {
      await runPowerShellFile(starterPath, ['-TunnelClientPath', fakeClient, '-NoViewer', '-Once'], { APPDATA: root, USERPROFILE: root, LOCALAPPDATA: root });
      expect(await readFile(marker, 'utf8')).toBe('active-owner-stop');
    } finally {
      await writeFile(releaseSignal, '', 'utf8');
      await waitForExit(holder.child);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ps-lock-'));
  temporaryRoots.push(root);
  return root;
}

async function writeLock(root: string, record: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'lnwjud.tunnel.lock'), JSON.stringify(record), 'utf8');
}

async function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  return runPowerShellProcess(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

async function runPowerShellFile(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return runPowerShellProcess(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], env);
}

async function runPowerShellProcess(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) resolve(result);
      else reject(new Error(`PowerShell exited ${code ?? 'unknown'}: ${result.stderr || result.stdout}`));
    });
  });
}

async function startHolder(profileDir: string, releaseSignal: string): Promise<{ child: ChildProcess; pid: number }> {
  const script = `
    . '${quote(helperPath)}'
    $started = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(profileDir)}' -OwnerPid $PID -OwnerStartedAt $started -ProcessStartProvider { param($id) [pscustomobject]@{state='gone'} }
    Write-Output "READY:$PID"
    [Console]::Out.Flush()
    while(-not (Test-Path -LiteralPath '${quote(releaseSignal)}')) { Start-Sleep -Milliseconds 20 }
    [void](Release-LnwjudTunnelLock -ProfileDir '${quote(profileDir)}' -Owner $claim.owner)
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const pid = await new Promise<number>((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const match = /READY:(\d+)/.exec(output);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.stderr?.on('data', (chunk: string) => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Lock holder exited early (${code ?? 'unknown'}): ${errors}`)));
  });
  return { child, pid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell lock holder did not exit'));
    }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function quote(value: string): string {
  return value.replace(/'/g, "''");
}

function spawnPowerShellCapture(script: string): { readonly completed: Promise<{ stdout: string; stderr: string }>; waitFor(pattern: string): Promise<void> } {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const completed = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() }) : reject(new Error(`PowerShell exited ${code ?? 'unknown'}: ${stderr || stdout}`)));
  });
  return {
    completed,
    waitFor: async (pattern): Promise<void> => {
      const started = Date.now();
      while (!stdout.includes(pattern)) {
        if (Date.now() - started > 3_000) throw new Error(`PowerShell did not emit ${pattern}: ${stderr || stdout}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
