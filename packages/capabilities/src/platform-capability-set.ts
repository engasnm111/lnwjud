import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { BrowserCdpBackend } from './browser-cdp-backend.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { HealthCapabilityBackend } from './health-backend.js';
import { LocalCapabilityService, type CapabilityBackend } from './local-capability-service.js';
import { PowerShellWindowsCapabilityBridge } from './windows-bridge.js';
import { SchedulerCapabilityBackend } from './scheduler-backend.js';
import { ShellCapabilityBackend } from './shell-backend.js';
import { VisionCapabilityBackend, createOcrPackageIdentityProbe, WindowsOcrCapabilityBackend, WindowsOcrProcessBridge } from './windows-ocr-backend.js';
import { WebFetchCapabilityBackend } from './web-fetch-backend.js';
import { WindowsNativeCapabilityBackend } from './windows-native-backend.js';
import { WslCapabilityBackend, WslFilesystemCapabilityBackend } from './wsl-backend.js';
import { UnavailableCapabilityBackend } from './unavailable-backend.js';
import type { NativeHostProcessBridge } from './native-host-protocol.js';
import { MacosNativeCapabilityBackend } from './macos-native-backend.js';
import { LinuxNativeCapabilityBackend } from './linux-native-backend.js';
import { MacosSchedulerCapabilityBackend, LinuxSchedulerCapabilityBackend } from './portable-scheduler-backend.js';
import { SystemInfoCapabilityBackend } from './system-info-backend.js';
import { MacosOfficeCapabilityBackend } from './macos-office-backend.js';
import { LinuxOfficeCapabilityBackend } from './linux-office-backend.js';
import { AsyncTtlCache } from './async-ttl-cache.js';

export interface PlatformWindowsCapabilityOptions {
  readonly bridgeScriptPath: string;
  readonly expectedBridgeSha256: string;
  readonly expectedBridgeSizeBytes?: number;
  readonly ocrHelperPath?: string;
}

export interface PlatformCapabilitySetOptions {
  readonly windowsNativeAuthority?: import('@lnwjud/process').WindowsNativeAuthority;
  readonly posixProcessRuntime?: { readonly modulePath: string; readonly sha256: string };
  readonly platform?: NodeJS.Platform;
  readonly dataPath: string;
  readonly workspaceRootsProvider: () => Promise<readonly string[]>;
  readonly unrestricted?: boolean;
  readonly configuredRootsProvider?: () => readonly string[];
  readonly synchronousWaitSecondsProvider?: () => number;
  readonly windows?: PlatformWindowsCapabilityOptions;
  /** Electron-main providers whose semantics are shared by Windows/macOS/Linux. */
  readonly shared?: Partial<Record<import('./index.js').CapabilityToolName, CapabilityBackend>>;
  /** Optional integrity-bound native host for macOS/Linux desktop capabilities. */
  readonly nativeHost?: NativeHostProcessBridge;
}

export interface PlatformCapabilitySet {
  readonly service: LocalCapabilityService;
  readonly health: HealthCapabilityBackend;
  readonly shell: ShellCapabilityBackend;
  readonly domCdp: BrowserCdpBackend;
  readonly backends: Readonly<Record<string, CapabilityBackend>>;
  close(): Promise<Result<void>>;
}

/**
 * Compose exactly one host provider set.  Windows adapters are constructed
 * only when the selected platform is win32; foreign hosts receive explicit
 * unavailable providers instead of a Windows wrapper that fails at runtime.
 */
export function createPlatformCapabilitySet(options: PlatformCapabilitySetOptions): PlatformCapabilitySet {
  const platform = options.platform ?? process.platform;
  const unrestricted = options.unrestricted === true;
  const configuredRootsProvider = options.configuredRootsProvider ?? ((): readonly string[] => []);
  const capabilityRootsProvider = async (): Promise<readonly string[]> => {
    const workspaceRoots = await options.workspaceRootsProvider();
    const roots = [...workspaceRoots, ...configuredRootsProvider()];
    return roots.length === 0 ? [options.dataPath] : roots;
  };
  const shell = new ShellCapabilityBackend({
    allowedRoots: [options.dataPath],
    allowedRootsProvider: capabilityRootsProvider,
    unrestricted,
    taskStateDirectory: path.join(options.dataPath, 'background-tasks'),
    ...(options.windowsNativeAuthority === undefined ? {} : { windowsNativeAuthority: options.windowsNativeAuthority }),
    ...(options.posixProcessRuntime === undefined ? {} : { posixProcessRuntime: options.posixProcessRuntime }),
    ...(options.synchronousWaitSecondsProvider === undefined ? {} : { maxSynchronousWaitSecondsProvider: options.synchronousWaitSecondsProvider }),
  });
  const browserProtocol = new NodeBrowserCdpProtocol({ platform, profileDir: path.join(options.dataPath, 'browser-profile') });
  const browser = new BrowserCdpBackend({
    protocol: browserProtocol,
    launcher: (url: string | undefined, signal?: AbortSignal): Promise<import('@lnwjud/domain').Result<unknown>> => browserProtocol.launch(url, signal),
  });
  const webFetch = new WebFetchCapabilityBackend();

  const unavailable = (name: string, reason: 'unsupported_platform' | 'dependency_missing' = 'unsupported_platform'): UnavailableCapabilityBackend => (
    new UnavailableCapabilityBackend(name, reason, `${name} has no native provider for ${platform}`)
  );

  let accessibility: CapabilityBackend;
  let inputEvent: CapabilityBackend;
  let vision: CapabilityBackend;
  let window: CapabilityBackend;
  let systemInfo: CapabilityBackend;
  let notification: CapabilityBackend;
  let fileDialog: CapabilityBackend;
  let clipboard: CapabilityBackend;
  let audio: CapabilityBackend;
  let screenRecord: CapabilityBackend;
  let office: CapabilityBackend;
  let scheduler: CapabilityBackend;
  let wslExec: CapabilityBackend;
  let wslFs: CapabilityBackend;

  if (platform === 'win32') {
    const windows = options.windows;
    if (windows === undefined) throw new Error('Windows capability composition requires an integrity-bound bridge configuration');
    const bridge = new PowerShellWindowsCapabilityBridge({
      scriptPath: windows.bridgeScriptPath,
      expectedScriptSha256: windows.expectedBridgeSha256,
      ...(windows.expectedBridgeSizeBytes === undefined ? {} : { expectedScriptSizeBytes: windows.expectedBridgeSizeBytes }),
    });
    const nativeOptions = { allowedRootsProvider: capabilityRootsProvider, unrestricted };
    const ocrHelper = windows.ocrHelperPath === undefined ? undefined : new WindowsOcrProcessBridge({ helperPath: windows.ocrHelperPath });
    accessibility = new WindowsNativeCapabilityBackend('accessibility', bridge);
    inputEvent = new WindowsNativeCapabilityBackend('input_event', bridge);
    const nativeVision = new WindowsNativeCapabilityBackend('vision', bridge);
    vision = new VisionCapabilityBackend(nativeVision, new WindowsOcrCapabilityBackend({
      platform,
      ...(ocrHelper === undefined ? {} : { helper: ocrHelper, packageIdentity: createOcrPackageIdentityProbe(ocrHelper) }),
    }));
    window = new WindowsNativeCapabilityBackend('window', bridge);
    systemInfo = new WindowsNativeCapabilityBackend('system_info', bridge);
    notification = new WindowsNativeCapabilityBackend('notification', bridge);
    fileDialog = new WindowsNativeCapabilityBackend('file_dialog', bridge);
    clipboard = new WindowsNativeCapabilityBackend('clipboard', bridge);
    audio = new WindowsNativeCapabilityBackend('audio', bridge, platform, nativeOptions);
    screenRecord = new WindowsNativeCapabilityBackend('screen_record', bridge, platform, nativeOptions);
    office = new WindowsNativeCapabilityBackend('office', bridge, platform, nativeOptions);
    scheduler = new SchedulerCapabilityBackend({ platform });
    const wslAvailabilityCache = new AsyncTtlCache<import('@lnwjud/domain').Result<unknown>>(15_000);
    const wslAvailabilityProbe = (): Promise<import('@lnwjud/domain').Result<unknown>> => wslAvailabilityCache.get(async () => {
      const result = await shell.execute({ operation: 'run', executable: 'wsl.exe', arguments: ['--status'], cwd: options.dataPath, execution: 'foreground', timeout_seconds: 5, max_output_bytes: 32 * 1024, userConfirmed: false });
      if (!result.ok) return { ok: true, value: { available: false, ready: false, local: true, reason: 'wsl_executable_unavailable' } };
      const value = isRecord(result.value) ? result.value : {};
      const ready = value.state === 'completed' && value.exit_code === 0;
      return { ok: true, value: { available: ready, ready, local: true, ...(ready ? {} : { reason: 'wsl_status_failed' }) } };
    });
    wslExec = new WslCapabilityBackend({ platform, runner: shell, allowedRoots: [options.dataPath], allowedRootsProvider: capabilityRootsProvider, availabilityProbe: wslAvailabilityProbe });
    wslFs = new WslFilesystemCapabilityBackend({ platform, allowedRoots: [options.dataPath], allowedRootsProvider: capabilityRootsProvider, availabilityProbe: wslAvailabilityProbe });
  } else if (platform === 'darwin' || platform === 'linux') {
    const nativeBackend = <T extends import('./native-capability-backend.js').PortableNativeCapabilityName>(capability: T): CapabilityBackend => platform === 'darwin'
      ? new MacosNativeCapabilityBackend(capability, { ...(options.nativeHost === undefined ? {} : { bridge: options.nativeHost }), allowedRootsProvider: capabilityRootsProvider })
      : new LinuxNativeCapabilityBackend(capability, { ...(options.nativeHost === undefined ? {} : { bridge: options.nativeHost }), allowedRootsProvider: capabilityRootsProvider });
    accessibility = nativeBackend('accessibility');
    inputEvent = nativeBackend('input_event');
    const nativeVision = nativeBackend('vision');
    vision = platform === 'linux' && options.shared?.vision !== undefined
      ? withCaptureFallback(nativeVision, options.shared.vision)
      : nativeVision;
    window = nativeBackend('window');
    systemInfo = options.shared?.system_info ?? new SystemInfoCapabilityBackend(platform);
    notification = options.shared?.notification ?? unavailable('notification');
    fileDialog = options.shared?.file_dialog ?? unavailable('file_dialog');
    clipboard = options.shared?.clipboard ?? unavailable('clipboard');
    audio = nativeBackend('audio');
    screenRecord = nativeBackend('screen_record');
    office = platform === 'darwin'
      ? new MacosOfficeCapabilityBackend({ allowedRootsProvider: capabilityRootsProvider })
      : new LinuxOfficeCapabilityBackend({ allowedRootsProvider: capabilityRootsProvider });
    scheduler = platform === 'darwin' ? new MacosSchedulerCapabilityBackend() : new LinuxSchedulerCapabilityBackend();
    wslExec = unavailable('wsl_exec');
    wslFs = unavailable('wsl_fs');
  } else {
    // Keep unsupported Node platforms out of the Linux branch.  A generic
    // `else` here would instantiate X11/systemd adapters on hosts such as
    // FreeBSD and turn an unsupported profile into misleading dependency
    // probes.  Host-neutral shell/browser services can still be composed for
    // diagnostics, but every native/Windows-shaped capability is explicit.
    accessibility = unavailable('accessibility');
    inputEvent = unavailable('input_event');
    vision = unavailable('vision');
    window = unavailable('window');
    systemInfo = options.shared?.system_info ?? unavailable('system_info');
    notification = options.shared?.notification ?? unavailable('notification');
    fileDialog = options.shared?.file_dialog ?? unavailable('file_dialog');
    clipboard = options.shared?.clipboard ?? unavailable('clipboard');
    audio = unavailable('audio');
    screenRecord = unavailable('screen_record');
    office = unavailable('office');
    scheduler = unavailable('scheduler');
    wslExec = unavailable('wsl_exec');
    wslFs = unavailable('wsl_fs');
  }

  const health = new HealthCapabilityBackend({
    platform,
    domCdp: browser,
    accessibility,
    scheduler,
    wslExec,
    wslFs,
    backends: { dom_cdp: browser, accessibility, input_event: inputEvent, vision, window, system_info: systemInfo, notification, file_dialog: fileDialog, clipboard, web_fetch: webFetch, audio, screen_record: screenRecord, office, scheduler, wsl_exec: wslExec, wsl_fs: wslFs },
  });
  const service = new LocalCapabilityService({
    shell,
    domCdp: browser,
    accessibility,
    inputEvent,
    vision,
    window,
    health,
    systemInfo,
    notification,
    fileDialog,
    clipboard,
    webFetch,
    audio,
    screenRecord,
    office,
    scheduler,
    wslExec,
    wslFs,
  });
  let closing: Promise<Result<void>> | undefined;
  const close = (): Promise<Result<void>> => {
    service.close();
    if (closing !== undefined) return closing;
    const operation = (async (): Promise<Result<void>> => {
      const [native, browserResult] = await Promise.allSettled([options.nativeHost?.close() ?? Promise.resolve(ok(undefined)), browser.close()]);
      if (native.status === 'fulfilled' && !native.value.ok) return native.value;
      if (native.status === 'rejected' || browserResult.status === 'rejected') return err(appError('INTERNAL_ERROR', 'Owned capability cleanup could not be verified', true));
      return ok(undefined);
    })();
    closing = operation;
    void operation.finally(() => { if (closing === operation) closing = undefined; });
    return operation;
  };
  return {
    service,
    health,
    shell,
    domCdp: browser,
    close,
    backends: { accessibility, inputEvent, vision, window, systemInfo, notification, fileDialog, clipboard, audio, screenRecord, office, scheduler, wslExec, wslFs },
  };
}

function withCaptureFallback(primary: CapabilityBackend, fallback: CapabilityBackend): CapabilityBackend {
  return {
    execute: async (input, signal, authorization): Promise<import('@lnwjud/domain').Result<unknown>> => {
      const action = isRecord(input) && typeof input.action === 'string' ? input.action : 'status';
      const result = await primary.execute(input, signal, authorization);
      const parameters = isRecord(input) && isRecord(input.parameters) ? input.parameters : {};
      if (isRecord(input) && (input.handle !== undefined || input.session_id !== undefined || parameters.handle !== undefined || parameters.session_id !== undefined)) return result;
      if (action === 'status') {
        if (result.ok && isRecord(result.value) && result.value.ready === true) return result;
        const alternate = await fallback.execute(input, signal, authorization);
        return alternate.ok && isRecord(alternate.value) && alternate.value.available === true
          ? { ok: true, value: { ...alternate.value, backend: 'linux-native-or-electron-capture' } }
          : result;
      }
      if (!['capture_display', 'capture_region', 'capture_window'].includes(action)) return result;
      if (result.ok) {
        if (!isRecord(result.value) || result.value.available !== false) return result;
        return fallback.execute(input, signal, authorization);
      }
      if (!['UNSUPPORTED_PLATFORM', 'PERMISSION_REQUIRED', 'EXECUTABLE_NOT_FOUND'].includes(result.error.code)) return result;
      return fallback.execute(input, signal, authorization);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
