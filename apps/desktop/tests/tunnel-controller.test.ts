import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelController } from '../src/main/tunnel-controller.js';
import { waitForTunnelChildExit } from '../src/main/tunnel-controller.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { acquireTunnelLock, readTunnelLock, type ProcessProbeResult, type TunnelLockAcquisition, type TunnelLockOwner } from '../src/main/tunnel-lock.js';
import { createServer as createHttpServer, type Server } from 'node:http';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TunnelController lifecycle', () => {
  it('holds shutdown completion until a delayed tunnel child exits', async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    let settled = false;
    const waiting = waitForTunnelChildExit(child as never).then((): void => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exitCode = 0;
    child.emit('exit', 0);
    await waiting;
    expect(settled).toBe(true);
  });

  it('keeps ownership until a normally stopping child emits exit', async () => {
    const fixture = await ownedController(() => true);
    const stopping = fixture.controller.stop();
    await Promise.resolve();

    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);

    fixture.child.exitCode = 0;
    fixture.child.emit('exit', 0);
    await stopping;
    expect(await readTunnelLock(fixture.profileDir)).toBeNull();
  });

  it('releases ownership when the child already has an exit code before signaling', async () => {
    const fixture = await ownedController(() => false);
    fixture.child.exitCode = 0;

    await expect(fixture.controller.stopOwned()).resolves.toMatchObject({ state: 'stopped' });
    expect(controllerInternals(fixture.controller).child).toBeNull();
    expect(await readTunnelLock(fixture.profileDir)).toBeNull();
  });

  it('returns promptly and retains ownership when the child rejects the stop signal', async () => {
    const fixture = await ownedController(() => false);

    await expect(fixture.controller.stop()).rejects.toThrow('did not accept stop signal');

    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);
  });

  it('returns promptly and retains ownership when signaling the child throws', async () => {
    const fixture = await ownedController(() => { throw new Error('signal failed'); });

    await expect(fixture.controller.stop()).rejects.toThrow('signal failed');

    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);
  });

  it('uses the injected bound and retains ownership when no child exit is observed', async () => {
    vi.useFakeTimers();
    const fixture = await ownedController(() => true, 20);
    let stoppedWith: unknown;
    const stopping = fixture.controller.stop().catch((error: unknown) => { stoppedWith = error; });

    await vi.advanceTimersByTimeAsync(21);
    const rejectionAtBound = stoppedWith;
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;

    expect(rejectionAtBound).toBeInstanceOf(Error);
    expect((rejectionAtBound as Error).message).toContain('exit was not observed');
    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
  });

  it('escalates only the exact owned child tree after graceful timeout, verifies exit, then releases ownership', async () => {
    const escalated: number[] = [];
    const startedAt = '2026-08-20T00:00:00.000Z';
    const fixture = await ownedController(() => true, 20, {
      terminateOwnedProcessTree: async (pid) => {
        escalated.push(pid);
        fixture.child.exitCode = 1;
        fixture.child.emit('exit', 1);
      },
      inspectOwnedProcess: async () => escalated.length === 0 ? ({ state: 'live', processStartedAt: startedAt }) : ({ state: 'gone' }),
    });
    fixture.child.pid = 7654;

    await expect(fixture.controller.stopOwned()).resolves.toMatchObject({ state: 'stopped' });
    expect(escalated).toEqual([7654]);
    expect(await readTunnelLock(fixture.profileDir)).toBeNull();
  });

  it('retains ownership when the parent exits but a previously verified descendant is still live', async () => {
    const parentStartedAt = '2026-08-20T00:00:00.000Z';
    const descendantStartedAt = '2026-08-20T00:00:01.000Z';
    let escalated = false;
    const fixture = await ownedController(() => true, 20, {
      inspectOwnedProcessTree: async () => [{ pid: 8765, processStartedAt: descendantStartedAt }],
      terminateOwnedProcessTree: async () => {
        escalated = true;
        fixture.child.exitCode = 1;
        fixture.child.emit('exit', 1);
      },
      inspectOwnedProcess: async (pid) => {
        if (pid === 7658) return escalated ? { state: 'gone' } : { state: 'live', processStartedAt: parentStartedAt };
        if (pid === 8765) return { state: 'live', processStartedAt: descendantStartedAt };
        return { state: 'gone' };
      },
    });
    fixture.child.pid = 7658;

    await expect(fixture.controller.stopOwned()).rejects.toThrow('process tree remained live');
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
  });

  it('defers shutdown and retains child plus lock when targeted escalation cannot verify exit', async () => {
    let probes = 0;
    const fixture = await ownedController(() => true, 20, {
      terminateOwnedProcessTree: async () => undefined,
      inspectOwnedProcess: async () => {
        probes += 1;
        return probes === 1 ? { state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' } : { state: 'unverifiable', reason: 'access_denied' };
      },
      escalationTimeoutMs: 20,
    });
    fixture.child.pid = 7655;

    await expect(fixture.controller.stopOwned()).rejects.toThrow('liveness is unverifiable');
    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
  });

  it('never escalates a reused PID that no longer identifies the owned child', async () => {
    const terminateOwnedProcessTree = vi.fn(async () => undefined);
    const fixture = await ownedController(() => true, 20, {
      terminateOwnedProcessTree,
      inspectOwnedProcess: async () => ({ state: 'live', processStartedAt: '2026-08-20T00:01:00.000Z' }),
    });
    fixture.child.pid = 7656;
    await expect(fixture.controller.stopOwned()).rejects.toThrow('identity changed');
    expect(terminateOwnedProcessTree).not.toHaveBeenCalled();
    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
  });

  it('refuses to adopt a child identity first observed only after the graceful timeout', async () => {
    const terminateOwnedProcessTree = vi.fn(async () => undefined);
    const fixture = await ownedController(() => true, 20, {
      terminateOwnedProcessTree,
      inspectOwnedProcess: async () => ({ state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' }),
    });
    fixture.child.pid = 7657;
    controllerInternals(fixture.controller).ownedChildStartedAt = null;

    await expect(fixture.controller.stopOwned()).rejects.toThrow('identity was not recorded');
    expect(terminateOwnedProcessTree).not.toHaveBeenCalled();
    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
  });

  it('releases ownership when secret read or decryption fails after lock acquisition', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-secret-failure-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), 'mcp:\n  command: fixture\n', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const currentOwner: TunnelLockOwner = { pid: 8888, processStartedAt: timestamp(1), acquiredAt: timestamp(2) };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      currentLockOwner: async (): Promise<TunnelLockOwner> => currentOwner,
      inspectLockProcess: async (): Promise<ProcessProbeResult> => ({ state: 'gone' }),
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      decryptSecret: async (): Promise<string> => { throw new Error('secret decrypt failed'); },
    });

    await expect(controller.start()).resolves.toMatchObject({ state: 'error', message: 'secret decrypt failed' });
    expect(await readTunnelLock(profileDir)).toBeNull();
    expect(controllerInternals(controller).tunnelLock).toBeNull();
  });

  it('retains the in-memory handle and filesystem owner when lock release cannot be confirmed, then allows retry', async () => {
    let failRelease = true;
    const fixture = await ownedController(() => true, 20, {}, { beforeReleaseQuarantine: async (): Promise<void> => { if (failRelease) throw new Error('simulated filesystem failure'); } });
    fixture.child.exitCode = 0;

    await expect(fixture.controller.stopOwned()).rejects.toThrow('release could not be confirmed');
    expect(controllerInternals(fixture.controller).tunnelLock).not.toBeNull();
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);

    failRelease = false;
    await expect(fixture.controller.stopOwned()).resolves.toMatchObject({ state: 'stopped' });
    expect(controllerInternals(fixture.controller).tunnelLock).toBeNull();
    expect(await readTunnelLock(fixture.profileDir)).toBeNull();
  });

  it('does not start a second tunnel when the shared lock belongs to another owner', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await (await import('node:fs/promises')).writeFile(path.join(profileDir, 'lnwjud.tunnel.lock'), JSON.stringify({
      version: 1,
      pid: 7123,
      processStartedAt: '2026-08-20T00:00:00.000Z',
      acquiredAt: '2026-08-20T00:00:00.000Z',
    }), 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      inspectLockProcess: async (): Promise<ProcessProbeResult> => ({ state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' }),
      currentLockOwner: async (): Promise<{ pid: number; processStartedAt: string; acquiredAt: string }> => ({ pid: 9999, processStartedAt: '2026-08-20T00:01:00.000Z', acquiredAt: '2026-08-20T00:01:00.000Z' }),
    });

    const status = await controller.start();

    expect(status).toMatchObject({
      state: 'starting',
      source: 'external',
      message: 'Tunnel is owned by PID 7123; tunnel process liveness is not yet confirmed',
    });
  });

  it('keeps verified foreign ownership when the external process probe is unavailable', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await (await import('node:fs/promises')).writeFile(path.join(profileDir, 'lnwjud.tunnel.lock'), JSON.stringify({
      version: 1,
      pid: 7123,
      processStartedAt: '2026-08-20T00:00:00.000Z',
      acquiredAt: '2026-08-20T00:00:00.000Z',
    }), 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => { throw new Error('CIM probe timed out'); },
      inspectLockProcess: async (): Promise<ProcessProbeResult> => ({ state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' }),
      currentLockOwner: async (): Promise<TunnelLockOwner> => ({ pid: 9999, processStartedAt: timestamp(1), acquiredAt: timestamp(2) }),
    });

    await expect(controller.start()).resolves.toMatchObject({
      state: 'starting',
      source: 'external',
      message: 'Tunnel is owned by PID 7123; tunnel process liveness is unverifiable',
    });
  });

  it('fails closed without launching when the external process probe is unavailable and no lock exists', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), 'mcp:\n  command: fixture\n', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const decryptSecret = vi.fn(async (): Promise<string> => 'must-not-run');
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => { throw new Error('CIM probe timed out'); },
      decryptSecret,
    });

    await expect(controller.start()).resolves.toMatchObject({
      state: 'error',
      source: 'desktop',
      message: 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate',
    });
    expect(decryptSecret).not.toHaveBeenCalled();
    expect(await readTunnelLock(profileDir)).toBeNull();
  });

  it('does not acquire ownership or launch a duplicate when another app already has a live tunnel', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), 'mcp:\n  command: fixture\n', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const decryptSecret = vi.fn(async (): Promise<string> => 'not-used');
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => true,
      currentLockOwner: async (): Promise<TunnelLockOwner> => ({ pid: 9999, processStartedAt: timestamp(1), acquiredAt: timestamp(2) }),
      decryptSecret,
    });

    await expect(controller.start()).resolves.toMatchObject({ state: 'running', source: 'external', message: null });
    expect(decryptSecret).not.toHaveBeenCalled();
    expect(await readTunnelLock(profileDir)).toBeNull();
  });

  it('reports an externally running tunnel as health/status evidence', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    let running = false;
    let probeCalls = 0;
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => {
        probeCalls += 1;
        return running;
      },
    });

    running = true;
    const status = await controller.status();

    expect(status).toMatchObject({ state: 'running', source: 'external' });
    expect(probeCalls).toBe(1);
  });

  it('probes only the health endpoint configured in the tunnel profile', async () => {
    const server = await healthServer((_request, response) => { response.writeHead(200); response.end('live'); });
    try {
      const fixture = await healthController({ profile: `health:\n  listen_addr: "127.0.0.1:${server.port}"\n`, log: '' });
      await expect(fixture.controller.incidentHealth()).resolves.toEqual({ state: 'live', message: 'configured tunnel health endpoint is live' });
      expect(server.requests).toBe(1);
    } finally { await server.close(); }
  });

  it('uses the newest advertised runtime health address instead of a stale profile or earlier log address', async () => {
    const first = await healthServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"live"}'); });
    const newest = await healthServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"live"}'); });
    try {
      const fixture = await healthController({
        profile: 'health:\n  listen_addr: "127.0.0.1:1"\n',
        log: `health server listening at 127.0.0.1:${first.port}\nhealth server listening at 127.0.0.1:${newest.port}\n`,
      });
      await expect(fixture.controller.incidentHealth()).resolves.toEqual({ state: 'live', message: 'configured tunnel health endpoint is live' });
      expect(first.requests).toBe(0);
      expect(newest.requests).toBe(1);
    } finally {
      await first.close();
      await newest.close();
    }
  });

  it('requires GET /healthz with status 200 and a live response body', async () => {
    let requestedMethod = '';
    let requestedPath = '';
    const server = await healthServer((request, response) => {
      requestedMethod = request.method ?? '';
      requestedPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"warming"}');
    });
    try {
      const fixture = await healthController({ profile: 'health:\n  listen_addr: "127.0.0.1:0"\n', log: `health server listening at 127.0.0.1:${server.port}\n` });
      await expect(fixture.controller.incidentHealth()).resolves.toMatchObject({ state: 'unhealthy' });
      expect({ requestedMethod, requestedPath }).toEqual({ requestedMethod: 'GET', requestedPath: '/healthz' });
    } finally { await server.close(); }
  });

  it('bounds an unresponsive HTTP health probe and reports it unhealthy', async () => {
    const server = await healthServer(() => { /* intentionally never respond */ });
    try {
      const fixture = await healthController({ profile: 'health:\n  listen_addr: "127.0.0.1:0"\n', log: `health server listening at 127.0.0.1:${server.port}\n`, healthProbeTimeoutMs: 30 });
      const started = Date.now();
      await expect(fixture.controller.incidentHealth()).resolves.toMatchObject({ state: 'unhealthy' });
      expect(Date.now() - started).toBeLessThan(500);
    } finally { await server.close(); }
  });

  it('enforces the health timeout as a total deadline even when response bytes keep arriving', async () => {
    const server = await healthServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const ticker = setInterval(() => response.write(' '), 10);
      const complete = setTimeout(() => { clearInterval(ticker); response.end('{"status":"live"}'); }, 220);
      response.once('close', () => { clearInterval(ticker); clearTimeout(complete); });
    });
    try {
      const fixture = await healthController({ profile: 'health:\n  listen_addr: "127.0.0.1:0"\n', log: `health server listening at 127.0.0.1:${server.port}\n`, healthProbeTimeoutMs: 40 });
      const started = Date.now();
      await expect(fixture.controller.incidentHealth()).resolves.toMatchObject({ state: 'unhealthy' });
      expect(Date.now() - started).toBeLessThan(180);
    } finally { await server.close(); }
  });

  it('reads only a bounded log tail and accepts a live JSON health response from the tail address', async () => {
    const server = await healthServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"live"}'); });
    try {
      const fixture = await healthController({
        profile: 'health:\n  listen_addr: "127.0.0.1:0"\n',
        log: `health server listening at 127.0.0.1:2\n${'x'.repeat(80 * 1024)}\nhealth server listening at 127.0.0.1:${server.port}\n`,
      });
      await expect(fixture.controller.incidentHealth()).resolves.toEqual({ state: 'live', message: 'configured tunnel health endpoint is live' });
      expect(server.requests).toBe(1);
    } finally { await server.close(); }
  });

  it('does not scan beyond the bounded profile metadata prefix for a health address', async () => {
    const server = await healthServer((_request, response) => { response.writeHead(200); response.end('live'); });
    try {
      const fixture = await healthController({
        profile: `${'x'.repeat(80 * 1024)}\nhealth:\n  listen_addr: "127.0.0.1:${server.port}"\n`,
        log: '',
      });
      await expect(fixture.controller.incidentHealth()).resolves.toMatchObject({ state: 'unavailable' });
      expect(server.requests).toBe(0);
    } finally { await server.close(); }
  });

  it('reads tunnel-client version from injected file metadata without executing it', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    const executable = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(executable, 'not executed', 'utf8');
    const controller = new TunnelController({ getClientPath: (): string => executable, setClientPath: (): void => {}, getDataPath: (): string => dataPath, inspectFileVersion: async (): Promise<string> => '1.2.3' });
    await expect(controller.clientVersion()).resolves.toEqual({ value: '1.2.3', reason: null });
  });
});

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  pid?: number;
  kill(): boolean;
}

async function ownedController(kill: () => boolean, stopTimeoutMs = 2_000, shutdownOptions: {
  terminateOwnedProcessTree?: (pid: number) => Promise<void>;
  inspectOwnedProcess?: (pid: number) => Promise<import('@lnwjud/mcp-server').ProcessProbeResult>;
  inspectOwnedProcessTree?: (rootPid: number) => Promise<readonly { readonly pid: number; readonly processStartedAt: string }[]>;
  escalationTimeoutMs?: number;
} = {}, lockHooks?: NonNullable<Parameters<typeof acquireTunnelLock>[0]['hooks']>): Promise<{
  controller: TunnelController;
  child: FakeChild;
  dataPath: string;
  profileDir: string;
  owner: TunnelLockOwner;
}> {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
  temporaryRoots.push(dataPath);
  vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
  const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
  const lockOwner: TunnelLockOwner = {
    pid: 7001,
    processStartedAt: '2026-08-20T00:00:00.000Z',
    acquiredAt: '2026-08-20T00:00:00.000Z',
  };
  const claim = await acquireTunnelLock({
    profileDirectory: profileDir,
    owner: lockOwner,
    inspectProcess: shutdownOptions.inspectOwnedProcess ?? (async () => ({ state: 'live', processStartedAt: lockOwner.processStartedAt })),
    ...(lockHooks === undefined ? {} : { hooks: lockHooks }),
  });
  if (!claim.acquired) throw new Error('test controller could not acquire its lock');
  const controller = new TunnelController({
    getClientPath: (): string | null => null,
    setClientPath: (): void => {},
    getDataPath: (): string => dataPath,
    isExternalTunnelRunning: async (): Promise<boolean> => false,
    stopTimeoutMs,
    inspectOwnedProcessTree: async (): Promise<readonly { readonly pid: number; readonly processStartedAt: string }[]> => [],
    inspectLockProcess: async () => ({ state: 'live', processStartedAt: lockOwner.processStartedAt }),
    inspectProcess: async () => ({ state: 'live', processStartedAt: lockOwner.processStartedAt }),
    ...shutdownOptions,
  });
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.kill = kill;
  const internals = controllerInternals(controller);
  internals.child = child as unknown as ChildProcess;
  internals.ownedChildStartedAt = '2026-08-20T00:00:00.000Z';
  internals.tunnelLock = claim;
  internals.state = 'running';
  return { controller, child, dataPath, profileDir, owner: lockOwner };
}

function timestamp(second: number): string {
  return new Date(Date.UTC(2026, 7, 20, 0, 0, second)).toISOString();
}

async function expectSecondControllerBlocked(dataPath: string, firstOwner: TunnelLockOwner): Promise<void> {
  const second = new TunnelController({
    getClientPath: (): string | null => null,
    setClientPath: (): void => {},
    getDataPath: (): string => dataPath,
    isExternalTunnelRunning: async (): Promise<boolean> => false,
    inspectLockProcess: async (pid): Promise<ProcessProbeResult> => pid === firstOwner.pid ? { state: 'live', processStartedAt: firstOwner.processStartedAt } : { state: 'gone' },
    currentLockOwner: async (): Promise<TunnelLockOwner> => ({
      pid: 7002,
      processStartedAt: '2026-08-20T00:01:00.000Z',
      acquiredAt: '2026-08-20T00:01:00.000Z',
    }),
  });
  await expect(second.start()).resolves.toMatchObject({
    state: 'starting',
    source: 'external',
    message: `Tunnel is owned by PID ${firstOwner.pid}; tunnel process liveness is not yet confirmed`,
  });
}

function controllerInternals(controller: TunnelController): {
  child: ChildProcess | null;
  ownedChildStartedAt: string | null;
  tunnelLock: TunnelLockAcquisition | null;
  state: 'stopped' | 'starting' | 'running' | 'error';
} {
  return controller as unknown as {
    child: ChildProcess | null;
    ownedChildStartedAt: string | null;
    tunnelLock: TunnelLockAcquisition | null;
    state: 'stopped' | 'starting' | 'running' | 'error';
  };
}

async function healthController(options: { profile: string; log: string; healthProbeTimeoutMs?: number }): Promise<{ controller: TunnelController }> {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-health-'));
  temporaryRoots.push(dataPath);
  vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
  const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
  await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'lnwjud.yaml'), options.profile, 'utf8');
  await writeFile(path.join(profileDir, 'lnwjud-tunnel.log'), options.log, 'utf8');
  return { controller: new TunnelController({
    getClientPath: (): string | null => null,
    setClientPath: (): void => {},
    getDataPath: (): string => dataPath,
    ...(options.healthProbeTimeoutMs === undefined ? {} : { healthProbeTimeoutMs: options.healthProbeTimeoutMs }),
  }) };
}

async function healthServer(handler: Parameters<typeof createHttpServer>[0]): Promise<{ server: Server; port: number; readonly requests: number; close(): Promise<void> }> {
  let requests = 0;
  const server = createHttpServer((request, response) => { requests += 1; handler?.(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('health fixture did not bind an ephemeral TCP port');
  return {
    server,
    port: address.port,
    get requests(): number { return requests; },
    close: async (): Promise<void> => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
