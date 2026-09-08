import type { CapabilityToolName } from './index.js';

export type CapabilityAvailability = 'always' | 'windows' | 'optional';

export type CapabilityPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface CapabilityDescriptor {
  readonly name: CapabilityToolName;
  readonly availability: CapabilityAvailability;
  readonly requirements: readonly string[];
  readonly permission: CapabilityPermission;
  readonly supportsCancel: boolean;
  readonly supportsDryRun: boolean;
  readonly auditTarget: string;
}

const descriptor = (
  name: CapabilityToolName,
  availability: CapabilityAvailability,
  permission: CapabilityPermission,
  auditTarget: string,
  requirements: readonly string[] = [],
  supportsCancel = false,
  supportsDryRun = false,
): CapabilityDescriptor => ({
  name,
  availability,
  requirements,
  permission,
  supportsCancel,
  supportsDryRun,
  auditTarget,
});

export const capabilityDescriptors: readonly CapabilityDescriptor[] = Object.freeze([
  descriptor('shell', 'always', 'EXECUTE', 'process', ['workspace registration'], true, true),
  descriptor('dom_cdp', 'optional', 'READ', 'browser', ['CDP-compatible browser']),
  descriptor('accessibility', 'optional', 'READ', 'window', ['host accessibility provider'], false, true),
  descriptor('input_event', 'optional', 'EXECUTE', 'window', ['host input permission'], false, true),
  descriptor('vision', 'optional', 'READ', 'display', ['host capture/OCR provider'], false, true),
  descriptor('window', 'optional', 'WRITE', 'window', ['host window provider'], false, true),
  descriptor('health', 'always', 'READ', 'diagnostics'),
  descriptor('system_info', 'always', 'READ', 'system', ['Electron/OS metadata']),
  descriptor('notification', 'optional', 'WRITE', 'notification', ['desktop notification session']),
  descriptor('file_dialog', 'optional', 'WRITE', 'window', ['desktop dialog session']),
  descriptor('clipboard', 'optional', 'WRITE', 'clipboard', ['desktop clipboard session']),
  descriptor('web_fetch', 'optional', 'READ', 'network', ['network policy']),
  descriptor('audio', 'optional', 'WRITE', 'audio', ['host audio provider']),
  descriptor('screen_record', 'optional', 'READ', 'display', ['host screen-record provider']),
  descriptor('office', 'optional', 'WRITE', 'office', ['compatible Office provider']),
  descriptor('scheduler', 'optional', 'EXECUTE', 'scheduler', ['host task scheduler'], true, true),
  descriptor('wsl_exec', 'windows', 'EXECUTE', 'workspace', ['wsl.exe', 'registered workspace'], true, true),
  descriptor('wsl_fs', 'windows', 'READ', 'workspace', ['wsl.exe', 'registered workspace'], false, false),
]);
