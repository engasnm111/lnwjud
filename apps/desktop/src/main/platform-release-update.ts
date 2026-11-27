const versions = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repository = 'https://github.com/engasnm111/lnwjud';
export const LATEST_PLATFORM_RELEASE_API = 'https://api.github.com/repos/engasnm111/lnwjud/releases/latest';

export type PlatformReleaseExtension = 'dmg' | 'deb';

export interface PlatformReleaseDownload {
  readonly version: string;
  readonly url: string;
}

export function findPlatformReleaseDownload(
  release: unknown,
  currentVersion: string,
  architecture: string,
  extension: PlatformReleaseExtension,
): PlatformReleaseDownload | null {
  if (!isRecord(release) || release.draft !== false || release.prerelease !== false
    || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)
    || (architecture !== 'x64' && architecture !== 'arm64')) return null;
  const candidate = versions.exec(release.tag_name);
  const current = versions.exec(`v${currentVersion}`);
  if (candidate === null || current === null) return null;
  const difference = candidate.slice(1).map((part, index) => BigInt(part) - BigInt(current[index + 1]!)).find((part) => part !== 0n);
  if (difference === undefined || difference < 0n) return null;
  const version = release.tag_name.slice(1);
  const name = `lnwjud-${version}-${architecture}.${extension}`;
  const url = `${repository}/releases/download/${release.tag_name}/${name}`;
  return release.assets.some((asset: unknown) => isRecord(asset) && asset.name === name
    && asset.state === 'uploaded' && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0
    && asset.browser_download_url === url) ? { version, url } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
