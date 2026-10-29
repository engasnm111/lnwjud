import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '@lnwjud/ipc-contracts';
import { installAfterPreUpdateBackup, UpdateInstallConsentController, UpdateInstallCoordinator, UpdateTunnelRecovery, updateInstallNeedsTunnelStopConfirmation, type DownloadedUpdateOffer, type UpdateSharedActivitySnapshot } from '../src/main/update-install.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('downloaded update installation', () => {
  const offer: DownloadedUpdateOffer = { generation: 1, version: '4.0.2', artifactIdentity: 'sha256:offer-1' };

  it('asks the user to confirm the exact downloaded version before queuing installation', async () => {
    const confirmVersion = vi.fn(async (): Promise<boolean> => true);
    const queueInstall = vi.fn(() => true);
    const controller = new UpdateInstallConsentController({
      getCurrentOffer: (): DownloadedUpdateOffer => offer,
      hasPendingInstall: (): boolean => false,
      confirmVersion,
      queueInstall,
    });

    await expect(controller.requestInstall()).resolves.toBe(true);
    expect(confirmVersion).toHaveBeenCalledExactlyOnceWith('4.0.2');
    expect(queueInstall).toHaveBeenCalledExactlyOnceWith(offer);
  });

  it('does not queue any install when the user declines', async () => {
    const queueInstall = vi.fn(() => true);
    const controller = new UpdateInstallConsentController({
      getCurrentOffer: (): DownloadedUpdateOffer => offer,
      hasPendingInstall: (): boolean => false,
      confirmVersion: async (): Promise<boolean> => false,
      queueInstall,
    });

    await expect(controller.requestInstall()).resolves.toBe(false);
    expect(queueInstall).not.toHaveBeenCalled();
  });

  it('starts the installer only after the pre-update backup completes', async () => {
    const events: string[] = [];
    const createBackup = vi.fn(async (): Promise<void> => { events.push('backup'); });
    const startInstall = vi.fn(async (): Promise<void> => { events.push('install'); });

    await installAfterPreUpdateBackup(createBackup, startInstall);

    expect(events).toEqual(['backup', 'install']);
  });

  it('does not start the installer when the required pre-update backup fails', async () => {
    const backupError = new Error('disk full');
    const createBackup = vi.fn(async (): Promise<void> => { throw backupError; });
    const startInstall = vi.fn(async (): Promise<void> => undefined);

    await expect(installAfterPreUpdateBackup(createBackup, startInstall)).rejects.toBe(backupError);
    expect(createBackup).toHaveBeenCalledOnce();
    expect(startInstall).not.toHaveBeenCalled();
  });

  it('routes a failed pre-update backup through Tunnel recovery before installer handoff', async () => {
    const backupError = new Error('disk full');
    const createBackup = vi.fn(async (): Promise<void> => { throw backupError; });
    const startInstall = vi.fn(async (): Promise<void> => undefined);
    const restoreTunnel = vi.fn(async (): Promise<void> => undefined);
    const recovery = new UpdateTunnelRecovery();
    recovery.rememberRunningTunnel(restoreTunnel);
    let signalErrorHandled: () => void = () => undefined;
    const errorHandled = new Promise<void>((resolve) => { signalErrorHandled = resolve; });
    const onInstallError = vi.fn(async (error: unknown): Promise<void> => {
      expect(error).toBe(backupError);
      await recovery.restoreAfterFailure();
      signalErrorHandled();
    });
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      install: async (): Promise<void> => installAfterPreUpdateBackup(createBackup, startInstall),
      onInstallError,
      quietPeriodMs: 0,
      pollIntervalMs: 1,
    });

    coordinator.requestInstall(offer);
    await errorHandled;

    expect(startInstall).not.toHaveBeenCalled();
    expect(onInstallError).toHaveBeenCalledOnce();
    expect(restoreTunnel).toHaveBeenCalledOnce();
  });

  it('restores a previously running Tunnel once when an update handoff fails', async () => {
    const recovery = new UpdateTunnelRecovery();
    const restore = vi.fn(async () => undefined);
    recovery.rememberRunningTunnel(restore);

    await expect(recovery.restoreAfterFailure()).resolves.toBeNull();
    await expect(recovery.restoreAfterFailure()).resolves.toBeNull();

    expect(restore).toHaveBeenCalledOnce();
  });

  it('coalesces simultaneous Tunnel recovery requests and reports a restore failure', async () => {
    const completion = deferred<void>();
    const recovery = new UpdateTunnelRecovery();
    const restore = vi.fn(() => completion.promise);
    recovery.rememberRunningTunnel(restore);

    const first = recovery.restoreAfterFailure();
    const second = recovery.restoreAfterFailure();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledOnce();
    completion.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);

    const failedRecovery = new UpdateTunnelRecovery();
    failedRecovery.rememberRunningTunnel(async () => { throw new Error('Tunnel restart failed'); });
    await expect(failedRecovery.restoreAfterFailure()).resolves.toBe('Tunnel restart failed');
  });

  it('requires fresh consent when a same-version download replaces the offered artifact', async () => {
    let currentOffer: DownloadedUpdateOffer = offer;
    const queueInstall = vi.fn(() => true);
    const controller = new UpdateInstallConsentController({
      getCurrentOffer: (): DownloadedUpdateOffer => currentOffer,
      hasPendingInstall: (): boolean => false,
      confirmVersion: async (): Promise<boolean> => {
        currentOffer = { ...offer, generation: 2, artifactIdentity: 'sha256:offer-2' };
        return true;
      },
      queueInstall,
    });

    await expect(controller.requestInstall()).resolves.toBe(false);
    expect(queueInstall).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous tray and renderer confirmations', async () => {
    const confirmation = deferred<boolean>();
    const confirmVersion = vi.fn(() => confirmation.promise);
    const queueInstall = vi.fn(() => true);
    const controller = new UpdateInstallConsentController({
      getCurrentOffer: (): DownloadedUpdateOffer => offer,
      hasPendingInstall: (): boolean => false,
      confirmVersion,
      queueInstall,
    });

    const first = controller.requestInstall();
    const second = controller.requestInstall();
    expect(await second).toBe(false);
    confirmation.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(confirmVersion).toHaveBeenCalledExactlyOnceWith('4.0.2');
    expect(queueInstall).toHaveBeenCalledExactlyOnceWith(offer);
  });

  it('detects a surviving persistent runtime even when the top-level tunnel state is stale', () => {
    expect(updateInstallNeedsTunnelStopConfirmation({
      ...tunnelStatus('stopped'),
      persistent: persistentStatus('reconnecting', true),
    })).toBe(true);
  });

  it('defers Restart Now while MCP calls are active', async () => {
    vi.useFakeTimers();
    let active = 1;
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => active,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(200);

    expect(install).not.toHaveBeenCalled();
    active = 0;
  });

  it('installs after MCP becomes idle for the quiet period', async () => {
    vi.useFakeTimers();
    let active = 1;
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => active,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    active = 0;
    await vi.advanceTimersByTimeAsync(29);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(install).toHaveBeenCalledOnce();
  });

  it('restarts the quiet period when MCP activity resumes', async () => {
    vi.useFakeTimers();
    let active = 0;
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => active,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 30,
    });

    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(10);
    active = 1;
    await vi.advanceTimersByTimeAsync(10);
    active = 0;
    await vi.advanceTimersByTimeAsync(39);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(install).toHaveBeenCalledOnce();
  });

  it('resets quiet time for a short call completed between polling samples', async () => {
    vi.useFakeTimers();
    let revision = 0;
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      activityRevision: (): number => revision,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 30,
    });
    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(0);
    revision += 2;
    await vi.advanceTimersByTimeAsync(39);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(install).toHaveBeenCalledOnce();
  });

  it('fails closed while a running tunnel has no trustworthy shared STDIO activity snapshot', async () => {
    vi.useFakeTimers();
    let shared: { state: 'missing' } | { state: 'available'; activeCallCount: number; revision: number } = { state: 'missing' };
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      activityRevision: (): number => 0,
      tunnelRunning: async (): Promise<boolean> => true,
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => shared,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(100);
    expect(install).not.toHaveBeenCalled();

    shared = { state: 'available', activeCallCount: 0, revision: 4 };
    await vi.advanceTimersByTimeAsync(29);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(install).toHaveBeenCalledOnce();
  });

  it('fails closed when tunnel activity itself is unverifiable until a trustworthy zero snapshot is observed', async () => {
    vi.useFakeTimers();
    const install = vi.fn();
    let shared: { state: 'unverifiable'; reason: string } | { state: 'available'; activeCallCount: number; revision: number } = { state: 'unverifiable', reason: 'probe_failed' };
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      tunnelRunning: async (): Promise<'unverifiable'> => 'unverifiable',
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => shared,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });
    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(100);
    expect(install).not.toHaveBeenCalled();
    shared = { state: 'available', activeCallCount: 0, revision: 1 };
    await vi.advanceTimersByTimeAsync(30);
    expect(install).toHaveBeenCalledOnce();
  });

  it('observes separate STDIO activity and restarts quiet time after a short remote call', async () => {
    vi.useFakeTimers();
    let shared = { state: 'available' as const, activeCallCount: 1, revision: 1 };
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      tunnelRunning: async (): Promise<boolean> => true,
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => shared,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 30,
    });
    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(20);
    expect(install).not.toHaveBeenCalled();
    shared = { state: 'available', activeCallCount: 0, revision: 2 };
    await vi.advanceTimersByTimeAsync(39);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(install).toHaveBeenCalledOnce();
  });

  it('re-samples local activity after awaiting the shared snapshot before entering the quiet period', async () => {
    vi.useFakeTimers();
    let active = 0;
    let revision = 0;
    const firstShared = deferred<UpdateSharedActivitySnapshot>();
    const secondShared = deferred<UpdateSharedActivitySnapshot>();
    const sharedActivitySnapshot = vi.fn()
      .mockImplementationOnce(() => firstShared.promise)
      .mockImplementationOnce(() => secondShared.promise);
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => active,
      activityRevision: (): number => revision,
      tunnelRunning: async (): Promise<boolean> => true,
      sharedActivitySnapshot,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(0);
    expect(sharedActivitySnapshot).toHaveBeenCalledTimes(1);

    active = 1;
    revision += 1;
    firstShared.resolve({ state: 'available', activeCallCount: 0, revision: 10 });
    await vi.advanceTimersByTimeAsync(0);

    expect(install).not.toHaveBeenCalled();
    expect(sharedActivitySnapshot).toHaveBeenCalledTimes(1);
  });

  it('waits for trustworthy shared activity while Secure Tunnel is active', async () => {
    vi.useFakeTimers();
    let shared: UpdateSharedActivitySnapshot = { state: 'missing' };
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      tunnelRunning: async (): Promise<boolean> => true,
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => shared,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });
    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(200);
    expect(install).not.toHaveBeenCalled();
    shared = { state: 'available', activeCallCount: 1, revision: 1 };
    await vi.advanceTimersByTimeAsync(50);
    expect(install).not.toHaveBeenCalled();
    shared = { state: 'available', activeCallCount: 0, revision: 2 };
    await vi.advanceTimersByTimeAsync(30);
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledExactlyOnceWith(offer);
  });

  it('keeps the attempt pending until the installer handoff settles', async () => {
    vi.useFakeTimers();
    const handoff = deferred<void>();
    const install = vi.fn(() => handoff.promise);
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });
    expect(coordinator.requestInstall(offer)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(install).toHaveBeenCalledOnce();
    expect(coordinator.hasPendingInstall()).toBe(true);
    expect(coordinator.requestInstall({ ...offer, generation: 2 })).toBe(false);
    handoff.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.hasPendingInstall()).toBe(false);
  });

  it('preserves active work after manual confirmation and waits for a full idle window', async () => {
    vi.useFakeTimers();
    let active = 1;
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => active,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(install).not.toHaveBeenCalled();
    expect(coordinator.hasPendingInstall()).toBe(true);
    active = 0;
    await vi.advanceTimersByTimeAsync(29);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(install).toHaveBeenCalledOnce();
    expect(coordinator.hasPendingInstall()).toBe(false);
  });

  it('cancels a pending idle wait during shutdown', async () => {
    vi.useFakeTimers();
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 0,
      install,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall(offer);
    coordinator.cancel();
    await vi.advanceTimersByTimeAsync(100);

    expect(install).not.toHaveBeenCalled();
  });

});

function tunnelStatus(state: TunnelStatus['state']): TunnelStatus {
  return {
    state,
    source: 'desktop',
    hasApiKey: true,
    clientPath: 'C:\\Program Files\\lnwjud\\resources\\tunnel-client\\tunnel-client.exe',
    profileExists: true,
    message: null,
    logPath: null,
    persistent: null,
  };
}

function persistentStatus(
  state: NonNullable<TunnelStatus['persistent']>['state'],
  runtimeAliasActive: boolean,
): NonNullable<TunnelStatus['persistent']> {
  return {
    enabled: true,
    tunnelIdMasked: 'tunnel_0123********cdef',
    runtimeAlias: 'lnwjud',
    runtimeAliasActive,
    mode: 'native-managed',
    state,
    healthy: true,
    ready: true,
    pollHealthy: true,
    reconnectCount: 0,
    lastConnectedAt: null,
    lastReconnectAt: null,
    nextReconnectAt: null,
    lastErrorCode: null,
    clientVersion: 'fixture',
    localMcpUrl: 'http://127.0.0.1:18765/mcp',
    uiUrl: null,
    readyBeforeRetire: false,
    strictZeroDowntime: false,
    capabilityEvidence: 'fixture',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
