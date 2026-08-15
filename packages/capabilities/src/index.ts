import type { Result } from '@lnwjud/domain';

export const capabilityToolNames = Object.freeze([
  'shell',
  'dom_cdp',
  'accessibility',
  'input_event',
  'vision',
  'window',
  'health',
  'system_info',
  'notification',
  'file_dialog',
  'clipboard',
  'web_fetch',
  'audio',
  'screen_record',
  'office',
  'scheduler',
] as const);

export type CapabilityToolName = (typeof capabilityToolNames)[number];

export interface CapabilityService {
  execute(tool: CapabilityToolName, input: unknown): Promise<Result<unknown>>;
}

export { LocalCapabilityService, type CapabilityBackend, type LocalCapabilityBackends } from './local-capability-service.js';
export { ShellCapabilityBackend, type ShellCapabilityOptions } from './shell-backend.js';
export { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';
export { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
export { HealthCapabilityBackend } from './health-backend.js';
export { WebFetchCapabilityBackend } from './web-fetch-backend.js';
export { SchedulerCapabilityBackend } from './scheduler-backend.js';
export { WindowsNativeCapabilityBackend, type WindowsCapabilityBridge, type WindowsCapabilityName } from './windows-native-backend.js';
export { PowerShellWindowsCapabilityBridge, type PowerShellWindowsBridgeOptions } from './windows-bridge.js';
