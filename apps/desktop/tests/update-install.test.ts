import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '@lnwjud/ipc-contracts';
import { confirmTunnelStopForUpdate, UpdateDownloadedDialogController, UpdateInstallCoordinator, updateInstallNeedsTunnelStopConfirmation, updateReadyDialogOptions, type UpdateSharedActivitySnapshot } from '../src/main/update-install.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('downloaded update installation', () => {
  it('makes Later the default response in the update-ready dialog', () => {
    expect(updateReadyDialogOptions('4.0.2')).toMatchObject({
      buttons: ['Restart Now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
  });

  it('requires explicit confirmation before installing while Secure Tunnel is running', async () => {
    const confirmStop = vi.fn(async (): Promise<boolean> => false);
    await expect(confirmTunnelStopForUpdate({
      getTunnelStatus: async () => tunnelStatus('running'),
      confirmStop,
    })).resolves.toBe(false);
    expect(confirmStop).toHaveBeenCalledOnce();
  });

  it('does not prompt for tunnel stop when the tunnel is already stopped', async () => {
    const confirmStop = vi.fn(async (): Promise<boolean> => true);
    await expect(confirmTunnelStopForUpdate({
      getTunnelStatus: async () => tunnelStatus('stopped'),
      confirmStop,
    })).resolves.toBe(true);
    expect(confirmStop).not.toHaveBeenCalled();
  });

  it('fails safe to confirmation when tunnel status cannot be verified', async () => {
    const confirmStop = vi.fn(async (): Promise<boolean> => true);
    await expect(confirmTunnelStopForUpdate({
      getTunnelStatus: async () => { throw new Error('probe failed'); },
      confirmStop,
    })).resolves.toBe(true);
    expect(confirmStop).toHaveBeenCalledOnce();
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

    coordinator.requestInstall();
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

    coordinator.requestInstall();
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

    coordinator.requestInstall();
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
    coordinator.requestInstall();
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

    coordinator.requestInstall();
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
    coordinator.requestInstall();
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
    coordinator.requestInstall();
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

    coordinator.requestInstall();
    await vi.advanceTimersByTimeAsync(0);
    expect(sharedActivitySnapshot).toHaveBeenCalledTimes(1);

    active = 1;
    revision += 1;
    firstShared.resolve({ state: 'available', activeCallCount: 0, revision: 10 });
    await vi.advanceTimersByTimeAsync(0);

    expect(install).not.toHaveBeenCalled();
    expect(sharedActivitySnapshot).toHaveBeenCalledTimes(1);
  });

  it('forces installation after a bounded grace period once the user has confirmed an update', async () => {
    vi.useFakeTimers();
    const install = vi.fn();
    const coordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => 1,
      install,
      maxWaitMs: 50,
      pollIntervalMs: 10,
      quietPeriodMs: 20,
    });

    coordinator.requestInstall();
    await vi.advanceTimersByTimeAsync(49);
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

    coordinator.requestInstall();
    coordinator.cancel();
    await vi.advanceTimersByTimeAsync(100);

    expect(install).not.toHaveBeenCalled();
  });

  it('suppresses duplicate downloaded events while the dialog is open', async () => {
    const dialogResult = deferred<{ response: number }>();
    const showDialog = vi.fn(() => dialogResult.promise);
    const requestInstall = vi.fn();
    const lifecycle = new UpdateDownloadedDialogController({
      showDialog,
      requestInstall,
      hasPendingInstall: (): boolean => false,
    });

    const first = lifecycle.handle('4.0.2');
    await expect(lifecycle.handle('4.0.2')).resolves.toBe(false);
    expect(showDialog).toHaveBeenCalledOnce();
    dialogResult.resolve({ response: 1 });
    await first;
    expect(requestInstall).not.toHaveBeenCalled();
  });

  it('suppresses downloaded events while an idle install request is pending', async () => {
    const showDialog = vi.fn(async () => ({ response: 1 }));
    const lifecycle = new UpdateDownloadedDialogController({
      showDialog,
      requestInstall: vi.fn(),
      hasPendingInstall: (): boolean => true,
    });

    await expect(lifecycle.handle('4.0.2')).resolves.toBe(false);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('remembers a version after Later so only a new version can reopen in the session', async () => {
    const showDialog = vi.fn(async (): Promise<{ response: number }> => ({ response: 1 }));
    const lifecycle = new UpdateDownloadedDialogController({ showDialog, requestInstall: vi.fn(), hasPendingInstall: (): boolean => false });

    await expect(lifecycle.handle('4.0.2')).resolves.toBe(true);
    await expect(lifecycle.handle('4.0.2')).resolves.toBe(false);
    await expect(lifecycle.handle('4.0.3')).resolves.toBe(true);

    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it('clears the dialog guard in finally after rejection so a later event can show', async () => {
    const onError = vi.fn();
    const showDialog = vi.fn()
      .mockRejectedValueOnce(new Error('dialog unavailable'))
      .mockResolvedValueOnce({ response: 0 });
    const requestInstall = vi.fn();
    const lifecycle = new UpdateDownloadedDialogController({
      showDialog,
      requestInstall,
      hasPendingInstall: (): boolean => false,
      onError,
    });

    await expect(lifecycle.handle('4.0.2')).resolves.toBe(true);
    await expect(lifecycle.handle('4.0.2')).resolves.toBe(true);

    expect(showDialog).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'dialog unavailable' }));
    expect(requestInstall).toHaveBeenCalledOnce();
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
