import { existsSync } from 'node:fs';
import path from 'node:path';

export function bundledRuntimeToolDirectories(resourcesPath: string | undefined): readonly string[] {
  if (resourcesPath === undefined || resourcesPath.trim().length === 0) return [];
  return [path.join(resourcesPath, 'runtime-tools', 'ripgrep')];
}

export function prependBundledRuntimeToolsToPath(
  environment: NodeJS.ProcessEnv = process.env,
  resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
  directoryExists: (candidate: string) => boolean = existsSync,
): readonly string[] {
  const bundled = bundledRuntimeToolDirectories(resourcesPath).filter(directoryExists);
  if (bundled.length === 0) return [];

  const key = environment.Path !== undefined ? 'Path' : environment.PATH !== undefined ? 'PATH' : process.platform === 'win32' ? 'Path' : 'PATH';
  const existing = environment[key] ?? '';
  const existingEntries = existing.split(path.delimiter).filter((entry) => entry.length > 0);
  const seen = new Set(existingEntries.map(normalizePathEntry));
  const additions = bundled.filter((entry) => {
    const normalized = normalizePathEntry(entry);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (additions.length === 0) return [];
  environment[key] = [...additions, ...existingEntries].join(path.delimiter);
  return additions;
}

function normalizePathEntry(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
