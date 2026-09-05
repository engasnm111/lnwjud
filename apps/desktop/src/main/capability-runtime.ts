import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserCdpBackend,
  capabilityToolNames,
  HealthCapabilityBackend,
  LocalCapabilityService,
  NodeBrowserCdpProtocol,
  PowerShellWindowsCapabilityBridge,
  SchedulerCapabilityBackend,
  ShellCapabilityBackend,
  WebFetchCapabilityBackend,
  VisionCapabilityBackend,
  WindowsNativeCapabilityBackend,
  WindowsOcrCapabilityBackend,
  WindowsOcrProcessBridge,
  createOcrPackageIdentityProbe,
  WINDOWS_CAPABILITY_BRIDGE_SHA256,
  WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES,
  WslCapabilityBackend,
  WslFilesystemCapabilityBackend,
} from '@lnwjud/capabilities';
import type { Result } from '@lnwjud/domain';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS } from '@lnwjud/shared';
import { AsyncTtlCache } from './async-ttl-cache.js';

export interface LocalCapabilityRuntime {
  readonly service: LocalCapabilityService;
  readonly health: HealthCapabilityBackend;
  readonly shell: ShellCapabilityBackend;
}

export function createLocalCapabilityRuntime(
  dataPath: string,
  workspaceRootsProvider: () => Promise<readonly string[]>,
  unrestricted: boolean = false,
  configuredRootsProvider: () => readonly string[] = () => [],
  synchronousWaitSecondsProvider: () => number = () => DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
): LocalCapabilityRuntime {
  const capabilityRootsProvider = async (): Promise<readonly string[]> => {
    const workspaceRoots = await workspaceRootsProvider();
    const configuredRoots = [...readCapabilityRoots(process.env.LNWJUD_CAPABILITY_ROOTS), ...configuredRootsProvider()];
    const roots = [...workspaceRoots, ...configuredRoots];
    return roots.length === 0 ? [dataPath] : roots;
  };
  const shellBackend = new ShellCapabilityBackend({
    allowedRoots: [dataPath],
    allowedRootsProvider: capabilityRootsProvider,
    unrestricted,
    taskStateDirectory: path.join(dataPath, 'background-tasks'),
    maxSynchronousWaitSecondsProvider: synchronousWaitSecondsProvider,
  });
  const browserProtocol = new NodeBrowserCdpProtocol({ profileDir: path.join(dataPath, 'browser-profile') });
  const browserBackend = new BrowserCdpBackend({
    protocol: browserProtocol,
    launcher: (url: string | undefined, signal?: AbortSignal): Promise<Result<unknown>> => browserProtocol.launch(url, signal),
  });
  const windowsBridgeScript = capabilityBridgeScriptPath();
  const expectedScriptSha256 = capabilityBridgeExpectedSha256();
  const expectedScriptSizeBytes = capabilityBridgeExpectedSizeBytes();
  const windowsBridge = new PowerShellWindowsCapabilityBridge({
    scriptPath: windowsBridgeScript,
    expectedScriptSha256,
    ...(expectedScriptSizeBytes === undefined ? {} : { expectedScriptSizeBytes }),
  });
  const nativeOptions = { allowedRootsProvider: capabilityRootsProvider, unrestricted };
  const accessibilityBackend = new WindowsNativeCapabilityBackend('accessibility', windowsBridge);
  const inputEventBackend = new WindowsNativeCapabilityBackend('input_event', windowsBridge);
  const nativeVisionBackend = new WindowsNativeCapabilityBackend('vision', windowsBridge);
  const ocrHelperPath = windowsOcrHelperPath();
  const ocrHelper = ocrHelperPath === undefined ? undefined : new WindowsOcrProcessBridge({ helperPath: ocrHelperPath });
  const visionBackend = new VisionCapabilityBackend(nativeVisionBackend, new WindowsOcrCapabilityBackend({
    platform: process.platform,
    ...(ocrHelper === undefined ? {} : { helper: ocrHelper, packageIdentity: createOcrPackageIdentityProbe(ocrHelper) }),
  }));
  const windowBackend = new WindowsNativeCapabilityBackend('window', windowsBridge);
  const systemInfoBackend = new WindowsNativeCapabilityBackend('system_info', windowsBridge);
  const notificationBackend = new WindowsNativeCapabilityBackend('notification', windowsBridge);
  const fileDialogBackend = new WindowsNativeCapabilityBackend('file_dialog', windowsBridge);
  const clipboardBackend = new WindowsNativeCapabilityBackend('clipboard', windowsBridge);
  const audioBackend = new WindowsNativeCapabilityBackend('audio', windowsBridge, process.platform, nativeOptions);
  const screenRecordBackend = new WindowsNativeCapabilityBackend('screen_record', windowsBridge, process.platform, nativeOptions);
  const officeBackend = new WindowsNativeCapabilityBackend('office', windowsBridge, process.platform, nativeOptions);
  const webFetchBackend = new WebFetchCapabilityBackend();
  const schedulerBackend = new SchedulerCapabilityBackend();
  const wslAvailabilityCache = new AsyncTtlCache<Result<unknown>>(15_000);
  const wslAvailabilityProbe = (): Promise<Result<unknown>> => wslAvailabilityCache.get(async () => {
    const result = await shellBackend.execute({ operation: 'run', executable: 'wsl.exe', arguments: ['--status'], cwd: dataPath, execution: 'foreground', timeout_seconds: 5, max_output_bytes: 32 * 1024, userConfirmed: false });
    if (!result.ok) return { ok: true, value: { available: false, ready: false, local: true, reason: 'wsl_executable_unavailable' } };
    const value = isRecord(result.value) ? result.value : {};
    const ready = value.state === 'completed' && value.exit_code === 0;
    return { ok: true, value: { available: ready, ready, local: true, ...(ready ? {} : { reason: 'wsl_status_failed' }) } };
  });
  const wslBackend = new WslCapabilityBackend({
    platform: process.platform,
    runner: shellBackend,
    allowedRoots: [dataPath],
    allowedRootsProvider: capabilityRootsProvider,
    availabilityProbe: wslAvailabilityProbe,
  });
  const wslFsBackend = new WslFilesystemCapabilityBackend({
    platform: process.platform,
    allowedRoots: [dataPath],
    allowedRootsProvider: capabilityRootsProvider,
    availabilityProbe: wslAvailabilityProbe,
  });
  const health = new HealthCapabilityBackend({ domCdp: browserBackend, accessibility: accessibilityBackend, wslExec: wslBackend, wslFs: wslFsBackend });
  const service = new LocalCapabilityService({
    shell: shellBackend,
    domCdp: browserBackend,
    accessibility: accessibilityBackend,
    inputEvent: inputEventBackend,
    vision: visionBackend,
    window: windowBackend,
    health,
    systemInfo: systemInfoBackend,
    notification: notificationBackend,
    fileDialog: fileDialogBackend,
    clipboard: clipboardBackend,
    webFetch: webFetchBackend,
    audio: audioBackend,
    screenRecord: screenRecordBackend,
    office: officeBackend,
    scheduler: schedulerBackend,
    wslExec: wslBackend,
    wslFs: wslFsBackend,
  });
  return { service, health, shell: shellBackend };
}

export async function buildCapabilitySummary(health: HealthCapabilityBackend): Promise<DashboardSnapshot['capabilities']> {
  const checked = await health.execute({ operation: 'check_all' });
  const values = checked.ok && isRecord(checked.value) && isRecord(checked.value.capabilities) ? checked.value.capabilities : {};
  return capabilityToolNames.map((name) => {
    const value = values[name];
    const available = isRecord(value) && value.available === true;
    const ready = isRecord(value) && value.ready === true;
    return { name, title: capabilityTitles[name], description: capabilityDescriptions[name], available, ready };
  });
}

function readCapabilityRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(';').map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
}

function capabilityBridgeScriptPath(): string {
  const configured = process.env.LNWJUD_CAPABILITY_BRIDGE_SCRIPT;
  if (configured !== undefined && configured.trim().length > 0) return path.resolve(configured);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.resolve(process.cwd(), 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'),
    path.resolve(process.cwd(), '..', '..', 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'),
    resourcesPath === undefined ? undefined : path.join(resourcesPath, 'windows-capability-bridge.ps1'),
    path.join(path.dirname(process.execPath), 'windows-capability-bridge.ps1'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function capabilityBridgeExpectedSha256(): string {
  const configuredScript = process.env.LNWJUD_CAPABILITY_BRIDGE_SCRIPT;
  if (configuredScript === undefined || configuredScript.trim().length === 0) return WINDOWS_CAPABILITY_BRIDGE_SHA256;
  const configuredHash = process.env.LNWJUD_CAPABILITY_BRIDGE_SHA256?.trim().toLowerCase();
  return configuredHash !== undefined && /^[0-9a-f]{64}$/.test(configuredHash) ? configuredHash : 'missing';
}

function capabilityBridgeExpectedSizeBytes(): number | undefined {
  const configuredScript = process.env.LNWJUD_CAPABILITY_BRIDGE_SCRIPT;
  if (configuredScript === undefined || configuredScript.trim().length === 0) return WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES;
  const configuredSize = Number.parseInt(process.env.LNWJUD_CAPABILITY_BRIDGE_SIZE_BYTES ?? '', 10);
  return Number.isSafeInteger(configuredSize) && configuredSize > 0 ? configuredSize : undefined;
}

function windowsOcrHelperPath(): string | undefined {
  const configured = process.env.LNWJUD_WINDOWS_OCR_HELPER;
  if (configured !== undefined && configured.trim().length > 0) return path.resolve(configured);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.resolve(process.cwd(), 'native', 'windows-ocr', 'bin', 'lnwjud-windows-ocr.exe'),
    resourcesPath === undefined ? undefined : path.join(resourcesPath, 'windows-ocr', 'lnwjud-windows-ocr.exe'),
    path.join(path.dirname(process.execPath), 'windows-ocr', 'lnwjud-windows-ocr.exe'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate));
}

const capabilityTitles: Readonly<Record<(typeof capabilityToolNames)[number], string>> = {
  shell: 'Run system and CLI tasks',
  dom_cdp: 'Control managed Chrome',
  accessibility: 'Use semantic native controls',
  input_event: 'Send keyboard and pointer events',
  vision: 'Capture and inspect the screen',
  window: 'Manage native desktop windows',
  health: 'Check tool readiness',
  system_info: 'Read system information',
  notification: 'Show Windows notifications',
  file_dialog: 'Native file open/save dialogs',
  clipboard: 'Read and write the clipboard',
  web_fetch: 'Fetch http/https URLs',
  audio: 'Record and play audio',
  screen_record: 'Record the screen to MP4',
  office: 'Automate Excel and Word',
  scheduler: 'Manage Windows scheduled tasks',
  wsl_exec: 'Run scoped Linux developer tasks',
  wsl_fs: 'Translate scoped Windows and WSL paths',
};

const capabilityDescriptions: Readonly<Record<(typeof capabilityToolNames)[number], string>> = {
  shell: 'System, CLI, file, process, and developer tasks',
  dom_cdp: 'DOM work inside a local managed Chrome session',
  accessibility: 'Windows UI Automation trees and semantic controls',
  input_event: 'Native keyboard, pointer, drag, and scroll events',
  vision: 'Local screen, monitor, region, and window capture',
  window: 'List, focus, move, resize, minimize, restore, and close windows',
  health: 'Readiness and capability diagnostics',
  system_info: 'OS, CPU, memory, disks, battery, uptime, and top processes',
  notification: 'Toast or balloon notifications for the local user',
  file_dialog: 'Windows open/save dialog returning chosen paths',
  clipboard: 'Clipboard text and PNG image access',
  web_fetch: 'Bounded HTTP requests with text or base64 responses',
  audio: 'Microphone recording and local audio playback',
  screen_record: 'ffmpeg gdigrab screen capture with start/stop/status',
  office: 'Excel range read/write and Word text operations via COM',
  scheduler: 'schtasks.exe list/create/run/delete operations',
  wsl_exec: 'WSL2 argv-only execution inside registered workspaces',
  wsl_fs: 'Path translation and metadata without raw WSL filesystem access',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
