import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
const tunnelLockMocks = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));

vi.mock('../src/main/tunnel-lock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/tunnel-lock.js')>(),
  acquireTunnelLock: tunnelLockMocks.acquire,
}));

import { TunnelController } from '../src/main/tunnel-controller.js';
import { readTunnelLock } from '../src/main/tunnel-lock.js';

const temporaryRoots: string[] = [];
const desktopMcpUrl = 'http://127.0.0.1:18765/mcp';

beforeEach(() => {
  childProcessMocks.execFile.mockReset();
  childProcessMocks.spawn.mockReset();
  tunnelLockMocks.acquire.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TunnelController concurrent start', () => {
  it('shares one staggered start across lock acquisition, doctor, decryption, and spawn', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-concurrent-start-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(clientPath, 'fixture', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), 'control_plane:\n  tunnel_id: "tunnel_fixture123"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nmcp:\n  commands:\n    - channel: main\n      command: fixture\n', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');

    let releaseProbe!: () => void;
    let markProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => { markProbeEntered = resolve; });
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const isExternalTunnelRunning = vi.fn(async (): Promise<boolean> => {
      markProbeEntered();
      await probeGate;
      return false;
    });
    const decryptSecret = vi.fn(async (): Promise<string> => 'runtime-key');
    const owner = {
      pid: 9_001,
      processStartedAt: '2026-08-21T00:00:00.000Z',
      acquiredAt: '2026-08-21T00:00:01.000Z',
    };
    const releaseLock = vi.fn(async (): Promise<boolean> => true);
    tunnelLockMocks.acquire.mockResolvedValue({ acquired: true, owner, release: releaseLock });
    childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''));
      return undefined;
    });
    childProcessMocks.spawn.mockImplementation(() => fakeTunnelChild());
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => desktopMcpUrl,
      isExternalTunnelRunning,
      decryptSecret,
    });

    const first = controller.start();
    await probeEntered;
    const second = controller.start();
    await Promise.resolve();
    releaseProbe();

    try {
      const statuses = await Promise.all([first, second]);
      expect(statuses).toEqual([
        expect.objectContaining({ state: 'running', source: 'desktop' }),
        expect.objectContaining({ state: 'running', source: 'desktop' }),
      ]);
      expect(isExternalTunnelRunning).toHaveBeenCalledTimes(1);
      expect(tunnelLockMocks.acquire).toHaveBeenCalledTimes(1);
      expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
      expect(childProcessMocks.execFile).toHaveBeenCalledWith(
        clientPath,
        expect.arrayContaining(['doctor']),
        expect.objectContaining({ timeout: 60_000 }),
        expect.any(Function),
      );
      expect(decryptSecret).toHaveBeenCalledTimes(1);
      expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stopOwned();
    }
  });

  it('cancels a start blocked in doctor before stop releases ownership', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-start-stop-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    const profileDir = path.join(dataPath, 'appdata', 'tunnel-client');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    const lockPath = path.join(profileDir, 'lnwjud.tunnel.lock');
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(clientPath, 'fixture', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), 'control_plane:\n  tunnel_id: "tunnel_fixture456"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nmcp:\n  commands:\n    - channel: main\n      command: fixture\n', 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');

    const owner = {
      pid: 9_002,
      processStartedAt: '2026-08-21T00:01:00.000Z',
      acquiredAt: '2026-08-21T00:01:01.000Z',
    };
    await writeFile(lockPath, JSON.stringify({ version: 1, ...owner }), 'utf8');
    const releaseLock = vi.fn(async (): Promise<boolean> => {
      await rm(lockPath, { force: true });
      return true;
    });
    tunnelLockMocks.acquire.mockResolvedValue({ acquired: true, owner, release: releaseLock });
    let markDoctorEntered!: () => void;
    let completeDoctor!: () => void;
    const doctorEntered = new Promise<void>((resolve) => { markDoctorEntered = resolve; });
    childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
      const commandArgs = Array.isArray(args[1]) ? args[1] : [];
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Tunnel-client callback was not provided');
      if (commandArgs.includes('doctor')) {
        completeDoctor = (): void => callback(null, '', '');
        markDoctorEntered();
      } else {
        queueMicrotask(() => callback(new Error('unsupported fixture command'), '', ''));
      }
      return undefined;
    });
    childProcessMocks.spawn.mockImplementation(() => fakeTunnelChild());
    const decryptSecret = vi.fn(async (): Promise<string> => 'runtime-key');
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => desktopMcpUrl,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      probeHealthEndpoint: async (): Promise<boolean> => false,
      decryptSecret,
    });

    const starting = controller.start();
    await doctorEntered;
    const stopping = controller.stop();
    await Promise.resolve();
    completeDoctor();

    try {
      const [startStatus, stopStatus] = await Promise.all([starting, stopping]);
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
      expect(startStatus).toMatchObject({ state: 'stopped', source: 'desktop' });
      expect(stopStatus).toMatchObject({ state: 'stopped', source: 'desktop' });
      expect(tunnelLockMocks.acquire).toHaveBeenCalledTimes(1);
      const doctorCalls = childProcessMocks.execFile.mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes('doctor'));
      expect(doctorCalls).toHaveLength(1);
      expect(decryptSecret).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      expect(await readTunnelLock(profileDir)).toBeNull();
    } finally {
      await controller.stopOwned();
    }
  });
});

function fakeTunnelChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: vi.fn((): boolean => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return true;
    }),
  });
  return child as unknown as ChildProcess;
}
