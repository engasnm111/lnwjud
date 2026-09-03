import type { CapabilityToolName } from './index.js';

export type CapabilityAvailability = 'always' | 'platform' | 'optional';
export type CapabilityPlatform = 'win32' | 'darwin' | 'linux';
export type CapabilitySession = 'any' | 'interactive-desktop' | 'x11' | 'wayland' | 'headless';

export type CapabilityPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface CapabilityPlatformPolicy {
  readonly platforms: readonly CapabilityPlatform[];
  readonly sessions: readonly CapabilitySession[];
}

export interface CapabilityDescriptor {
  readonly name: CapabilityToolName;
  readonly availability: CapabilityAvailability;
  readonly platformPolicy: CapabilityPlatformPolicy;
  readonly requirements: readonly string[];
  readonly permission: CapabilityPermission;
  readonly supportsCancel: boolean;
  readonly supportsDryRun: boolean;
  readonly auditTarget: string;
}

const ALL_DESKTOP_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux'] as const);
const ANY_SESSION = Object.freeze(['any'] as const);
const INTERACTIVE_DESKTOP = Object.freeze(['interactive-desktop'] as const);
const WINDOWS_ONLY = Object.freeze(['win32'] as const);

const descriptor = (
  name: CapabilityToolName,
  availability: CapabilityAvailability,
  permission: CapabilityPermission,
  auditTarget: string,
  requirements: readonly string[] = [],
  supportsCancel = false,
  supportsDryRun = false,
  platforms: readonly CapabilityPlatform[] = ALL_DESKTOP_PLATFORMS,
  sessions: readonly CapabilitySession[] = ANY_SESSION,
): CapabilityDescriptor => ({
  name,
  availability,
  platformPolicy: { platforms, sessions },
  requirements,
  permission,
  supportsCancel,
  supportsDryRun,
  auditTarget,
});

const windowsDescriptor = (
  name: CapabilityToolName,
  permission: CapabilityPermission,
  auditTarget: string,
  requirements: readonly string[] = [],
  supportsCancel = false,
  supportsDryRun = false,
  sessions: readonly CapabilitySession[] = ANY_SESSION,
): CapabilityDescriptor => descriptor(
  name,
  'platform',
  permission,
  auditTarget,
  requirements,
  supportsCancel,
  supportsDryRun,
  WINDOWS_ONLY,
  sessions,
);

export const capabilityDescriptors: readonly CapabilityDescriptor[] = Object.freeze([
  descriptor('shell', 'always', 'EXECUTE', 'process', ['workspace registration'], true, true),
  descriptor('dom_cdp', 'optional', 'READ', 'browser', ['CDP-compatible browser']),
  windowsDescriptor('accessibility', 'READ', 'window', ['UI Automation'], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('input_event', 'EXECUTE', 'window', ['input permission'], false, true, INTERACTIVE_DESKTOP),
  windowsDescriptor('vision', 'READ', 'display', ['Windows package identity for WinRT OCR'], false, true, INTERACTIVE_DESKTOP),
  windowsDescriptor('window', 'WRITE', 'window', ['Win32 window access'], false, true, INTERACTIVE_DESKTOP),
  descriptor('health', 'always', 'READ', 'diagnostics'),
  windowsDescriptor('system_info', 'READ', 'system'),
  windowsDescriptor('notification', 'WRITE', 'notification', [], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('file_dialog', 'WRITE', 'window', [], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('clipboard', 'WRITE', 'clipboard', [], false, false, INTERACTIVE_DESKTOP),
  descriptor('web_fetch', 'optional', 'READ', 'network', ['network policy']),
  windowsDescriptor('audio', 'WRITE', 'audio', [], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('screen_record', 'READ', 'display', [], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('office', 'WRITE', 'office', ['Office desktop installation'], false, false, INTERACTIVE_DESKTOP),
  windowsDescriptor('scheduler', 'EXECUTE', 'scheduler', ['Windows Task Scheduler'], true, true),
  windowsDescriptor('wsl_exec', 'EXECUTE', 'workspace', ['wsl.exe', 'registered workspace'], true, true),
  windowsDescriptor('wsl_fs', 'READ', 'workspace', ['wsl.exe', 'registered workspace']),
]);

export function capabilitySupportsPlatform(
  descriptor: CapabilityDescriptor,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return descriptor.platformPolicy.platforms.some((candidate) => candidate === platform);
}
