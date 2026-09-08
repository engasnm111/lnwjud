import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capabilityToolNames,
  createPlatformCapabilitySet,
  type HealthCapabilityBackend,
  type LocalCapabilityService,
  type PlatformWindowsCapabilityOptions,
  type ShellCapabilityBackend,
  WINDOWS_CAPABILITY_BRIDGE_SHA256,
  WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES,
  LinuxProcessBridge,
  MacosProcessBridge,
  type NativeHostProcessBridge,
} from '@lnwjud/capabilities';
import { createProcessTreeTerminator } from '@lnwjud/process';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS } from '@lnwjud/shared';
import { createElectronNativeCapabilityBackends, type ElectronNativeCapabilityApi } from './electron-native-capability-backend.js';

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
  nativeApi?: ElectronNativeCapabilityApi,
): LocalCapabilityRuntime {
  const bridgeSizeBytes = capabilityBridgeExpectedSizeBytes();
  const ocrPath = windowsOcrHelperPath();
  const windows: PlatformWindowsCapabilityOptions | undefined = process.platform === 'win32'
    ? {
      bridgeScriptPath: capabilityBridgeScriptPath(),
      expectedBridgeSha256: capabilityBridgeExpectedSha256(),
      ...(bridgeSizeBytes === undefined ? {} : { expectedBridgeSizeBytes: bridgeSizeBytes }),
      ...(ocrPath === undefined ? {} : { ocrHelperPath: ocrPath }),
    }
    : undefined;
  const nativeHost = nativeHostBridge();
  const runtime = createPlatformCapabilitySet({
    platform: process.platform,
    dataPath,
    workspaceRootsProvider,
    unrestricted,
    configuredRootsProvider: () => [...readCapabilityRoots(process.env.LNWJUD_CAPABILITY_ROOTS), ...configuredRootsProvider()],
    synchronousWaitSecondsProvider,
    ...(nativeApi === undefined ? {} : { shared: createElectronNativeCapabilityBackends({ platform: process.platform, api: nativeApi, allowedRootsProvider: workspaceRootsProvider }) }),
    ...(windows === undefined ? {} : { windows }),
    ...(nativeHost === undefined ? {} : { nativeHost }),
  });
  return { service: runtime.service, health: runtime.health, shell: runtime.shell };
}

function nativeHostBridge(): NativeHostProcessBridge | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (arch === undefined) return undefined;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const platformDirectory = process.platform === 'darwin' ? 'macos' : 'linux';
  const executableName = process.platform === 'darwin' ? 'lnwjud-macos-host' : 'lnwjud-linux-host';
  const candidates = [
    resourcesPath === undefined ? undefined : path.join(resourcesPath, 'native-host', platformDirectory, arch, executableName),
    path.resolve(process.cwd(), 'build', 'native-host', platformDirectory, arch, executableName),
    path.resolve(process.cwd(), 'apps', 'desktop', 'build', 'native-host', platformDirectory, arch, executableName),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable === undefined) return undefined;
  const manifestPath = path.join(path.dirname(executable), 'NATIVE_HOST.json');
  let manifest: Record<string, unknown>;
  try {
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || realpathSync(manifestPath) !== manifestPath) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.platform !== process.platform || parsed.arch !== arch || parsed.name !== executableName || parsed.verified !== true
      || typeof parsed.sha256 !== 'string' || typeof parsed.sizeBytes !== 'number') return undefined;
    manifest = parsed;
  } catch {
    return undefined;
  }
  const options = {
    executablePath: executable,
    expectedSha256: manifest.sha256 as string,
    expectedSizeBytes: manifest.sizeBytes as number,
    requireIntegrity: true,
    terminator: createProcessTreeTerminator(process.platform),
  };
  return process.platform === 'darwin' ? new MacosProcessBridge(options) : new LinuxProcessBridge(options);
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
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return value.split(delimiter).map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
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
  notification: 'Show desktop notifications',
  file_dialog: 'Native file open/save dialogs',
  clipboard: 'Read and write the desktop clipboard',
  web_fetch: 'Fetch http/https URLs',
  audio: 'Record and play audio',
  screen_record: 'Record the screen to MP4',
  office: 'Automate Excel and Word',
  scheduler: 'Manage host-native scheduled tasks',
  wsl_exec: 'Run scoped Linux developer tasks on Windows',
  wsl_fs: 'Translate scoped Windows and WSL paths',
};

const capabilityDescriptions: Readonly<Record<(typeof capabilityToolNames)[number], string>> = {
  shell: 'System, CLI, file, process, and developer tasks',
  dom_cdp: 'DOM work inside a local managed Chrome session',
  accessibility: 'Host-native accessibility trees and semantic controls',
  input_event: 'Native keyboard, pointer, drag, and scroll events',
  vision: 'Local screen, monitor, region, and window capture when permitted',
  window: 'List, focus, move, resize, minimize, restore, and close host windows',
  health: 'Readiness and capability diagnostics',
  system_info: 'OS, CPU, memory, displays, and uptime metadata',
  notification: 'Desktop notifications for the local user',
  file_dialog: 'Native open/save dialog returning scoped paths',
  clipboard: 'Clipboard text and PNG image access',
  web_fetch: 'Bounded HTTP requests with text or base64 responses',
  audio: 'Microphone recording and local audio playback when permitted',
  screen_record: 'Host-native screen capture with start/stop/status',
  office: 'Dependency-gated spreadsheet and document automation',
  scheduler: 'Host-native scheduler list/create/run/delete operations',
  wsl_exec: 'WSL2 argv-only execution inside registered workspaces',
  wsl_fs: 'Path translation and metadata without raw WSL filesystem access',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
