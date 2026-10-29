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
export { SecureRepositoryImportRuntime } from './repository-import-runtime.js';
export { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
export { SqliteWorkspaceWriterLease, WORKSPACE_WRITER_STALE_GRACE_MS, type WorkspaceWriterLeaseAbandonment, type WorkspaceWriterLeaseRevocation, type WorkspaceWriterLeasePort, type WorkspaceWriterLeaseProof, type WorkspaceWriterLeaseStatus } from './workspace-writer-lease.js';

export interface CapabilityService {
  execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>>;
  observeAutomationShell?(
    ownerClientId: string,
    workspaceId: string,
    taskId: string,
    requestDigest: string,
  ): Promise<Result<unknown>>;
}

export { LocalCapabilityService, type CapabilityBackend, type LocalCapabilityBackends } from './local-capability-service.js';
export {
  ShellCapabilityBackend,
  withAutomationShellDispatchContext,
  type AutomationShellDispatchContext,
  type ShellCapabilityOptions,
} from './shell-backend.js';
export {
  CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY,
  CAPABILITY_TASK_OWNER_METADATA_KEY,
  capabilityTaskOwnerCanInspect,
  capabilityTaskOwnerCanRecover,
  capabilityTaskOwnerMatches,
  legacyCapabilityTaskOwner,
  readCapabilityActiveWorkspaceRoot,
  readCapabilityTaskOwner,
  type CapabilityTaskOwner,
} from './task-ownership.js';
export { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';
export { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
export { NativeHostProcessBridge, type NativeHostProtocolOptions, type NativeHostSpawner } from './native-host-protocol.js';
export { MacosProcessBridge, type MacosProcessBridgeOptions, type MacOSProcessBridge, unavailableMacosHost } from './macos-process-bridge.js';
export { LinuxProcessBridge, type LinuxProcessBridgeOptions, type LinuxNativeOperationAuthorization, unavailableLinuxHost } from './linux-process-bridge.js';
export { NativeCapabilityBackend, type NativeCapabilityBackendOptions, type PortableNativeCapabilityName } from './native-capability-backend.js';
export { nativeCapabilityActions, isNativeCapabilityAction } from './native-capability-contract.js';
export { MacosNativeCapabilityBackend, type MacosNativeBackendOptions } from './macos-native-backend.js';
export { LinuxNativeCapabilityBackend, type LinuxNativeBackendOptions } from './linux-native-backend.js';
export { HealthCapabilityBackend } from './health-backend.js';
export { UnavailableCapabilityBackend, type UnavailableCapabilityReason } from './unavailable-backend.js';
export { createPlatformCapabilitySet, type PlatformCapabilitySet, type PlatformCapabilitySetOptions, type PlatformWindowsCapabilityOptions } from './platform-capability-set.js';
export { WebFetchCapabilityBackend } from './web-fetch-backend.js';
export { SchedulerCapabilityBackend } from './scheduler-backend.js';
export { MacosSchedulerCapabilityBackend, LinuxSchedulerCapabilityBackend, type PortableSchedulerBackendOptions, type PortableSchedulerRunResult } from './portable-scheduler-backend.js';
export { MacosSchedulerCapabilityBackend as MacosSchedulerBackend } from './macos-scheduler-backend.js';
export { LinuxSchedulerCapabilityBackend as LinuxSchedulerBackend } from './linux-scheduler-backend.js';
export { PlatformDiagnosticsCapabilityBackend, type PlatformDiagnosticsBackendOptions, type PlatformDiagnosticsRunResult } from './platform-diagnostics-backend.js';
export { MacosDiagnosticsCapabilityBackend, type MacosDiagnosticsBackendOptions, type MacOSDiagnosticsBackend } from './macos-diagnostics-backend.js';
export { LinuxDiagnosticsCapabilityBackend, type LinuxDiagnosticsBackendOptions, type LinuxDiagnosticsBackend } from './linux-diagnostics-backend.js';
export { sanitizedChildEnvironment } from './sanitized-child-environment.js';
export { MacosOfficeCapabilityBackend, type MacosOfficeBackendOptions, type MacOSOfficeBackend } from './macos-office-backend.js';
export { LinuxOfficeCapabilityBackend, type LinuxOfficeBackendOptions, type LinuxOfficeBackend } from './linux-office-backend.js';
export { SystemInfoCapabilityBackend, type SystemInfoSnapshot } from './system-info-backend.js';
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
export { EventLogCapabilityBackend, type EventLogBackendOptions, type EventLogPortableRunner, type EventLogRunner } from './event-log-backend.js';
export { PowerShellWindowsCapabilityBridge, type PowerShellWindowsBridgeOptions } from './windows-bridge.js';
export {
  capabilityDescriptors,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityPermission,
} from './capability-descriptors.js';

export { WINDOWS_CAPABILITY_BRIDGE_SHA256, WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES } from './windows-capability-integrity.generated.js';
export { BoundedEventBuffer, type BufferedEvent, type EventPage } from './bounded-event-buffer.js';
export { resolveNativeHostBridge } from './native-host-resolver.js';
export { createHostWindowsNativeAuthority, createHostPosixProcessRuntime } from './host-native-authority.js';
