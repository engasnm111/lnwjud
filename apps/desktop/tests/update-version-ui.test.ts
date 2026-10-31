import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperatorUpdateIntent } from '../src/renderer/operator-update-intent.js';

describe('titlebar update notification', () => {
  it('advances a titlebar-initiated update only once and never installs from ordinary update status events', () => {
    const intent = new OperatorUpdateIntent();
    expect(intent.onStatus({ phase: 'ready' })).toBe('none');
    expect(intent.start()).toBe(true);
    expect(intent.onStatus({ phase: 'checking' })).toBe('none');
    expect(intent.onStatus({ phase: 'available' })).toBe('request-download');
    // A second titlebar click while the first download is pending must not
    // reset the one-shot intent or enqueue another download.
    expect(intent.start()).toBe(false);
    expect(intent.onStatus({ phase: 'available' })).toBe('none');
    expect(intent.onStatus({ phase: 'downloading' })).toBe('none');
    expect(intent.onStatus({ phase: 'ready', canInstall: true })).toBe('confirm-install');
    expect(intent.onStatus({ phase: 'ready' })).toBe('none');
    intent.start();
    expect(intent.onStatus({ phase: 'unavailable' })).toBe('none');
    expect(intent.onStatus({ phase: 'ready' })).toBe('none');
    intent.start();
    expect(intent.onStatus({ phase: 'error' })).toBe('none');
    expect(intent.onStatus({ phase: 'ready' })).toBe('none');
  });

  it('never requests native installation without verified canInstall permission', () => {
    const intent = new OperatorUpdateIntent();
    expect(intent.start()).toBe(true);
    expect(intent.onStatus({ phase: 'available' })).toBe('request-download');
    expect(intent.onStatus({ phase: 'ready', canInstall: false })).toBe('none');
    expect(intent.start()).toBe(true);
    intent.cancel();
  });

  it('allows a fresh user-initiated check after an unavailable native download declines the offered update', () => {
    const intent = new OperatorUpdateIntent();
    expect(intent.start()).toBe(true);
    expect(intent.onStatus({ phase: 'available' })).toBe('request-download');
    expect(intent.onStatus({ phase: 'unavailable' })).toBe('none');
    expect(intent.start()).toBe(true);
    intent.cancel();
  });

  it('keeps read-only version checks usable while native package installation is unavailable', async () => {
    const main = await readFile(path.resolve(import.meta.dirname, '../src/main/main.ts'), 'utf8');
    expect(main).not.toContain('MANUAL_RELEASE_ONLY');
    expect(main).toContain('verifiedAutomaticUpdateAuthority = hasVerifiedAutomaticUpdateAuthority(authority)');
    expect(main).toContain('autoUpdater.autoDownload = verifiedAutomaticUpdateAuthority && desktopUserSettings.updateAutoDownload');
    expect(main).toContain('autoUpdater.autoDownload = verifiedAutomaticUpdateAuthority && settings.updateAutoDownload');
    expect(main).toContain('if (!verifiedAutomaticUpdateAuthority || !app.isPackaged');
    expect(main).toContain('if (!verifiedAutomaticUpdateAuthority || currentUpdateStatus.phase');
    expect(main).toContain("return patchUpdateStatus({ phase: 'unavailable', message: messages.updaterUnavailableTransactionAuthority, canInstall: false });");
    expect(main).toContain('autoUpdater.checkForUpdates()');
    const downloadedHandler = main.slice(main.indexOf("autoUpdater.on('update-downloaded', (info) => {"), main.indexOf("autoUpdater.on('error', (err) => {"));
    expect(downloadedHandler).toContain('if (!verifiedAutomaticUpdateAuthority) {');
    expect(downloadedHandler.indexOf('if (!verifiedAutomaticUpdateAuthority) {')).toBeLessThan(downloadedHandler.indexOf("phase: 'ready'"));
    expect(downloadedHandler).toContain("phase: 'unavailable'");
    const initializer = main.slice(main.indexOf('async function initAutoUpdater('));
    const authority = initializer.indexOf('verifiedAutomaticUpdateAuthority = hasVerifiedAutomaticUpdateAuthority(authority)');
    const configured = initializer.indexOf('configureUpdaterForDistribution(autoUpdater, windowsDistribution)');
    expect(authority).toBeGreaterThan(0);
    expect(configured).toBeGreaterThan(authority);
    expect(initializer.slice(authority, configured)).not.toContain('return;');
  });

  it('uses the top-left badge as the only update action with one later install confirmation', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const app = await readFile(path.join(root, 'src/renderer/App.tsx'), 'utf8');
    const settings = await readFile(path.join(root, 'src/renderer/features/settings/SettingsPage.tsx'), 'utf8');
    const userConfig = await readFile(path.join(root, 'src/renderer/features/settings/UserConfigPanel.tsx'), 'utf8');
    const action = app.slice(app.indexOf('async function handleUpdateAction()'), app.indexOf('async function addWorkspace('));
    expect(action).toContain('if (!operatorUpdateIntentRef.current.start()) return;');
    expect(action).toContain('const status = await window.lnwjud.checkForUpdates();');
    expect(action).toContain('advanceOperatorUpdate(status);');
    expect(app).toContain("if (action === 'request-download')");
    expect(app).toContain("else if (action === 'confirm-install')");
    expect(app).not.toContain('onTestNativeUpdate=');
    expect(settings).not.toContain('onTestNativeUpdate');
    expect(userConfig).not.toContain('manualUpdateAction');
    expect(userConfig).not.toContain('testNativeUpdate()');
  });

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
