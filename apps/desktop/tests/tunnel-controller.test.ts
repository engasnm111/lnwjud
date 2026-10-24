import { isolateTunnelProfile } from './tunnel-profile-fixture.js';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TunnelController, resolveTunnelProfileDirectory } from '../src/main/tunnel-controller.js';
import { waitForTunnelChildExit } from '../src/main/tunnel-controller.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { acquireTunnelLock, readTunnelLock, type ProcessProbeResult, type TunnelLockAcquisition, type TunnelLockOwner } from '../src/main/tunnel-lock.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { TunnelRuntimeReconcilerAdapter } from '../src/main/tunnel-runtime-reconciler.js';
import type { TunnelRuntimeCapabilities } from '../src/main/tunnel-runtime-state.js';
import { TunnelRuntimeAdapter, type TunnelRuntimeExecResult } from '../src/main/tunnel-runtime-adapter.js';

const temporaryRoots: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-controller-profile-'));
  temporaryRoots.push(root);
  isolateTunnelProfile(root);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TunnelController lifecycle', () => {
  it('replaces a redirected secret path without touching the link target', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-secret-atomic-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('XDG_DATA_HOME', dataPath);
    const controller = new TunnelController({
      platform: 'linux',
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      encryptSecret: async (value): Promise<string> => `safe:v1:${value}`,
    });
    const secretPath = controller.secretPath();
    const outsidePath = path.join(dataPath, 'outside-secret');
    await (await import('node:fs/promises')).mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(outsidePath, 'outside-value', 'utf8');
    try {
      await symlink(outsidePath, secretPath, 'file');
    } catch {
      // Windows CI may not grant symlink creation to the test user.
      return;
    }

    await expect(controller.hasApiKey()).resolves.toBe(false);
    await controller.saveApiKey('runtime-value');
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('outside-value');
    await expect(readFile(secretPath, 'utf8')).resolves.toBe('safe:v1:runtime-value');
    await expect(stat(secretPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

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

  it('kills an owned profile child before reconciling a recorded owner with no native runtime support', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-profile-child-stop-order-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    let ownerPath = ownerClient;
    let externalLive = true;
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.pid = 7124;
    child.kill = vi.fn(() => {
      externalLive = false;
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    });
    const controller = new TunnelController({
      getClientPath: (): string => ownerClient,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      isExternalTunnelRunning: async (): Promise<boolean> => externalLive,
      inspectOwnedProcess: async (): Promise<ProcessProbeResult> => child.exitCode === null
        ? { state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' } : { state: 'gone' },
      inspectOwnedProcessTree: async (): Promise<readonly { readonly pid: number; readonly processStartedAt: string }[]> => [],
      terminateOwnedProcessTree: async (): Promise<void> => { child.kill(); },
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => ({
          clientVersion: 'fixture', nativeRuntimes: false, managedConnect: false, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        })),
        status: vi.fn(async () => ({
          exists: true, running: false, healthy: false, ready: false, pollHealthy: false,
          tunnelId: 'tunnel_fixture012345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
        })),
        connect: vi.fn(),
        stop: vi.fn(),
      }),
    });
    const internals = controllerInternals(controller);
    internals.child = child as unknown as ChildProcess;
    internals.ownedChildStartedAt = '2026-08-20T00:00:00.000Z';
    internals.runtimeMode = 'profile-child';
    internals.state = 'running';

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(ownerPath).toBe('');
  });

  it('retains the old client when an exited profile child leaves external runtime liveness unverified', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-profile-child-survivor-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const nextClient = path.join(dataPath, 'next-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(nextClient, 'next', 'utf8');
    let configured = ownerClient;
    let ownerPath = ownerClient;
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.pid = 7125;
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    });
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      platform: 'win32',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => ({
          clientVersion: 'fixture', nativeRuntimes: false, managedConnect: false, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        })),
        status: vi.fn(async () => ({
          exists: true, running: false, healthy: false, ready: false, pollHealthy: false,
          tunnelId: 'tunnel_fixture012345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
        })),
        connect: vi.fn(),
        stop: vi.fn(),
      }),
    });
    const internals = controllerInternals(controller);
    internals.child = child as unknown as ChildProcess;
    internals.ownedChildStartedAt = '2026-08-20T00:00:00.000Z';
    internals.runtimeMode = 'profile-child';
    internals.state = 'running';

    await expect(controller.replaceClientPath(nextClient)).rejects.toThrow('Could not positively verify');
    expect(configured).toBe(ownerClient);
    expect(ownerPath).toBe(ownerClient);
  });

  it('does not let a pending automatic start override an explicit operator stop', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-auto-stop-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    await expect(controller.startAutomatically()).resolves.toMatchObject({ state: 'stopped' });
  });

  it('keeps an explicit operator stop stopped when external liveness cannot be verified, but still fails closed on the next explicit start', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-stop-unverifiable-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    let desiredState: 'running' | 'stopped' | null = null;
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getRuntimeDesiredState: (): 'running' | 'stopped' | null => desiredState,
      setRuntimeDesiredState: (value: 'running' | 'stopped'): void => { desiredState = value; },
      isExternalTunnelRunning: async (): Promise<boolean> => { throw new Error('probe unavailable'); },
    });

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped', message: null });
    await expect(controller.status()).resolves.toMatchObject({ state: 'stopped', message: null });
    expect(desiredState).toBe('stopped');

    await expect(controller.start()).resolves.toMatchObject({
      state: 'error',
      message: 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate',
    });
    expect(desiredState).toBe('running');
  });

  it('persists explicit operator Stop intent so a new controller stays stopped after app restart', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-durable-stop-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    let desiredState: 'running' | 'stopped' | null = null;
    const options = {
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getRuntimeDesiredState: (): 'running' | 'stopped' | null => desiredState,
      setRuntimeDesiredState: (value: 'running' | 'stopped'): void => { desiredState = value; },
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    };

    const first = new TunnelController(options);
    await expect(first.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(desiredState).toBe('stopped');

    const restarted = new TunnelController(options);
    await expect(restarted.startAutomatically()).resolves.toMatchObject({ state: 'stopped' });
    expect(desiredState).toBe('stopped');
  });

  it('enforces a durable stopped desired state on restart by stopping a surviving recorded owner runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-durable-stop-survivor-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    let ownerPath = ownerClient;
    let stopped = false;
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const controller = new TunnelController({
      getClientPath: (): string => ownerClient,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeDesiredState: (): 'stopped' => 'stopped',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      isExternalTunnelRunning: async (): Promise<boolean> => !stopped,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => capabilities),
        status: vi.fn(async () => ({
          exists: true, running: !stopped, healthy: !stopped, ready: !stopped, pollHealthy: !stopped,
          tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: stopped ? null : 4321, uiUrl: null, message: null,
        })),
        connect: vi.fn(),
        stop: vi.fn(async () => {
          stopped = true;
          return {
            exists: true, running: false, healthy: false, ready: false, pollHealthy: null,
            tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: null, uiUrl: null, message: null,
          };
        }),
      }),
    });

    await expect(controller.startAutomatically()).resolves.toMatchObject({ state: 'stopped' });
    expect(stopped).toBe(true);
    expect(ownerPath).toBe('');
  });

  it('keeps an explicit missing custom client authoritative instead of silently falling back to bundled', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-custom-authority-'));
    temporaryRoots.push(dataPath);
    const custom = path.join(dataPath, 'missing-custom.exe');
    const bundled = path.join(dataPath, 'bundled-tunnel-client.exe');
    await writeFile(bundled, 'bundled', 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string => custom,
      getBundledClientPath: (): string => bundled,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
    });

    expect(controller.resolveClientPath()).toBe(custom);
  });

  it('stops a surviving persistent runtime through its recorded owner executable, not the newly selected client', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-owner-client-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const newlySelectedClient = path.join(dataPath, 'new-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(newlySelectedClient, 'new', 'utf8');
    const adapterPaths: string[] = [];
    let stopped = false;
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const controller = new TunnelController({
      getClientPath: (): string => newlySelectedClient,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerClient,
      setRuntimeOwnerPath: (): void => undefined,
      isExternalTunnelRunning: async (): Promise<boolean> => !stopped,
      createRuntimeAdapter: (options): TunnelRuntimeReconcilerAdapter => {
        adapterPaths.push(options.clientPath);
        return {
          runtimeAlias: (): string => 'lnwjud',
          capabilities: vi.fn(async () => capabilities),
          status: vi.fn(async () => ({
            exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
            tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: 4321, uiUrl: null, message: null,
          })),
          connect: vi.fn(),
          stop: vi.fn(async () => {
            stopped = true;
            return {
            exists: true, running: false, healthy: false, ready: false, pollHealthy: null,
            tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: null, uiUrl: null, message: null,
            };
          }),
        };
      },
    });

    await expect(controller.stopPersistedNativeRuntimeIfOwned()).resolves.toBe(true);
    expect(adapterPaths).toEqual([ownerClient]);
  });

  it('commits a client-path switch only after the active owner runtime is confirmed stopped', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-client-switch-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const nextClient = path.join(dataPath, 'next-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(nextClient, 'next', 'utf8');
    let configured = ownerClient;
    let ownerPath = ownerClient;
    let stopped = false;
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      setClientPath: (value): void => {
        expect(stopped).toBe(true);
        configured = value;
      },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      getRuntimeDesiredState: (): 'running' => 'running',
      isExternalTunnelRunning: async (): Promise<boolean> => !stopped,
      createRuntimeAdapter: (options): TunnelRuntimeReconcilerAdapter => {
        expect(options.clientPath).toBe(ownerClient);
        return {
          runtimeAlias: (): string => 'lnwjud',
          capabilities: vi.fn(async () => capabilities),
          status: vi.fn(async () => ({
            exists: true, running: !stopped, healthy: !stopped, ready: !stopped, pollHealthy: !stopped,
            tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: stopped ? null : 4321, uiUrl: null, message: null,
          })),
          connect: vi.fn(),
          stop: vi.fn(async () => {
            stopped = true;
            return {
              exists: true, running: false, healthy: false, ready: false, pollHealthy: null,
              tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: null, uiUrl: null, message: null,
            };
          }),
        };
      },
    });

    await expect(controller.replaceClientPath(nextClient)).resolves.toBe(nextClient);
    expect(stopped).toBe(true);
    expect(configured).toBe(nextClient);
    expect(ownerPath).toBe('');
  });

  it('keeps the old client selection and owner when persistent-runtime stop verification fails', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-client-switch-fail-'));
    temporaryRoots.push(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const nextClient = path.join(dataPath, 'next-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(nextClient, 'next', 'utf8');
    let configured = ownerClient;
    let ownerPath = ownerClient;
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      getRuntimeDesiredState: (): 'running' => 'running',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => capabilities),
        status: vi.fn(async () => { throw new Error('owner status unavailable'); }),
        connect: vi.fn(),
        stop: vi.fn(),
      }),
    });

    await expect(controller.replaceClientPath(nextClient)).rejects.toThrow('Could not verify the recorded Persistent Tunnel Runtime owner');
    expect(configured).toBe(ownerClient);
    expect(ownerPath).toBe(ownerClient);
  });

  it.each([
    {
      caseName: 'the recorded owner lacks native-runtime capability',
      nativeRuntimes: false,
      runtimeStatus: {
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: 4321, uiUrl: null, message: null,
      },
    },
    {
      caseName: 'the recorded owner reports that the alias is absent',
      nativeRuntimes: true,
      runtimeStatus: {
        exists: false, running: false, healthy: null, ready: null, pollHealthy: null,
        tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null, message: 'alias lnwjud not found',
      },
    },
    {
      caseName: 'the recorded owner reports a stopped alias while external liveness remains live',
      nativeRuntimes: true,
      runtimeStatus: {
        exists: true, running: false, healthy: false, ready: false, pollHealthy: false,
        tunnelId: 'tunnel_fixture012345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
      },
    },
  ])('retains the old client and owner when $caseName', async ({ nativeRuntimes, runtimeStatus }) => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-client-switch-unverified-'));
    temporaryRoots.push(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const nextClient = path.join(dataPath, 'next-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(nextClient, 'next', 'utf8');
    let configured = ownerClient;
    let ownerPath = ownerClient;
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      getRuntimeDesiredState: (): 'running' => 'running',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => ({
          clientVersion: 'fixture', nativeRuntimes, managedConnect: nativeRuntimes, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        })),
        status: vi.fn(async () => runtimeStatus),
        connect: vi.fn(),
        stop: vi.fn(),
      }),
    });

    await expect(controller.replaceClientPath(nextClient)).rejects.toThrow('Could not positively verify the recorded Persistent Tunnel Runtime stopped');
    expect(configured).toBe(ownerClient);
    expect(ownerPath).toBe(ownerClient);
  });

  it('clears a stale recorded owner and commits the client switch when alias absence and external liveness both prove it is gone', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-client-switch-gone-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const ownerClient = path.join(dataPath, 'owner-tunnel-client.exe');
    const nextClient = path.join(dataPath, 'next-tunnel-client.exe');
    await writeFile(ownerClient, 'owner', 'utf8');
    await writeFile(nextClient, 'next', 'utf8');
    let configured = ownerClient;
    let ownerPath = ownerClient;
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      getRuntimeDesiredState: (): 'stopped' => 'stopped',
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => ({
          clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        })),
        status: vi.fn(async () => ({
          exists: false, running: false, healthy: null, ready: null, pollHealthy: null,
          tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null, message: 'alias lnwjud not found',
        })),
        connect: vi.fn(),
        stop: vi.fn(),
      }),
    });

    await expect(controller.replaceClientPath(nextClient)).resolves.toBe(nextClient);
    expect(configured).toBe(nextClient);
    expect(ownerPath).toBe('');
  });

  it('clears a missing portable runtime owner before switching back to the bundled client when no tunnel is running', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-portable-owner-gone-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const missingOwnerClient = path.join(dataPath, 'removed-portable', 'resources', 'tunnel-client', 'tunnel-client.exe');
    let configured = missingOwnerClient;
    let ownerPath = missingOwnerClient;
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      getBundledClientPath: (): string => path.join(dataPath, 'bundled-tunnel-client.exe'),
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      getRuntimeDesiredState: (): 'stopped' => 'stopped',
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => {
        throw new Error('missing portable owner must never be executed');
      },
    });

    await expect(controller.replaceClientPath('')).resolves.toBe('');
    expect(configured).toBe('');
    expect(ownerPath).toBe('');
  });

  it('re-adopts a surviving native runtime after status first observes it as external', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-restart-adopt-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_fixture012345' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:17654/mcp' }] },
    }, null, 2), 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const status = vi.fn(async () => ({
      exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
      tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:17654/mcp', pid: 4321, uiUrl: null, message: null,
    }));
    const connect = vi.fn(async () => ({
      exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
      tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
    }));
    const stop = vi.fn(async () => undefined);
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status,
      connect,
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      getTunnelId: (): string => 'tunnel_fixture012345',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      decryptSecret: async (): Promise<string> => 'runtime-key',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
    });

    await expect(controller.status()).resolves.toMatchObject({
      state: 'running', source: 'external', persistent: { mode: 'external' },
    });
    await expect(controller.startAutomatically()).resolves.toMatchObject({
      state: 'running', source: 'desktop', persistent: { mode: 'native-managed', localMcpUrl: 'http://127.0.0.1:18765/mcp' },
    });
    expect(connect).toHaveBeenCalledWith({
      tunnelId: 'tunnel_fixture012345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!);
  });

  it('manual Start refuses retire-before-ready replacement when the running runtime has a different Tunnel ID', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-manual-reconfigure-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_new012345678' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }, null, 2), 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const oldRunning = {
      exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
      tunnelId: 'tunnel_old012345678', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
    } as const;
    const stop = vi.fn();
    const connect = vi.fn();
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => oldRunning),
      connect: connect as never,
      stop: stop as never,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      getTunnelId: (): string => 'tunnel_new012345678',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      decryptSecret: async (): Promise<string> => 'runtime-key',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
    });

    await expect(controller.start()).resolves.toMatchObject({
      state: 'error',
      message: expect.stringContaining('ready-before-retire'),
    });
    expect(stop).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('automatic reconnect never replaces a running persistent runtime with a different Tunnel ID', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-auto-mismatch-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_new012345678' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }, null, 2), 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const stop = vi.fn();
    const connect = vi.fn();
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_old012345678', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
      })),
      connect,
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      getTunnelId: (): string => 'tunnel_new012345678',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      decryptSecret: async (): Promise<string> => 'runtime-key',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
    });

    await expect(controller.startAutomatically()).resolves.toMatchObject({
      state: 'error',
      message: expect.stringContaining('Press Start Tunnel'),
      persistent: { lastErrorCode: 'TUNNEL_ID_MISMATCH' },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('manual Start restarts the same persistent Tunnel ID after credentials change', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-key-restart-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_fixture012345' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }, null, 2), 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture', 'utf8');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const running = {
      exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
      tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
    } as const;
    const stopped = { ...running, running: false, healthy: false, ready: false, pollHealthy: false, pid: null };
    const status = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(stopped);
    const stop = vi.fn(async () => stopped);
    const connect = vi.fn(async () => running);
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status,
      connect,
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      getTunnelId: (): string => 'tunnel_fixture012345',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (options): TunnelRuntimeReconcilerAdapter => {
        expect(options.environment.MCP_CONNECTION_MAX_TTL).toBe('168h0m0s');
        expect(options.environment.MCP_MAX_CONCURRENT_REQUESTS).toBe('32');
        return adapter;
      },
      decryptSecret: async (): Promise<string> => 'new-runtime-key',
      isExternalTunnelRunning: async (): Promise<boolean> => true,
    });
    controllerInternals(controller).runtimeConfigurationDirty = true;

    await expect(controller.start()).resolves.toMatchObject({ state: 'running', source: 'desktop' });
    expect(stop).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(controllerInternals(controller).runtimeConfigurationDirty).toBe(false);
  });

  it('invalidates a cached external-live probe when the operator explicitly stops the tunnel', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-stop-cache-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    let probes = 0;
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => { probes += 1; return false; },
    });
    const internals = controllerInternals(controller);
    internals.state = 'running';
    internals.lastExternalProbe = 'live';
    internals.externalProbeAt = Date.now();

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(probes).toBe(1);
  });

  it('enriches Doctor status from a live external runtime alias without taking ownership', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-doctor-observe-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_fixture012345' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }, null, 2), 'utf8');
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => ({
        clientVersion: '0.0.13+fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
        pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
      })),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: null,
        tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('connect should not be called'); }),
      stop: vi.fn(async () => { throw new Error('stop should not be called'); }),
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => true,
    });

    await expect(controller.diagnosticStatus()).resolves.toMatchObject({
      state: 'running',
      source: 'external',
      persistent: {
        mode: 'external',
        runtimeAliasActive: true,
        healthy: true,
        ready: true,
        pollHealthy: null,
        localMcpUrl: 'http://127.0.0.1:18765/mcp',
      },
    });
    expect(adapter.status).toHaveBeenCalledTimes(1);
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('stops the persisted native lnwjud alias after Desktop restart when the stored Tunnel ID still matches', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-persisted-stop-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const stop = vi.fn(async () => ({
      exists: true, running: false, healthy: null, ready: null, pollHealthy: null,
      tunnelId: 'tunnel_fixture012345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
    }));
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_fixture012345', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 4321, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('connect should not be called'); }),
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string | null => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string | null => 'tunnel_fixture012345',
      setTunnelId: (): void => undefined,
      getRuntimeOwnerPath: (): string => clientPath,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('retires a verified orphan when Stop finds no official runtime alias', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-orphan-alias-stop-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    let ownerPath = clientPath;
    let externalLive = true;
    const missing = {
      exists: false, running: false, healthy: null, ready: null, pollHealthy: null,
      tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null, message: 'alias lnwjud not found',
    };
    const ensureSingleProcess = vi.fn(async () => { externalLive = false; });
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_fixture012345',
      getRuntimeOwnerPath: (): string => ownerPath,
      setRuntimeOwnerPath: (value): void => { ownerPath = value; },
      isExternalTunnelRunning: async (): Promise<boolean> => externalLive,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: vi.fn(async () => ({
          clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        })),
        status: vi.fn(async () => missing),
        connect: vi.fn(),
        stop: vi.fn(),
        ensureSingleProcess,
      }),
    });

    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(ensureSingleProcess).toHaveBeenCalledExactlyOnceWith('tunnel_fixture012345', missing);
    expect(ownerPath).toBe('');
  });

  it('refuses to stop a running native alias after saved Tunnel ID was deleted (ownership unknown)', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-orphan-stop-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const stop = vi.fn(async () => ({
      exists: true, running: false, healthy: null, ready: null, pollHealthy: null,
      tunnelId: 'tunnel_orphan012345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
    }));
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_orphan012345', mcpServerUrl: 'http://127.0.0.1:18765/mcp', pid: 6543, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('connect should not be called'); }),
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string | null => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string | null => null,
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });

    await expect(controller.stop()).rejects.toThrow('ownership is not proven');
    expect(stop).not.toHaveBeenCalled();
  });

  it('reconciles a stopped stale alias while preserving the new Tunnel ID and never stopping the old process', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-stale-alias-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const retireStoppedAlias = vi.fn(async (): Promise<void> => undefined);
    const stop = vi.fn();
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        processStateEvidence: 'stopped', exists: true, running: false, healthy: null, ready: null, pollHealthy: null,
        tunnelId: 'tunnel_oldalias12345', mcpServerUrl: null, pid: null, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('connect should not be called'); }),
      stop,
      retireStoppedAlias,
    };
    let owner = clientPath;
    const controller = new TunnelController({
      getClientPath: (): string | null => clientPath, setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath, getTunnelId: (): string => 'tunnel_newalias12345',
      setTunnelId: (): void => undefined,
      getRuntimeOwnerPath: (): string => owner,
      setRuntimeOwnerPath: (value: string): void => { owner = value; },
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(retireStoppedAlias).toHaveBeenCalledExactlyOnceWith('tunnel_oldalias12345');
    expect(stop).not.toHaveBeenCalled();
    expect(owner).toBe('');
  });

  it.each([
    { operation: 'stop', evidence: 'verified', failedStart: false },
    { operation: 'prepareFactoryReset', evidence: 'verified', failedStart: false },
    { operation: 'stop', evidence: 'verified', failedStart: true },
    { operation: 'prepareFactoryReset', evidence: 'verified', failedStart: true },
    { operation: 'stop', evidence: 'foreign' },
    { operation: 'prepareFactoryReset', evidence: 'foreign' },
    { operation: 'stop', evidence: 'foreign', failedStart: true },
    { operation: 'prepareFactoryReset', evidence: 'foreign', failedStart: true },
    { operation: 'stop', evidence: 'unverifiable' },
    { operation: 'prepareFactoryReset', evidence: 'unverifiable' },
    { operation: 'stop', evidence: 'unverifiable', failedStart: true },
    { operation: 'prepareFactoryReset', evidence: 'unverifiable', failedStart: true },
  ] as const)('handles $operation with $evidence configured runtime evidence and a stopped old alias with a historical PID ($failedStart failed start)', async (scenario) => {
    const { operation, evidence } = scenario;
    const failedStart = 'failedStart' in scenario && scenario.failedStart;
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-historical-alias-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const profileDir = resolveTunnelProfileDirectory();
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_newalias12345' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }));
    await writeFile(path.join(profileDir, 'lnwjud.runtime.secret'), 'encrypted-fixture');
    let exists = true;
    let externalLive = true;
    const historicalStatus = {
      processStateEvidence: 'stopped' as const, exists: true, running: false, healthy: false, ready: false, pollHealthy: null,
      tunnelId: 'tunnel_oldalias12345', mcpServerUrl: null, pid: 9832, uiUrl: null, message: null,
    };
    const ensureSingleProcess = vi.fn(async (): Promise<void> => {
      if (evidence === 'foreign' && (!failedStart || ensureSingleProcess.mock.calls.length > 1)) {
        throw new Error('Fixture runtime identity mismatch');
      }
      externalLive = false;
    });
    const retireStoppedAlias = vi.fn(async (): Promise<void> => {
      expect(externalLive).toBe(false);
      exists = false;
    });
    const stop = vi.fn(async () => { throw new Error('Native Tunnel ID cannot be verified for this alias'); });
    const connect = vi.fn(async () => { throw new Error('Fixture connect failure'); });
    const controller = new TunnelController({
      getClientPath: (): string => clientPath, setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      decryptSecret: async (): Promise<string> => 'fixture-runtime-key',
      getTunnelId: (): string => 'tunnel_newalias12345', setTunnelId: vi.fn(),
      getRuntimeOwnerPath: (): string => clientPath,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => ({
        runtimeAlias: (): string => 'lnwjud',
        capabilities: async () => ({
          clientVersion: '0.0.16', nativeRuntimes: true, managedConnect: true, healthProbe: true,
          pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
        }),
        status: async () => exists ? historicalStatus : { ...historicalStatus, exists: false, pid: null, tunnelId: null },
        connect, stop, ensureSingleProcess, retireStoppedAlias,
      }),
      isExternalTunnelRunning: async (): Promise<boolean> => {
        if (evidence === 'unverifiable') throw new Error('Fixture process inventory unavailable');
        return externalLive;
      },
    });
    if (failedStart) {
      await expect(controller.start()).resolves.toMatchObject({ state: 'starting', message: 'Fixture connect failure' });
      expect(connect).toHaveBeenCalledOnce();
    }
    if (evidence === 'verified') {
      await controller[operation]();
      expect(retireStoppedAlias).toHaveBeenCalledExactlyOnceWith('tunnel_oldalias12345');
    } else {
      await expect(controller[operation]()).rejects.toThrow(evidence === 'foreign' ? 'identity mismatch' : 'safe cleanup could not be verified');
      expect(retireStoppedAlias).not.toHaveBeenCalled();
    }
    expect(ensureSingleProcess).toHaveBeenCalledWith('tunnel_newalias12345', historicalStatus);
    if (!failedStart) expect(stop).not.toHaveBeenCalled();
    await controller.shutdownForDesktopExit();
  });

  it.each(['recover', 'conflict'] as const)('handles retained-supervisor Start after first-map retirement interruption (%s)', async (recovery) => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-retained-supervisor-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDirectory = resolveTunnelProfileDirectory();
    const stateRoot = path.join(dataPath, 'state');
    await (await import('node:fs/promises')).mkdir(profileDirectory, { recursive: true });
    await (await import('node:fs/promises')).mkdir(stateRoot);
    const clientPath = path.join(dataPath, 'fixture.exe');
    await writeFile(clientPath, 'fixture');
    await writeFile(path.join(profileDirectory, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_newalias12345' },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }));
    await writeFile(path.join(profileDirectory, 'lnwjud.runtime.secret'), 'encrypted-fixture');
    const aliasesFile = path.join(stateRoot, 'aliases.yaml');
    const processesFile = path.join(stateRoot, 'processes.yaml');
    const journalFile = path.join(stateRoot, '.lnwjud-stale-alias.json');
    const oldProcesses = JSON.stringify({ lnwjud: { tunnel_id: 'tunnel_oldalias12345', pid: 9832 } });
    await writeFile(aliasesFile, JSON.stringify({ lnwjud: { tunnel_id: 'tunnel_oldalias12345' } }));
    await writeFile(processesFile, oldProcesses);
    let aliasExists = true;
    let running = false;
    let unfinishedAtConnect = false;
    let connectCount = 0;
    const processGuard = vi.fn(async (): Promise<void> => undefined);
    const controller = new TunnelController({
      getClientPath: (): string => clientPath, setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_newalias12345', setTunnelId: (): void => undefined,
      getRuntimeOwnerPath: (): string => clientPath,
      getMcpServerUrl: (): string => 'http://127.0.0.1:18765/mcp',
      decryptSecret: async (): Promise<string> => 'fixture-runtime-key',
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      createRuntimeAdapter: (options): TunnelRuntimeReconcilerAdapter => new TunnelRuntimeAdapter({
        ...options, environment: { ...options.environment, TUNNEL_CLIENT_STATE_DIR: stateRoot }, processGuard,
        clearStaleTunnelAlias: async (request): Promise<void> => {
          if (request.recoveryOnly) {
            if (recovery === 'conflict') throw new Error('TUNNEL_STALE_SNAPSHOT_CHANGED');
            expect(await readFile(aliasesFile, 'utf8')).toBe('{}');
            expect(await readFile(processesFile, 'utf8')).toBe(oldProcesses);
            await writeFile(processesFile, '{}');
            await rm(journalFile);
            return;
          }
          aliasExists = false;
          await writeFile(aliasesFile, '{}');
          await writeFile(journalFile, JSON.stringify({ firstMapPublished: true }));
          throw new Error('Fixture retirement interrupted after aliases publication');
        },
        execute: async (_exe, args): Promise<TunnelRuntimeExecResult> => {
          const command = args.join(' ');
          if (command === '--version') return { stdout: '0.0.16', stderr: '' };
          if (command === 'runtimes --help') return { stdout: 'connect status stop', stderr: '' };
          if (command === 'runtimes connect --help') return { stdout: '--alias --tunnel-id --runtime-api-key --mcp-server-url', stderr: '' };
          if (command === 'health --help') return { stdout: '/healthz /readyz --require-control-plane-poll', stderr: '' };
          if (args[0] === 'runtimes' && args[1] === 'connect') {
            connectCount += 1;
            if (connectCount === 1) throw new Error('Fixture first connect failed');
            unfinishedAtConnect = await stat(journalFile).then(() => true, () => false);
            aliasExists = true;
            running = true;
            await writeFile(aliasesFile, JSON.stringify({ lnwjud: { tunnel_id: 'tunnel_newalias12345' } }));
            await writeFile(processesFile, JSON.stringify({ lnwjud: { tunnel_id: 'tunnel_newalias12345', pid: 4321 } }));
          } else if (command !== 'runtimes status lnwjud --json') throw new Error('Unexpected mutating CLI command');
          if (!aliasExists) throw new Error('alias lnwjud is not known');
          return {
            stdout: JSON.stringify({
              tunnel_id: running ? 'tunnel_newalias12345' : 'tunnel_oldalias12345',
              process_running: running, pid: running ? 4321 : 9832,
              healthy: running, ready: running, poll_healthy: running,
              mcp_server_url: 'http://127.0.0.1:18765/mcp',
            }), stderr: '',
          };
        },
      }),
    });
    try {
      await expect(controller.start()).resolves.toMatchObject({ state: 'starting', message: 'Fixture first connect failed' });
      await expect(controller.stop()).rejects.toThrow('interrupted after aliases publication');
      if (recovery === 'conflict') await writeFile(processesFile, '{"foreign":{"must":"stay"}}');
      processGuard.mockClear();
      const restarted = await controller.start();
      if (recovery === 'recover') {
        expect(restarted.state).toBe('running');
        expect(unfinishedAtConnect).toBe(false);
        await expect(stat(journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(connectCount).toBe(2);
      } else {
        expect(restarted).toMatchObject({ state: 'starting', message: 'TUNNEL_STALE_SNAPSHOT_CHANGED' });
        expect(connectCount).toBe(1);
        expect(processGuard).not.toHaveBeenCalled();
        await expect(readFile(processesFile, 'utf8')).resolves.toBe('{"foreign":{"must":"stay"}}');
      }
    } finally { await controller.shutdownForDesktopExit(); }
  });

  it('prepares a reset only after a stopped old alias is retired and verified absent', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-reset-reconcile-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    let exists = true;
    const retireStoppedAlias = vi.fn(async (): Promise<void> => { exists = false; });
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        processStateEvidence: 'stopped', exists, running: false, healthy: null, ready: null, pollHealthy: null,
        tunnelId: exists ? 'tunnel_oldalias12345' : null, mcpServerUrl: null, pid: null, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('Unexpected connect'); }),
      stop: vi.fn(async () => { throw new Error('Unexpected stop'); }),
      retireStoppedAlias,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath, setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_newalias12345', setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    await expect(controller.prepareFactoryReset()).resolves.toBeUndefined();
    expect(retireStoppedAlias).toHaveBeenCalledExactlyOnceWith('tunnel_oldalias12345');
    expect(exists).toBe(false);
  });

  it('refuses factory reset of an active alias whose Tunnel ID differs from saved configuration', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-reset-unowned-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const retireStoppedAlias = vi.fn();
    const stop = vi.fn();
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud', capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_oldalias12345', mcpServerUrl: null, pid: 99991, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('Unexpected connect'); }), stop, retireStoppedAlias,
    };
    const controller = new TunnelController({
      getClientPath: (): string => clientPath, setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string => 'tunnel_newalias12345', setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    await expect(controller.prepareFactoryReset()).rejects.toThrow('ownership is not verified');
    expect(stop).not.toHaveBeenCalled();
    expect(retireStoppedAlias).not.toHaveBeenCalled();
  });

  it('refuses to stop a persisted native alias when it reports a different Tunnel ID', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-persisted-mismatch-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture');
    const capabilities: TunnelRuntimeCapabilities = {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    };
    const stop = vi.fn();
    const adapter: TunnelRuntimeReconcilerAdapter = {
      runtimeAlias: (): string => 'lnwjud',
      capabilities: vi.fn(async () => capabilities),
      status: vi.fn(async () => ({
        exists: true, running: true, healthy: true, ready: true, pollHealthy: true,
        tunnelId: 'tunnel_other987654', mcpServerUrl: null, pid: 9999, uiUrl: null, message: null,
      })),
      connect: vi.fn(async () => { throw new Error('connect should not be called'); }),
      stop,
    };
    const controller = new TunnelController({
      getClientPath: (): string | null => clientPath,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      getTunnelId: (): string | null => 'tunnel_fixture012345',
      setTunnelId: (): void => undefined,
      createRuntimeAdapter: (): TunnelRuntimeReconcilerAdapter => adapter,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });

    await expect(controller.stop()).rejects.toThrow('different Tunnel ID');
    expect(stop).not.toHaveBeenCalled();
  });

  it('releases ownership when the child already has an exit code before signaling', async () => {
    const fixture = await ownedController(() => false);
    fixture.child.exitCode = 0;

    await expect(fixture.controller.stopOwned()).resolves.toMatchObject({ state: 'stopped' });
    expect(controllerInternals(fixture.controller).child).toBeNull();
    expect(await readTunnelLock(fixture.profileDir)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('returns promptly and retains ownership when the Windows child rejects the stop signal', async () => {
    const fixture = await ownedController(() => false);

    await expect(fixture.controller.stop()).rejects.toThrow('did not accept stop signal');

    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);
  });

  it.runIf(process.platform === 'win32')('returns promptly and retains ownership when signaling the Windows child throws', async () => {
    const fixture = await ownedController(() => { throw new Error('signal failed'); });

    await expect(fixture.controller.stop()).rejects.toThrow('signal failed');

    expect(controllerInternals(fixture.controller).child).toBe(fixture.child);
    expect(await readTunnelLock(fixture.profileDir)).toEqual(fixture.owner);
    await expectSecondControllerBlocked(fixture.dataPath, fixture.owner);
  });

  it.runIf(process.platform === 'win32')('uses the injected Windows graceful-stop bound and retains ownership when no child exit is observed', async () => {
    const fixture = await ownedController(() => true, 20);
    vi.useFakeTimers();
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

  it('uses identity-bound process-group termination on POSIX instead of ChildProcess.kill', async () => {
    let nakedKillCalled = false;
    let terminated = false;
    const startedAt = '2026-08-20T00:00:00.000Z';
    const fixture = await ownedController(() => {
      nakedKillCalled = true;
      return true;
    }, 20, {
      platform: 'linux',
      terminateOwnedProcessTree: async (): Promise<void> => {
        terminated = true;
        fixture.child.exitCode = 0;
        fixture.child.emit('exit', 0);
      },
      inspectOwnedProcess: async (): Promise<ProcessProbeResult> => terminated ? { state: 'gone' } : { state: 'live', processStartedAt: startedAt },
    });
    fixture.child.pid = 7658;

    await expect(fixture.controller.stopOwned()).resolves.toMatchObject({ state: 'stopped' });
    expect(nakedKillCalled).toBe(false);
    expect(terminated).toBe(true);
  });

  it('releases ownership when secret read or decryption fails after lock acquisition', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-secret-failure-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
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
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
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
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
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
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
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
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
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
    isolateTunnelProfile(dataPath);
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

  it.each([
    ['returns no matching PID', async (): Promise<boolean> => false],
    ['times out', async (): Promise<boolean> => { throw new Error('CIM probe timed out'); }],
  ])('keeps a healthy external tunnel authoritative when the process probe %s', async (_case, processProbe) => {
    const server = await healthServer((_request, response) => { response.writeHead(200); response.end('live'); });
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-external-health-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const profileDir = resolveTunnelProfileDirectory();
    const healthUrlFile = path.join(profileDir, 'health', 'lnwjud.url');
    await (await import('node:fs/promises')).mkdir(path.dirname(healthUrlFile), { recursive: true });
    await writeFile(path.join(profileDir, 'lnwjud.yaml'), JSON.stringify({
      control_plane: { tunnel_id: 'tunnel_external_health_fixture' },
      health: { listen_addr: '127.0.0.1:0', url_file: healthUrlFile },
      mcp: { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:18765/mcp' }] },
    }), 'utf8');
    await writeFile(healthUrlFile, `http://127.0.0.1:${server.port}\n`, 'utf8');
    await writeFile(path.join(profileDir, 'lnwjud-tunnel.log'), 'health server listening at 127.0.0.1:1\n', 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string | null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: processProbe,
    });

    try {
      await expect(controller.status()).resolves.toMatchObject({
        state: 'running',
        source: 'external',
        message: null,
        persistent: { mode: 'external', state: 'running', lastErrorCode: null },
      });
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
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

  it('clears a custom client override so the bundled client can be selected again', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    const bundled = path.join(dataPath, 'bundled-tunnel-client.exe');
    await writeFile(bundled, 'bundled', 'utf8');
    let configured = path.join(dataPath, 'missing-custom.exe');
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      getBundledClientPath: (): string => bundled,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
    });
    expect(controller.setClientPath('   ')).toBe('');
    expect(configured).toBe('');
    expect(controller.resolveClientPath()).toBe(bundled);
  });

  it('reports the configured override separately from the effective bundled client path', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    const bundled = path.join(dataPath, 'bundled-tunnel-client.exe');
    await writeFile(bundled, 'bundled', 'utf8');
    let configured = '';
    const controller = new TunnelController({
      getClientPath: (): string => configured,
      getBundledClientPath: (): string => bundled,
      setClientPath: (value): void => { configured = value; },
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });

    await expect(controller.status()).resolves.toMatchObject({
      clientPath: bundled,
      configuredClientPath: null,
    });
  });

  it('reads tunnel-client version from injected file metadata without executing it', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    const executable = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(executable, 'not executed', 'utf8');
    const controller = new TunnelController({ getClientPath: (): string => executable, setClientPath: (): void => {}, getDataPath: (): string => dataPath, inspectFileVersion: async (): Promise<string> => '1.2.3' });
    await expect(controller.clientVersion()).resolves.toEqual({ value: '1.2.3', reason: null });
  });

  it('falls back to the client --version command when file metadata is unavailable on any OS', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
    temporaryRoots.push(dataPath);
    const controller = new TunnelController({
      getClientPath: (): string => process.execPath,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
      inspectFileVersion: async (): Promise<null> => null,
    });
    const result = await controller.clientVersion();
    expect(result.reason).toBeNull();
    expect(result.value).toMatch(/^v?\d+\./);
  });

  it('funnels child error and exit through one per-process terminal fence', async () => {
    const source = await readFile(new URL('../src/main/tunnel-controller.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (terminalHandled) return;');
    expect(source).toContain("child.on('error', (error) => { handleTerminal(null, null, 'spawn_error', error.message); });");
    expect(source).toContain("child.on('exit', (code, signal) => { handleTerminal(code, signal, 'exit'); });");
    expect(source).toContain("stdio: ['ignore', 'ignore', 'pipe']");
    expect(source).not.toContain('restartWindowStartedAt');
  });

  it('pauses automatic reconnect after maxAutoRestarts rapid exits instead of looping forever', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-rapid-restarts-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
      maxAutoRestarts: (): number => 3,
      autoReconnect: (): boolean => true,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    const internals = controllerInternals(controller);
    internals.state = 'running';

    await internals.applyUnexpectedExit(1, clientPath);
    expect(internals.state).toBe('error');
    expect(internals.restartAttempts).toBe(1);
    expect(internals.restartTimer).not.toBeNull();

    await internals.applyUnexpectedExit(1, clientPath);
    expect(internals.restartAttempts).toBe(2);
    expect(internals.restartTimer).not.toBeNull();

    // 3rd exit reaches threshold (3) -> should pause and clear restart timer
    await internals.applyUnexpectedExit(1, clientPath);
    expect(internals.restartAttempts).toBe(3);
    expect(internals.restartTimer).toBeNull();
    expect(internals.state).toBe('error');
    expect(internals.message).toContain('automatic restart paused after 3 rapid failures');
  });

  it('counts child spawn errors towards rapid restart threshold and pauses', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-error-restarts-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const clientPath = path.join(dataPath, 'tunnel-client.exe');
    await writeFile(clientPath, 'fixture', 'utf8');
    const controller = new TunnelController({
      getClientPath: (): string => clientPath,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
      maxAutoRestarts: (): number => 2,
      autoReconnect: (): boolean => true,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    const internals = controllerInternals(controller);
    internals.state = 'running';

    await internals.applyUnexpectedExit(null, clientPath, 'spawn ENOENT');
    expect(internals.state).toBe('error');
    expect(internals.restartAttempts).toBe(1);
    expect(internals.restartTimer).not.toBeNull();

    await internals.applyUnexpectedExit(null, clientPath, 'spawn ENOENT');
    expect(internals.restartAttempts).toBe(2);
    expect(internals.restartTimer).toBeNull();
    expect(internals.state).toBe('error');
    expect(internals.message).toContain('automatic restart paused after 2 rapid failures');
  });

  it('skips expensive external process probe when no lock exists and health endpoint is inactive on Windows', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-lazy-probe-'));
    temporaryRoots.push(dataPath);
    isolateTunnelProfile(dataPath);
    const controller = new TunnelController({
      platform: 'win32',
      getClientPath: (): string | null => null,
      setClientPath: (): void => {},
      getDataPath: (): string => dataPath,
    });
    const internals = controllerInternals(controller);
    internals.state = 'stopped';

    const probe = await internals.probeExternalRunning();
    expect(probe).toBe('gone');
    expect(internals.lastExternalProbe).toBe('gone');
  });
});

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  pid?: number;
  kill(): boolean;
}

async function ownedController(kill: () => boolean, stopTimeoutMs = 2_000, shutdownOptions: {
  platform?: NodeJS.Platform;
  terminateOwnedProcessTree?: (pid: number) => Promise<void>;
  inspectOwnedProcess?: (pid: number) => Promise<import('@lnwjud/mcp-server').ProcessProbeResult>;
  inspectOwnedProcessTree?: (rootPid: number) => Promise<readonly { readonly pid: number; readonly processStartedAt: string }[]>;
  escalationTimeoutMs?: number;
  lockPlatform?: NodeJS.Platform;
} = {}, lockHooks?: NonNullable<Parameters<typeof acquireTunnelLock>[0]['hooks']>): Promise<{
  controller: TunnelController;
  child: FakeChild;
  dataPath: string;
  profileDir: string;
  owner: TunnelLockOwner;
}> {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-controller-'));
  temporaryRoots.push(dataPath);
  isolateTunnelProfile(dataPath);
  const profileDir = resolveTunnelProfileDirectory();
  const lockOwner: TunnelLockOwner = {
    pid: 7001,
    processStartedAt: '2026-08-20T00:00:00.000Z',
    acquiredAt: '2026-08-20T00:00:00.000Z',
  };
  const { lockPlatform = 'linux', ...controllerOptions } = shutdownOptions;
  const claim = await acquireTunnelLock({ profileDirectory: profileDir, owner: lockOwner, inspectProcess: async () => ({ state: 'live', processStartedAt: lockOwner.processStartedAt }), platform: lockPlatform, ...(lockHooks === undefined ? {} : { hooks: lockHooks }) });
  if (!claim.acquired) throw new Error('test controller could not acquire its lock');
  const controller = new TunnelController({
    getClientPath: (): string | null => null,
    setClientPath: (): void => {},
    getDataPath: (): string => dataPath,
    isExternalTunnelRunning: async (): Promise<boolean> => false,
    stopTimeoutMs,
    ...(process.platform === 'win32' ? {} : {
      inspectOwnedProcess: async (): Promise<ProcessProbeResult> => child.exitCode === null
        ? { state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' } : { state: 'gone' },
      terminateOwnedProcessTree: async (): Promise<void> => { child.kill(); },
    }),
    inspectOwnedProcessTree: async (): Promise<readonly { readonly pid: number; readonly processStartedAt: string }[]> => [],
    ...controllerOptions,
  });
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  if (process.platform !== 'win32') child.pid = 7001;
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
  message: string | null;
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  applyUnexpectedExit: (code: number | null, clientPath: string, errorMessage?: string) => Promise<void>;
  externalProbeAt: number;
  lastExternalProbe: 'live' | 'gone' | 'unverifiable';
  runtimeConfigurationDirty: boolean;
  runtimeMode: 'native-managed' | 'profile-child' | null;
  probeExternalRunning: (force?: boolean) => Promise<'live' | 'gone' | 'unverifiable'>;
} {
  return controller as unknown as {
    child: ChildProcess | null;
    ownedChildStartedAt: string | null;
    tunnelLock: TunnelLockAcquisition | null;
    state: 'stopped' | 'starting' | 'running' | 'error';
    message: string | null;
    restartAttempts: number;
    restartTimer: ReturnType<typeof setTimeout> | null;
    applyUnexpectedExit: (code: number | null, clientPath: string, errorMessage?: string) => Promise<void>;
    externalProbeAt: number;
    lastExternalProbe: 'live' | 'gone' | 'unverifiable';
    runtimeConfigurationDirty: boolean;
    runtimeMode: 'native-managed' | 'profile-child' | null;
    probeExternalRunning: (force?: boolean) => Promise<'live' | 'gone' | 'unverifiable'>;
  };
}

async function healthController(options: { profile: string; log: string; healthProbeTimeoutMs?: number }): Promise<{ controller: TunnelController }> {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-health-'));
  temporaryRoots.push(dataPath);
  isolateTunnelProfile(dataPath);
  const profileDir = resolveTunnelProfileDirectory();
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
