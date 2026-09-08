import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PORTABLE_UPDATE_FEED_URL = 'https://github.com/engasnm111/lnwjud/releases/latest/download/';
export const PORTABLE_UPDATE_CHANNEL = 'portable';

export type WindowsDistribution = 'installer' | 'portable';
export type UpdaterDistribution = WindowsDistribution | 'macos' | 'linux-appimage' | 'unsupported';

export interface AutoUpdaterFeedAdapter {
  disableDifferentialDownload: boolean;
  setFeedURL(options: {
    readonly provider: 'generic';
    readonly url: string;
    readonly channel: string;
    readonly useMultipleRangeRequest: boolean;
  }): void;
}

export interface PreparedPortableReplacement {
  readonly scriptPath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly powershellPath: string;
}

export interface PreparePortableReplacementOptions {
  readonly downloadedFile: string;
  readonly currentExecutablePath: string;
  readonly tempDirectory?: string;
  readonly processId?: number;
}

export function detectWindowsDistribution(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WindowsDistribution {
  if (!isPackaged || platform !== 'win32') return 'installer';
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  return portableExecutable === undefined || portableExecutable.length === 0 ? 'installer' : 'portable';
}

/**
 * Select an updater only for installation formats electron-updater can safely
 * own. Linux DEB installs remain package-manager controlled; they must not
 * enter the Windows portable replacement path or consume a `latest.yml`
 * feed. A packaged AppImage is identified by electron-builder's APPIMAGE
 * environment marker.
 */
export function detectUpdaterDistribution(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): UpdaterDistribution {
  if (!isPackaged) return 'unsupported';
  if (platform === 'win32') return detectWindowsDistribution(true, environment, platform);
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux' && environment.APPIMAGE?.trim()) return 'linux-appimage';
  return 'unsupported';
}

export function currentPortableExecutablePath(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackExecutablePath: string = process.execPath,
): string {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  return portableExecutable === undefined || portableExecutable.length === 0
    ? fallbackExecutablePath
    : portableExecutable;
}

export function configureUpdaterForDistribution(
  updater: AutoUpdaterFeedAdapter,
  distribution: WindowsDistribution,
): void {
  if (distribution !== 'portable') return;
  updater.disableDifferentialDownload = true;
  updater.setFeedURL({
    provider: 'generic',
    url: PORTABLE_UPDATE_FEED_URL,
    channel: PORTABLE_UPDATE_CHANNEL,
    useMultipleRangeRequest: false,
  });
}

/** Configure only distribution-specific safeguards; native macOS/Linux feeds use electron-builder metadata. */
export function configureUpdaterForPlatform(
  updater: AutoUpdaterFeedAdapter,
  distribution: UpdaterDistribution,
): void {
  if (distribution === 'portable') {
    configureUpdaterForDistribution(updater, distribution);
    return;
  }
  if (distribution === 'linux-appimage') {
    // AppImage updates are full-file replacements. Differential blockmaps
    // are not a supported contract for this portable Linux distribution.
    updater.disableDifferentialDownload = true;
  }
}

export async function preparePortableReplacement(
  options: PreparePortableReplacementOptions,
): Promise<PreparedPortableReplacement> {
  const sourcePath = path.resolve(options.downloadedFile);
  const targetPath = path.resolve(options.currentExecutablePath);
  if (path.extname(sourcePath).toLowerCase() !== '.exe' || path.extname(targetPath).toLowerCase() !== '.exe') {
    throw new Error('Portable update source and target must be Windows executables');
  }
  if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error('Portable update source must be staged separately from the running executable');
  }
  await access(sourcePath);

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || systemRoot.trim().length === 0) {
    throw new Error('Windows system root is unavailable; cannot prepare the portable updater safely');
  }
  const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await access(powershellPath);

  const tempDirectory = options.tempDirectory ?? path.join(os.tmpdir(), 'lnwjud-portable-update');
  await mkdir(tempDirectory, { recursive: true });
  const processId = options.processId ?? process.pid;
  const scriptPath = path.join(tempDirectory, `replace-${processId}-${Date.now()}.ps1`);
  await writeFile(scriptPath, portableReplacementScript(), { encoding: 'utf8', flag: 'wx' });
  return { scriptPath, sourcePath, targetPath, powershellPath };
}

export function launchPortableReplacement(
  prepared: PreparedPortableReplacement,
  processId: number = process.pid,
): void {
  const child = spawn(prepared.powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    prepared.scriptPath,
    '-CurrentPid',
    String(processId),
    '-Source',
    prepared.sourcePath,
    '-Target',
    prepared.targetPath,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

export function portableReplacementScript(): string {
  return `param(
  [Parameter(Mandatory = $true)][int]$CurrentPid,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$backup = "$Target.lnwjud-update-backup"
try {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue)) {
    throw 'Timed out waiting for lnwjud portable process to exit.'
  }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw 'Downloaded portable update is missing.' }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'Current portable executable is missing.' }
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $Target -Destination $backup -Force
  try {
    Move-Item -LiteralPath $Source -Destination $Target -Force
    Start-Process -FilePath $Target | Out-Null
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
  catch {
    if (Test-Path -LiteralPath $backup -PathType Leaf) {
      Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $backup -Destination $Target -Force
      Start-Process -FilePath $Target | Out-Null
    }
    throw
  }
}
finally {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}
