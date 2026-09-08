import { existsSync } from 'node:fs';
import path from 'node:path';

export function bundledRuntimeToolDirectories(resourcesPath: string | undefined, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (resourcesPath === undefined || resourcesPath.trim().length === 0) return [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return [
    pathApi.join(resourcesPath, 'runtime-tools', 'ripgrep'),
    pathApi.join(resourcesPath, 'tunnel-client'),
  ];
}

export function prependBundledRuntimeToolsToPath(
  environment: NodeJS.ProcessEnv = process.env,
  resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
  directoryExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const bundled = bundledRuntimeToolDirectories(resourcesPath, platform).filter(directoryExists);
  if (bundled.length === 0) return [];

  const key = environment.Path !== undefined ? 'Path' : environment.PATH !== undefined ? 'PATH' : platform === 'win32' ? 'Path' : 'PATH';
  const existing = environment[key] ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const existingEntries = existing.split(delimiter).filter((entry) => entry.length > 0);
  const seen = new Set(existingEntries.map((entry) => normalizePathEntry(entry, platform)));
  const additions = bundled.filter((entry) => {
    const normalized = normalizePathEntry(entry, platform);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (additions.length === 0) return [];
  environment[key] = [...additions, ...existingEntries].join(delimiter);
  return additions;
}

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
