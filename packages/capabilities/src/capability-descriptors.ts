import type { CapabilityToolName } from './index.js';

export type CapabilityAvailability = 'always' | 'desktop' | 'windows' | 'optional';

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
  descriptor('accessibility', 'desktop', 'READ', 'window', ['native accessibility permission']),
  descriptor('input_event', 'desktop', 'EXECUTE', 'window', ['native input permission'], false, true),
  descriptor('vision', 'desktop', 'READ', 'display', ['screen recording permission; platform OCR backend for OCR'], false, true),
  descriptor('window', 'desktop', 'WRITE', 'window', ['native window access'], false, true),
  descriptor('health', 'always', 'READ', 'diagnostics'),
  descriptor('system_info', 'always', 'READ', 'system'),
  descriptor('notification', 'desktop', 'WRITE', 'notification'),
  descriptor('file_dialog', 'desktop', 'WRITE', 'window'),
  descriptor('clipboard', 'desktop', 'WRITE', 'clipboard'),
  descriptor('web_fetch', 'optional', 'READ', 'network', ['network policy']),
  descriptor('audio', 'desktop', 'WRITE', 'audio'),
  descriptor('screen_record', 'desktop', 'READ', 'display'),
  descriptor('office', 'windows', 'WRITE', 'office', ['Office desktop installation']),
  descriptor('scheduler', 'always', 'EXECUTE', 'scheduler', ['local task scheduler'], true, true),
  descriptor('wsl_exec', 'windows', 'EXECUTE', 'workspace', ['wsl.exe', 'registered workspace'], true, true),
  descriptor('wsl_fs', 'windows', 'READ', 'workspace', ['wsl.exe', 'registered workspace'], false, false),
]);
