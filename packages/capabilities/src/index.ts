import type { InvocationAuthorization, Result } from '@lnwjud/domain';

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
  'wsl_exec',
  'wsl_fs',
] as const);

export type CapabilityToolName = (typeof capabilityToolNames)[number];

export { prohibitedAgentCommandReason } from './agent-command-policy.js';

export interface CapabilityService {
  execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>>;
}

export { LocalCapabilityService, type CapabilityBackend, type LocalCapabilityBackends } from './local-capability-service.js';
export { ShellCapabilityBackend, type ShellCapabilityOptions } from './shell-backend.js';
export {
  CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY,
  CAPABILITY_TASK_OWNER_METADATA_KEY,
  capabilityTaskOwnerMatches,
  legacyCapabilityTaskOwner,
  readCapabilityActiveWorkspaceRoot,
  readCapabilityTaskOwner,
  type CapabilityTaskOwner,
} from './task-ownership.js';
export { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';
export { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
export { HealthCapabilityBackend } from './health-backend.js';
export { WebFetchCapabilityBackend } from './web-fetch-backend.js';
export { SchedulerCapabilityBackend } from './scheduler-backend.js';
export { WslCapabilityBackend, WslFilesystemCapabilityBackend, type WslCapabilityOptions, type WslFilesystemCapabilityOptions } from './wsl-backend.js';
export {
  VisionCapabilityBackend,
  WindowsOcrCapabilityBackend,
  WindowsOcrProcessBridge,
  createOcrPackageIdentityProbe,
  type WindowsOcrCapabilityOptions,
  type WindowsOcrHelper,
  type WindowsOcrProcessBridgeOptions,
} from './windows-ocr-backend.js';
export { WindowsNativeCapabilityBackend, type WindowsCapabilityBridge, type WindowsCapabilityName } from './windows-native-backend.js';
export { EventLogCapabilityBackend, type EventLogBackendOptions, type EventLogRunner } from './event-log-backend.js';
export { PowerShellWindowsCapabilityBridge, type PowerShellWindowsBridgeOptions } from './windows-bridge.js';
export {
  capabilityDescriptors,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityPermission,
} from './capability-descriptors.js';

export { WINDOWS_CAPABILITY_BRIDGE_SHA256, WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES } from './windows-capability-integrity.generated.js';
