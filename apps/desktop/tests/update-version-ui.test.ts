import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('titlebar update notification', () => {
  it('turns the top-left version chip into an update action with visual states', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const shell = await readFile(path.join(root, 'src', 'renderer', 'features', 'shell', 'AppShell.tsx'), 'utf8');
    const app = await readFile(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
    const main = await readFile(path.join(root, 'src', 'main', 'main.ts'), 'utf8');


    expect(shell).toContain("className={`titlebar-version update-${props.updateStatus?.phase ?? 'idle'}`}");
    expect(shell).toContain('onClick={props.onUpdateAction}');
    expect(shell).toContain("status.phase === 'ready'");
    expect(shell).toContain("status.phase === 'downloading'");
    expect(app).toContain('window.lnwjud.onUpdateStatus');
    expect(app).toContain('window.lnwjud.installUpdate()');
    expect(app).toContain("updateStatus?.phase === 'installing'");
    expect(app).toContain('updateInstallTransitionRef.current');
    expect(app).toContain('refreshBusyRef.current || updateInstallTransitionRef.current');
    expect(main).toContain('new UpdateInstallConsentController');
    expect(main).toContain('messages.updaterInstallConfirmMessage(version)');
    expect(main).toContain('currentDownloadedUpdateOffer: DownloadedUpdateOffer | null = null');
    expect(main).toContain('return services.stopTunnelFromUser();');
    expect(main).toContain('const status = await runtime.pauseTunnelForUpdate();');
    const installFlowStart = main.indexOf('async function installDownloadedUpdate');
    const installFlowEnd = main.indexOf('function initAutoUpdater', installFlowStart);
    const installFlow = main.slice(installFlowStart, installFlowEnd);
    const drainIndex = installFlow.indexOf('await desktopIpcDrainBarrier.beginDrain()');
    const tunnelStopIndex = installFlow.indexOf('await stopTunnelForUpdateInstall(runtime)');
    const backupHandoffIndex = installFlow.indexOf('await installAfterPreUpdateBackup(');
    const installerIndex = installFlow.indexOf('installWindowsUpdate(autoUpdater)');
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(tunnelStopIndex).toBeGreaterThan(drainIndex);
    expect(backupHandoffIndex).toBeGreaterThan(tunnelStopIndex);
    expect(installFlow.slice(backupHandoffIndex, installerIndex)).toContain("() => runtime.createBackup('pre-update')");
    expect(installerIndex).toBeGreaterThan(backupHandoffIndex);
    expect(installFlow).toContain('launchPortableReplacement(prepared)');
    expect(main).toContain('usesElectronUpdaterInstall(updaterDistribution)');
    expect(main).toContain("currentUpdateStatus.phase === 'installing'");
    expect(main).toContain("phase: 'ready'");

  });

  it('blocks the whole app behind one installation/update progress surface for every lnwjud-owned machine installer', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const app = await readFile(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
    const preload = await readFile(path.join(root, 'src', 'preload', 'index.ts'), 'utf8');
    const main = await readFile(path.join(root, 'src', 'main', 'main.ts'), 'utf8');
    const desktopServices = await readFile(path.join(root, 'src', 'main', 'desktop-services.ts'), 'utf8');

    const contracts = await readFile(path.resolve(root, '..', '..', 'packages', 'ipc-contracts', 'src', 'index.ts'), 'utf8');

    expect(contracts).toContain("getInstallActivity: 'lnwjud:get-install-activity'");
    expect(contracts).toContain("installActivity: 'lnwjud:event:install-activity'");
    expect(contracts).toContain("'app_update' | 'ngrok' | 'pdf_provider'");
    expect(preload).toContain('onInstallActivity');
    expect(app).toContain('window.lnwjud.onInstallActivity');
    expect(app).toContain('let eventSeen = false');
    expect(app).toContain('if (!disposed && !eventSeen) setInstallActivity(snapshot)');
    expect(app).toContain('eventSeen = true');
    expect(app).toContain('<GlobalInstallProgressModal');
    expect(app).toContain('inert={installBusy ? true : undefined}');
    expect(desktopServices).toContain("phase: 'preparing', progressPercent: null, message");
    expect(desktopServices).toContain("withInstallActivity('ngrok'");
    expect(desktopServices).toContain("withInstallActivity('pdf_provider'");
    expect(main).toContain("kind: 'app_update'");

  });
});
