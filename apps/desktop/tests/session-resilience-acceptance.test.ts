import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'esbuild';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { ToolRegistry, readSharedActivitySnapshot, sharedActivityLeaseDirectoryPath, type McpApplicationServices } from '@lnwjud/mcp-server';
import { UpdateInstallCoordinator, type UpdateSharedActivitySnapshot } from '../src/main/update-install.js';
import { atomicWrite, buildIncidentReport, exportIncidentReport } from '../src/main/incident-report.js';
import { IncidentSaveCoordinator } from '../src/main/incident-save.js';
import { LogHub } from '../src/main/log-hub.js';
import { acquireTunnelLock, type TunnelLockOwner } from '../src/main/tunnel-lock.js';
import { TunnelController } from '../src/main/tunnel-controller.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const lockHelper = path.join(repositoryRoot, 'scripts', 'lib', 'lnwjud-tunnel-lock.ps1');
const tunnelStarter = path.join(repositoryRoot, 'scripts', 'start-lnwjud-tunnel.ps1');
const temporaryRoots: string[] = [];
const fixtureProcesses = new Set<ChildProcess>();

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all([...fixtureProcesses].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForExit(child).catch(() => undefined);
  }));
  fixtureProcesses.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session resilience acceptance', () => {
  it('keeps the bundled production MCP stdio entrypoint alive across sequential calls and an error on a non-E workspace', async () => {
    const root = await nonEDriveTemporaryDirectory();
    expect(path.parse(root).root.toUpperCase()).not.toBe('E:\\');
    const workspace = path.join(root, 'workspace');
    const dataPath = path.join(root, 'data');
    const bundlePath = path.join(root, 'lnwjud-mcp-stdio.cjs');
    await mkdir(workspace, { recursive: true });
    await build({
      entryPoints: [path.join(repositoryRoot, 'apps', 'cli', 'src', 'bin', 'mcp-stdio.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundlePath, '--workspace', workspace],
      env: {
        ...process.env,
        LNWJUD_DATA_PATH: dataPath,
        LNWJUD_RESET_WORKSPACES: '1',
        LNWJUD_CONFIRM_RESET_WORKSPACES: 'DELETE-REGISTERED-WORKSPACES',
        LNWJUD_UNRESTRICTED: '0',
      },
      stderr: 'pipe',
    });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString('utf8'); });
    const client = new Client(
      { name: 'lnwjud-production-stdio-acceptance', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      expect(tools.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);
      for (let index = 0; index < 3; index += 1) {
        const result = await client.callTool({ name: 'workspace_list', arguments: {} });
        expect(result.isError).not.toBe(true);
      }
      await expect(client.callTool({ name: 'definitely_not_a_real_tool', arguments: {} })).rejects.toThrow();
      const recovered = await client.callTool({ name: 'workspace_list', arguments: {} });
      expect(recovered.isError).not.toBe(true);
      expect(diagnostics).toContain('lnwjud MCP stdio ready');
      expect(diagnostics).toContain(await realpath(workspace));
      expect(diagnostics).not.toContain('E:\\ drive is required');
    } finally {
      await client.close();
    }
  }, 30_000);

  it.runIf(process.platform === 'win32')('keeps the desktop lock and production launcher to one owner in either winner order without running tunnel-client', async () => {
    const root = await temporaryDirectory();
    const profileDirectory = path.join(root, 'tunnel-client');
    const sentinel = path.join(root, 'tunnel-client-invoked');
    const fakeClient = path.join(root, 'fake-tunnel-client.cmd');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(path.join(profileDirectory, 'lnwjud.runtime.secret'), 'not-read-by-lock-loser', 'utf8');
    await writeFile(fakeClient, `@echo invoked>"${sentinel}"\r\n@exit /b 99\r\n`, 'utf8');

    const desktopOwner = await currentOwner();
    const desktop = await acquireTunnelLock({ profileDirectory, owner: desktopOwner });
    expect(desktop.acquired).toBe(true);
    if (!desktop.acquired) return;

    const scriptLoser = await runPowerShellFile(tunnelStarter, ['-TunnelClientPath', fakeClient, '-NoViewer', '-Once'], {
      APPDATA: root, USERPROFILE: root, LOCALAPPDATA: root,
    });
    expect(scriptLoser.stdout).toContain(`already owned by PID ${desktopOwner.pid}`);
    await expect(access(sentinel)).rejects.toThrow();
    expect(await desktop.release()).toBe(true);

    const holder = await startPowerShellHolder(profileDirectory, path.join(root, 'release-holder'));
    try {
      expect(holder.acquired).toBe(true);
      const desktopLoser = await acquireTunnelLock({ profileDirectory, owner: await currentOwner() });
      expect(desktopLoser).toEqual({ acquired: false, owner: expect.objectContaining({ pid: holder.pid }) });
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await writeFile(path.join(root, 'release-holder'), '', 'utf8');
      await waitForExit(holder.child);
    }

    const afterRelease = await acquireTunnelLock({ profileDirectory, owner: await currentOwner() });
    expect(afterRelease.acquired).toBe(true);
    if (afterRelease.acquired) expect(await afterRelease.release()).toBe(true);
  }, 15_000);

  it.runIf(process.platform === 'win32')('uses the same critical section across a TypeScript stale reclaim and PowerShell publisher', async () => {
    const root = await temporaryDirectory();
    const profileDirectory = path.join(root, 'tunnel-client');
    await mkdir(profileDirectory, { recursive: true });
    const stale = { version: 1, pid: 9001, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' };
    await writeFile(path.join(profileDirectory, 'lnwjud.tunnel.lock'), JSON.stringify(stale), 'utf8');
    const quarantined = deferred<void>();
    const allowPublish = deferred<void>();
    const winner: TunnelLockOwner = { pid: 9002, processStartedAt: '2026-08-20T00:01:00.000Z', acquiredAt: '2026-08-20T00:01:00.000Z' };
    const reclaim = acquireTunnelLock({
      profileDirectory,
      owner: winner,
      inspectProcess: async () => ({ state: 'gone' }),
      hooks: { afterStaleQuarantine: async () => { quarantined.resolve(); await allowPublish.promise; } },
    });
    await quarantined.promise;
    let publisherSettled = false;
    const publisher = runPowerShell(`
      . '${quote(lockHelper)}'
      $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(profileDirectory)}' -OwnerPid 9003 -OwnerStartedAt '2026-08-20T00:02:00.000Z' -ProcessStartProvider { param($id) if($id -eq 9002){[pscustomobject]@{state='live';processStartedAt='2026-08-20T00:01:00.000Z'}}else{[pscustomobject]@{state='gone'}} }
      $claim | ConvertTo-Json -Compress
    `).finally(() => { publisherSettled = true; });
    await delay(150);
    expect(publisherSettled).toBe(false);
    allowPublish.resolve();
    const winnerClaim = await reclaim;
    expect(winnerClaim.acquired).toBe(true);
    expect(JSON.parse((await publisher).stdout)).toMatchObject({ acquired: false, owner: { pid: winner.pid } });
    if (winnerClaim.acquired) expect(await winnerClaim.release()).toBe(true);
  });

  it('returns PROCESS_TIMEOUT before the remote deadline, terminates a real fixture process, and immediately accepts the next call', async () => {
    const localBudgetMs = 80;
    const remoteDeadlineMs = 500;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    fixtureProcesses.add(child);
    let terminated = false;
    let remoteDeadlineFired = false;
    let calls = 0;
    const registry = new ToolRegistry({
      search: {
        async searchFiles(): Promise<Result<{ files: string[]; truncated: boolean }>> { return ok({ files: [], truncated: false }); },
        async searchText(_actor, _workspaceId, _request, signal): Promise<Result<{ matches: { path: string; lineNumber: number; text: string }[]; truncated: boolean }>> {
          calls += 1;
          if (calls === 2) return ok({ matches: [], truncated: false });
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              if (child.exitCode === null) child.kill();
              void waitForExit(child).then(() => {
                terminated = true;
                resolve(err(appError('PROCESS_TIMEOUT', 'fixture child terminated', true)));
              });
            }, { once: true });
          });
        },
      },
    } satisfies McpApplicationServices, { clientId: 'acceptance', clientName: 'acceptance' }, { maxToolDurationMs: localBudgetMs });

    const remoteTimer = setTimeout(() => { remoteDeadlineFired = true; }, remoteDeadlineMs);
    const pending = registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'needle' });
    const timedOut = await pending;
    expect(timedOut).toMatchObject({ isError: true, structuredContent: { error: { code: 'PROCESS_TIMEOUT', recoverable: true } } });
    await waitUntil(() => terminated, 300);
    expect(terminated).toBe(true);
    expect(remoteDeadlineFired).toBe(false);
    await expect(registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'needle' }))
      .resolves.toMatchObject({ structuredContent: { matches: [] } });
    clearTimeout(remoteTimer);
    expect(remoteDeadlineFired).toBe(false);
  });

  it('defers exactly one update through a separate process activity lease, including a short begin/end transition', async () => {
    // Cross-process filesystem leases can take longer when the complete release
    // suite is running on a busy Windows worker. Keep these waits bounded, but
    // avoid treating normal CI contention as a fixture failure.
    const activityObservationTimeoutMs = 10_000;
    const root = await temporaryDirectory();
    const profileDirectory = path.join(root, 'tunnel-client');
    await mkdir(profileDirectory, { recursive: true });
    const activity = await startActivityFixture(root, profileDirectory);
    const install = vi.fn();
    try {
      const leaseDirectory = sharedActivityLeaseDirectoryPath(profileDirectory);
      const [leaseFile] = await readdir(leaseDirectory);
      expect(leaseFile).toBeDefined();
      const initialized = JSON.parse(await readFile(path.join(leaseDirectory, leaseFile!), 'utf8')) as { owner: { pid: number; processStartedAt: string } };
      expect(initialized.owner.pid).toBe(activity.child.pid);
      let observedShared: { activeCallCount: number; revision: number } | null = null;
      const observedRevisionCounts = new Map<number, number>();
      const sharedActivitySnapshot = async (): Promise<UpdateSharedActivitySnapshot> => {
        const observation = await readSharedActivitySnapshot({ profileDirectory, inspectProcess: async (pid) => pid === activity.child.pid ? { state: 'live', processStartedAt: initialized.owner.processStartedAt } : { state: 'gone' } });
        if (observation.state === 'available') {
          observedShared = { activeCallCount: observation.activeCount, revision: observation.revision };
          observedRevisionCounts.set(observation.revision, (observedRevisionCounts.get(observation.revision) ?? 0) + 1);
          return { state: 'available' as const, activeCallCount: observation.activeCount, revision: observation.revision, ownerKey: observation.ownerKey };
        }
        return observation;
      };
      const coordinator = new UpdateInstallCoordinator({ activeCallCount: (): number => 0, tunnelRunning: async (): Promise<boolean> => true, sharedActivitySnapshot, install, quietPeriodMs: 300, pollIntervalMs: 20 });
      await activity.command('BEGIN');
      coordinator.requestInstall();
      await waitUntil(() => observedShared?.activeCallCount === 1, activityObservationTimeoutMs);
      expect(install).not.toHaveBeenCalled();

      await activity.command('END');
      await waitUntil(() => observedShared?.activeCallCount === 0 && (observedShared?.revision ?? 0) >= 2, activityObservationTimeoutMs);
      await activity.command('BEGIN');
      await activity.command('END');
      const postTransition = await readSharedActivitySnapshot({ profileDirectory, inspectProcess: async (pid) => pid === activity.child.pid ? { state: 'live', processStartedAt: initialized.owner.processStartedAt } : { state: 'gone' } });
      if (postTransition.state !== 'available') throw new Error(`activity snapshot unavailable after short transition: ${postTransition.state}`);
      const postTransitionRevision = postTransition.revision;
      await waitUntil(() => (observedRevisionCounts.get(postTransitionRevision) ?? 0) >= 2, activityObservationTimeoutMs);
      expect(install).not.toHaveBeenCalled();

      await waitUntil(() => install.mock.calls.length === 1, 5_000);
      expect(install).toHaveBeenCalledOnce();
    } finally {
      await activity.close();
    }
  }, 30_000);

  it('probes TunnelController against a real ephemeral HTTP /healthz endpoint', async () => {
    const root = await temporaryDirectory();
    vi.stubEnv('APPDATA', path.join(root, 'appdata'));
    const profile = path.join(root, 'appdata', 'tunnel-client');
    await mkdir(profile, { recursive: true });
    let requested = '';
    const server = createHttpServer((request, response) => { requested = request.url ?? ''; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"live"}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('ephemeral health server did not bind');
    await writeFile(path.join(profile, 'lnwjud.yaml'), 'health:\n  listen_addr: "127.0.0.1:0"\n', 'utf8');
    await writeFile(path.join(profile, 'lnwjud-tunnel.log'), `health server listening at 127.0.0.1:${address.port}\n`, 'utf8');
    try {
      const controller = new TunnelController({ getClientPath: (): null => null, setClientPath: (): void => undefined, getDataPath: (): string => root });
      await expect(controller.incidentHealth()).resolves.toMatchObject({ state: 'live' });
      expect(requested).toBe('/healthz');
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  });

  it('captures lifecycle-precedence classifications and a bounded, redacted incident export through the production correlator', async () => {
    const failed = await incidentReport({ resultCode: 'FAILED', triggeredByUser: true, health: 'live' });
    expect(failed.classification).toBe('local_tool_failed');
    const failedWithTunnelDisconnect = await incidentReport({ resultCode: 'FAILED', triggeredByUser: true, health: 'live', tunnelLine: 'stdio MCP command exited.' });
    expect(failedWithTunnelDisconnect.classification).toBe('local_tool_failed');
    const disconnected = await incidentReport({ resultCode: 'SUCCESS', triggeredByUser: true, health: 'live', tunnelLine: 'stdio MCP command exited.' });
    expect(disconnected.classification).toBe('tunnel_disconnected');
    const remote = await incidentReport({ resultCode: 'SUCCESS', triggeredByUser: true, health: 'live' });
    expect(remote.classification).toBe('remote_turn_stopped');
    const inconclusive = await incidentReport({ resultCode: 'SUCCESS', triggeredByUser: false, health: 'unavailable' });
    expect(inconclusive.classification).toBe('healthy_or_inconclusive');

    let exported = '';
    const outcome = await exportIncidentReport({
      triggeredByUser: true,
      appVersion: 'password=acceptance-secret',
      tunnelClientVersion: null,
      tunnel: { state: 'running', source: 'desktop', message: 'Authorization: Bearer acceptance-token', health: { state: 'live', message: null } },
      updaterEvents: Array.from({ length: 250 }, (_, index) => `update-downloaded:4.0.${index}`),
      logLines: remote.__lines,
    }, {
      choosePath: async () => path.join(await temporaryDirectory(), 'incident.json'),
      writeAtomically: async (_file, content) => { exported = content; },
    });
    expect(outcome).toMatchObject({ exported: true, cancelled: false, classification: 'remote_turn_stopped' });
    expect(exported).not.toContain('acceptance-secret');
    expect(exported).not.toContain('acceptance-token');
    const parsed = JSON.parse(exported) as { updaterEventTail: Array<{ category: string; version?: string }> };
    expect(parsed.updaterEventTail).toHaveLength(200);
    expect(parsed.updaterEventTail.every((event) => event.category === 'update-downloaded' && event.version !== undefined)).toBe(true);
  });

  it('runs the production incident save workflow through cancel, error, and atomic success', async () => {
    const root = await temporaryDirectory();
    const report = await incidentReport({ resultCode: 'SUCCESS', triggeredByUser: true, health: 'live' });
    const cancelled = new IncidentSaveCoordinator({ capture: async (): Promise<typeof report> => report, choosePath: async (): Promise<null> => null, write: atomicWrite });
    await expect(cancelled.captureAndSave()).resolves.toMatchObject({ exported: false, cancelled: true });
    const failed = new IncidentSaveCoordinator({ capture: async (): Promise<typeof report> => report, choosePath: async (): Promise<string> => path.join(root, 'missing', 'incident.json'), write: atomicWrite });
    await expect(failed.captureAndSave()).rejects.toThrow();
    const destination = path.join(root, 'incident.json');
    const saved = new IncidentSaveCoordinator({ capture: async (): Promise<typeof report> => report, choosePath: async (): Promise<string> => destination, write: atomicWrite });
    await expect(saved.captureAndSave()).resolves.toMatchObject({ exported: true, cancelled: false });
    expect(JSON.parse(await readFile(destination, 'utf8'))).toMatchObject({ schemaVersion: 1, classification: 'remote_turn_stopped' });
  });

  it('keeps the acceptance, operator, and composed resilience surfaces free of fixed nonzero listener ports', async () => {
    const [testSource, packageJson, readme, tunnelController, powerShellHelper, tunnelLauncher] = await Promise.all([
      readFile(import.meta.filename, 'utf8'),
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
      readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'tunnel-controller.ts'), 'utf8'),
      readFile(lockHelper, 'utf8'),
      readFile(tunnelStarter, 'utf8'),
    ]);
    const operatorGuidance = section(readme, '### Session resilience /', '## Security and operational model');
    expect(findFixedListenerBindings([testSource, packageJson, operatorGuidance, tunnelController, powerShellHelper, tunnelLauncher])).toEqual([]);
    expect(findFixedListenerBindings([
      ['server.', 'listen(', 6789, ')'].join(''),
      ['http://', '127.0.0.1', ':', 7654, '/healthz'].join(''),
      ['listen_addr: "', 'localhost', ':', 4321, '"'].join(''),
    ])).toHaveLength(3);
    expect(findFixedListenerBindings(['server.listen(0)', 'http://$address/healthz', 'listen_addr: "127.0.0.1:0"'])).toEqual([]);
    expect(operatorGuidance).toContain("$tc = if ($env:LNWJUD_TUNNEL_CLIENT_PATH)");
    expect(operatorGuidance).toContain('& $tc doctor --profile lnwjud --profile-dir $profile --explain');
  });
});

async function incidentReport(options: { resultCode: 'SUCCESS' | 'FAILED'; triggeredByUser: boolean; health: 'live' | 'unavailable'; tunnelLine?: string }): Promise<Awaited<ReturnType<typeof buildIncidentReport>> & { __lines: ReturnType<LogHub['snapshot']>['lines'] }> {
  const hub = new LogHub({ tunnelLogPath: path.join(os.tmpdir(), 'lnwjud-acceptance-missing.log') });
  hub.syncWorkLog([
    { id: 'started', timestamp: '2026-08-20T00:00:00.000Z', callId: 'call-1', kind: 'task', toolName: 'search_text', resultCode: 'STARTED', targetSummary: null },
    { id: 'finished', timestamp: '2026-08-20T00:00:01.000Z', callId: 'call-1', kind: options.resultCode === 'SUCCESS' ? 'result' : 'error', toolName: 'search_text', resultCode: options.resultCode, targetSummary: null },
  ], []);
  if (options.tunnelLine !== undefined) hub.feed('tunnel', 'error', options.tunnelLine);
  const lines = hub.snapshot().lines;
  const report = await buildIncidentReport({
    triggeredByUser: options.triggeredByUser,
    appVersion: 'acceptance',
    tunnelClientVersion: null,
    tunnel: { state: 'running', source: 'desktop', message: null, health: { state: options.health, message: null } },
    updaterEvents: [],
    logLines: lines,
  });
  return { ...report, __lines: lines };
}

async function nonEDriveTemporaryDirectory(): Promise<string> {
  if (process.platform !== 'win32') return temporaryDirectory();
  const candidates = [process.env.LOCALAPPDATA, process.env.USERPROFILE, os.homedir()]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  for (const candidate of candidates) {
    const base = path.resolve(candidate);
    if (path.parse(base).root.toUpperCase() === 'E:\\') continue;
    try {
      const root = await mkdtemp(path.join(base, 'lnwjud-session-resilience-'));
      temporaryRoots.push(root);
      return root;
    } catch {
      // Try the next writable non-E location.
    }
  }
  throw new Error('A writable non-E temporary directory is required for this acceptance test');
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-session-resilience-'));
  temporaryRoots.push(root);
  return root;
}

async function currentOwner(): Promise<TunnelLockOwner> {
  const result = await runPowerShell("$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $env:LNWJUD_ACCEPTANCE_PID\"; $p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)", { LNWJUD_ACCEPTANCE_PID: String(process.pid) });
  const startedAt = result.stdout;
  return { pid: process.pid, processStartedAt: startedAt, acquiredAt: new Date().toISOString() };
}

async function runPowerShellFile(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return runPowerShellProcess(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], env);
}

async function runPowerShell(script: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return runPowerShellProcess(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], env);
}

async function runPowerShellProcess(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() }) : reject(new Error(`PowerShell exited ${code ?? 'unknown'}: ${stderr || stdout}`)));
  });
}

async function startPowerShellHolder(profileDirectory: string, releaseSignal: string): Promise<{ child: ChildProcess; pid: number; acquired: boolean }> {
  const script = `
    . '${quote(lockHelper)}'
    $started = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    $claim = Enter-LnwjudTunnelLock -ProfileDir '${quote(profileDirectory)}' -OwnerPid $PID -OwnerStartedAt $started -ProcessStartProvider { param($id) try { $p=Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop; if($null -eq $p){[pscustomobject]@{state='gone'}}else{[pscustomobject]@{state='live';processStartedAt=$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)}} } catch {[pscustomobject]@{state='unverifiable';reason='process_probe_failed'}} }
    Write-Output "READY:\${PID}:$($claim.acquired)"
    [Console]::Out.Flush()
    while(-not (Test-Path -LiteralPath '${quote(releaseSignal)}')) { Start-Sleep -Milliseconds 10 }
    [void](Release-LnwjudTunnelLock -ProfileDir '${quote(profileDirectory)}' -Owner $claim.owner)
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const ready = await new Promise<{ pid: number; acquired: boolean }>((resolve, reject) => {
    let output = ''; let errors = '';
    child.stdout?.on('data', (chunk: string) => { output += chunk; const ready = /READY:(\d+):(True|False)/.exec(output); if (ready?.[1] !== undefined && ready[2] !== undefined) resolve({ pid: Number(ready[1]), acquired: ready[2] === 'True' }); });
    child.stderr?.on('data', (chunk: string) => { errors += chunk; });
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`holder exited early (${code ?? 'unknown'}): ${errors}`)));
  });
  return { child, ...ready };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onExit = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Fixture process did not exit'));
    }, 3_000);
    child.once('exit', onExit);
  });
}

function quote(value: string): string { return value.replace(/'/g, "''"); }

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing documentation section: ${start}`);
  return source.slice(from, to);
}

function findFixedListenerBindings(sources: readonly string[]): string[] {
  const findings: string[] = [];
  for (const source of sources) {
    if (/\.listen\s*\(\s*[1-9]\d*/.test(source)) findings.push('listen');
    if (/https?:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d*/i.test(source)) findings.push('loopback-url');
    if (/listen_addr\s*:\s*["']?(?:127\.0\.0\.1|localhost):[1-9]\d*/i.test(source)) findings.push('health-listen-addr');
  }
  return findings;
}

interface ActivityFixture {
  readonly child: ChildProcess;
  command(command: 'BEGIN' | 'END'): Promise<void>;
  close(): Promise<void>;
}

async function startActivityFixture(root: string, profileDirectory: string): Promise<ActivityFixture> {
  const entryPath = path.join(root, 'activity-fixture.ts');
  const bundlePath = path.join(root, 'activity-fixture.mjs');
  const trackerPath = path.join(repositoryRoot, 'packages', 'mcp-server', 'src', 'activity-tracker.ts').replace(/\\/g, '/');
  const snapshotPath = path.join(repositoryRoot, 'packages', 'mcp-server', 'src', 'shared-activity-snapshot.ts').replace(/\\/g, '/');
  await writeFile(entryPath, `
    import { createInterface } from 'node:readline';
    import { ActivityTracker } from '${trackerPath}';
    import { SharedActivitySnapshotLease, currentSharedActivityOwner } from '${snapshotPath}';
    const profileDirectory = process.argv[2];
    const lease = new SharedActivitySnapshotLease({ profileDirectory, owner: await currentSharedActivityOwner(), heartbeatMs: 25 });
    const tracker = new ActivityTracker(lease);
    await lease.initialize();
    let callId = null;
    console.log('READY');
    const lines = createInterface({ input: process.stdin });
    lines.on('line', async (line) => {
      if (line === 'BEGIN') callId = await tracker.begin('fixture_tool', { workspaceId: 'fixture' });
      if (line === 'END' && callId !== null) { await tracker.end(callId, 'SUCCESS', 1); callId = null; }
      if (line === 'CLOSE') { await lease.close(); console.log('DONE:CLOSE'); process.exit(0); return; }
      console.log('DONE:' + line);
    });
  `, 'utf8');
  await build({ entryPoints: [entryPath], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
  const child = spawn(process.execPath, [bundlePath, profileDirectory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  fixtureProcesses.add(child);
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  let output = '';
  let errors = '';
  child.stdout!.on('data', (chunk: string) => { output += chunk; });
  child.stderr!.on('data', (chunk: string) => { errors += chunk; });
  // Bundling and starting a child process can be noticeably slower on a busy
  // Windows release worker; keep startup bounded without imposing a flaky 5s cap.
  await waitUntil(() => output.includes('READY') || child.exitCode !== null, 15_000);
  if (child.exitCode !== null) throw new Error(`activity fixture exited early: ${errors || output}`);
  return {
    child,
    command: async (command): Promise<void> => {
      const priorDone = (output.match(/DONE:/g) ?? []).length;
      child.stdin!.write(`${command}\n`);
      await waitUntil(() => (output.match(/DONE:/g) ?? []).length > priorDone, 10_000);
    },
    close: async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.stdin!.write('CLOSE\n');
      await waitForExit(child);
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for fixture state');
    await delay(10);
  }
}
