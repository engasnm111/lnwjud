export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'unsupported';
export type PlatformSupportTier = 'ga' | 'preview' | 'unsupported';
export type DesktopSession = 'windows' | 'aqua' | 'x11' | 'wayland' | 'headless' | 'unknown';

export interface PlatformContextInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release?: string;
  readonly desktopSession?: DesktopSession;
}

export interface PlatformContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly family: PlatformFamily;
  readonly supportTier: PlatformSupportTier;
  readonly targetTriple: string;
  readonly desktopSession: DesktopSession;
}

export function createPlatformContext(input: PlatformContextInput): PlatformContext {
  const family = platformFamily(input.platform);
  const supportTier = platformSupportTier(input.platform, input.arch);
  return {
    platform: input.platform,
    arch: input.arch,
    release: input.release ?? '',
    family,
    supportTier,
    targetTriple: `${input.platform}-${input.arch}`,
    desktopSession: input.desktopSession ?? defaultDesktopSession(input.platform),
  };
}

export function platformFamily(platform: NodeJS.Platform): PlatformFamily {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

export function platformSupportTier(platform: NodeJS.Platform, arch: string): PlatformSupportTier {
  if (platform === 'win32') return arch === 'x64' ? 'ga' : 'unsupported';
  if (platform === 'darwin') return arch === 'x64' || arch === 'arm64' ? 'ga' : 'unsupported';
  if (platform === 'linux') {
    if (arch === 'x64') return 'ga';
    if (arch === 'arm64') return 'preview';
  }
  return 'unsupported';
}

function defaultDesktopSession(platform: NodeJS.Platform): DesktopSession {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'aqua';
  return 'unknown';
}
