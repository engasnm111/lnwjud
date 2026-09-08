import os from 'node:os';

export type SupportedHostPlatform = 'win32' | 'darwin' | 'linux';

export type PlatformSupportTier = 'supported' | 'preview' | 'unsupported';

export type PlatformCapabilityDisposition = 'native' | 'dependency_gated' | 'unsupported';

export interface PlatformProfileInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
}

export interface PlatformProfile {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly family: 'windows' | 'macos' | 'linux' | 'unsupported';
  readonly supportTier: PlatformSupportTier;
  readonly capabilities: Readonly<Record<string, PlatformCapabilityDisposition>>;
}

const CAPABILITY_NAMES = [
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
  'tunnel-client',
  'registry_context',
  'windows_environment',
  'windows_sandbox',
  'sandbox_exec',
  'event_log_context',
  'service_context',
  'office_ppt',
  'office_outlook',
  'pdf_provider_installer',
] as const;

const WINDOWS_NATIVE = Object.freeze({
  shell: 'native',
  dom_cdp: 'dependency_gated',
  accessibility: 'native',
  input_event: 'native',
  vision: 'native',
  window: 'native',
  health: 'native',
  system_info: 'native',
  notification: 'native',
  file_dialog: 'native',
  clipboard: 'native',
  web_fetch: 'native',
  audio: 'native',
  screen_record: 'native',
  office: 'native',
  scheduler: 'native',
  wsl_exec: 'native',
  wsl_fs: 'native',
  'tunnel-client': 'native',
  registry_context: 'native',
  windows_environment: 'native',
  windows_sandbox: 'native',
  sandbox_exec: 'dependency_gated',
  event_log_context: 'native',
  service_context: 'native',
  office_ppt: 'native',
  office_outlook: 'native',
  pdf_provider_installer: 'native',
} satisfies Record<(typeof CAPABILITY_NAMES)[number], PlatformCapabilityDisposition>);

const MACOS_NATIVE = Object.freeze({
  shell: 'native',
  dom_cdp: 'dependency_gated',
  accessibility: 'dependency_gated',
  input_event: 'dependency_gated',
  vision: 'dependency_gated',
  window: 'dependency_gated',
  health: 'native',
  system_info: 'native',
  notification: 'dependency_gated',
  file_dialog: 'native',
  clipboard: 'dependency_gated',
  web_fetch: 'native',
  audio: 'dependency_gated',
  screen_record: 'dependency_gated',
  office: 'dependency_gated',
  scheduler: 'dependency_gated',
  wsl_exec: 'unsupported',
  wsl_fs: 'unsupported',
  'tunnel-client': 'dependency_gated',
  registry_context: 'unsupported',
  windows_environment: 'unsupported',
  windows_sandbox: 'unsupported',
  sandbox_exec: 'unsupported',
  event_log_context: 'native',
  service_context: 'dependency_gated',
  office_ppt: 'dependency_gated',
  office_outlook: 'unsupported',
  pdf_provider_installer: 'unsupported',
} satisfies Record<(typeof CAPABILITY_NAMES)[number], PlatformCapabilityDisposition>);

const LINUX_NATIVE = Object.freeze({
  shell: 'native',
  dom_cdp: 'dependency_gated',
  accessibility: 'dependency_gated',
  input_event: 'dependency_gated',
  vision: 'dependency_gated',
  window: 'dependency_gated',
  health: 'native',
  system_info: 'native',
  notification: 'dependency_gated',
  file_dialog: 'dependency_gated',
  clipboard: 'dependency_gated',
  web_fetch: 'native',
  audio: 'dependency_gated',
  screen_record: 'dependency_gated',
  office: 'dependency_gated',
  scheduler: 'dependency_gated',
  wsl_exec: 'unsupported',
  wsl_fs: 'unsupported',
  'tunnel-client': 'dependency_gated',
  registry_context: 'unsupported',
  windows_environment: 'unsupported',
  windows_sandbox: 'unsupported',
  sandbox_exec: 'unsupported',
  event_log_context: 'dependency_gated',
  service_context: 'dependency_gated',
  office_ppt: 'dependency_gated',
  office_outlook: 'unsupported',
  pdf_provider_installer: 'unsupported',
} satisfies Record<(typeof CAPABILITY_NAMES)[number], PlatformCapabilityDisposition>);

const UNSUPPORTED = Object.freeze(
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, 'unsupported' as const])) as Record<
    (typeof CAPABILITY_NAMES)[number],
    PlatformCapabilityDisposition
  >,
);

function darwinMajorVersion(release: string): number | null {
  const major = Number.parseInt(release.trim().split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

function windowsBuild(release: string): number | null {
  const build = Number.parseInt(release.trim().split('.')[2] ?? '', 10);
  return Number.isInteger(build) && build > 0 ? build : null;
}

/** Build a deterministic host profile without reading or mutating process globals. */
export function createPlatformProfile(input: PlatformProfileInput): PlatformProfile {
  const { platform, arch, release } = input;

  if (platform === 'win32') {
    const build = windowsBuild(release);
    const supported = arch === 'x64' && build !== null && build >= 10_240;
    return {
      platform,
      arch,
      release,
      family: 'windows',
      supportTier: supported ? 'supported' : 'unsupported',
      capabilities: supported ? WINDOWS_NATIVE : UNSUPPORTED,
    };
  }

  if (platform === 'darwin') {
    const supported = (arch === 'arm64' || arch === 'x64') && (darwinMajorVersion(release) ?? 0) >= 22;
    return {
      platform,
      arch,
      release,
      family: supported ? 'macos' : 'unsupported',
      supportTier: supported ? 'supported' : 'unsupported',
      capabilities: supported ? MACOS_NATIVE : UNSUPPORTED,
    };
  }

  if (platform === 'linux') {
    const supported = arch === 'x64' || arch === 'arm64';
    return {
      platform,
      arch,
      release,
      family: supported ? 'linux' : 'unsupported',
      supportTier: arch === 'x64' ? 'supported' : arch === 'arm64' ? 'preview' : 'unsupported',
      capabilities: supported ? LINUX_NATIVE : UNSUPPORTED,
    };
  }

  return {
    platform,
    arch,
    release,
    family: 'unsupported',
    supportTier: 'unsupported',
    capabilities: UNSUPPORTED,
  };
}

/** Resolve the actual host profile for production startup. */
export function currentPlatformProfile(): PlatformProfile {
  return createPlatformProfile({ platform: process.platform, arch: process.arch, release: os.release() });
}
