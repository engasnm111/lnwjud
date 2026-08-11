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
  ShellCapabilityBackend,
  WindowsNativeCapabilityBackend,
} from '@lnwjud/capabilities';
import type { Result } from '@lnwjud/domain';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';

export interface LocalCapabilityRuntime {
  readonly service: LocalCapabilityService;
  readonly health: HealthCapabilityBackend;
}

export function createLocalCapabilityRuntime(
  dataPath: string,
  workspaceRootsProvider: () => Promise<readonly string[]>,
): LocalCapabilityRuntime {
  const shellBackend = new ShellCapabilityBackend({
    allowedRoots: [dataPath],
    allowedRootsProvider: async (): Promise<readonly string[]> => {
      const workspaceRoots = await workspaceRootsProvider();
      const configuredRoots = readCapabilityRoots(process.env.LNWJUD_CAPABILITY_ROOTS);
      const roots = [...workspaceRoots, ...configuredRoots];
      return roots.length === 0 ? [dataPath] : roots;
    },
  });
  const browserProtocol = new NodeBrowserCdpProtocol({ profileDir: path.join(dataPath, 'browser-profile') });
  const browserBackend = new BrowserCdpBackend({
    protocol: browserProtocol,
    launcher: (url: string | undefined): Promise<Result<unknown>> => browserProtocol.launch(url),
  });
  const windowsBridge = new PowerShellWindowsCapabilityBridge({ scriptPath: capabilityBridgeScriptPath() });
  const accessibilityBackend = new WindowsNativeCapabilityBackend('accessibility', windowsBridge);
  const inputEventBackend = new WindowsNativeCapabilityBackend('input_event', windowsBridge);
  const visionBackend = new WindowsNativeCapabilityBackend('vision', windowsBridge);
  const windowBackend = new WindowsNativeCapabilityBackend('window', windowsBridge);
  const health = new HealthCapabilityBackend({ domCdp: browserBackend, accessibility: accessibilityBackend });
  const service = new LocalCapabilityService({
    shell: shellBackend,
    domCdp: browserBackend,
    accessibility: accessibilityBackend,
    inputEvent: inputEventBackend,
    vision: visionBackend,
    window: windowBackend,
    health,
  });
  return { service, health };
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

const capabilityTitles: Readonly<Record<(typeof capabilityToolNames)[number], string>> = {
  shell: 'Run system and CLI tasks',
  dom_cdp: 'Control managed Chrome',
  accessibility: 'Use semantic native controls',
  input_event: 'Send keyboard and pointer events',
  vision: 'Capture and inspect the screen',
  window: 'Manage native desktop windows',
  health: 'Check tool readiness',
};

const capabilityDescriptions: Readonly<Record<(typeof capabilityToolNames)[number], string>> = {
  shell: 'System, CLI, file, process, and developer tasks',
  dom_cdp: 'DOM work inside a local managed Chrome session',
  accessibility: 'Windows UI Automation trees and semantic controls',
  input_event: 'Native keyboard, pointer, drag, and scroll events',
  vision: 'Local screen, monitor, region, and window capture',
  window: 'List, focus, move, resize, minimize, restore, and close windows',
  health: 'Readiness and capability diagnostics',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
