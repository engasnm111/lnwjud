import path from 'node:path';
import { parseExtensionsSettings } from './allowlist.js';
import { LocalExtensionsService } from './extensions-service.js';
import type { McpClientFactory } from './mcp-session-manager.js';
import type { ExtensionsService } from './types.js';

export const EXTENSIONS_SETTINGS_KEY = 'extensions';

export interface CreateLocalExtensionsOptions {
  readonly settingsJson?: string | null;
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRootProvider?: () => Promise<string | undefined>;
  readonly bundledSkillRoots?: readonly string[];
  readonly clientFactory?: McpClientFactory;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export function createLocalExtensionsService(options: CreateLocalExtensionsOptions = {}): ExtensionsService {
  return new LocalExtensionsService({
    settings: parseExtensionsSettings(options.settingsJson),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.appDataDir === undefined ? {} : { appDataDir: options.appDataDir }),
    ...(options.workspaceRootProvider === undefined ? {} : { workspaceRootProvider: options.workspaceRootProvider }),
    bundledSkillRoots: options.bundledSkillRoots ?? bundledSkillRootCandidates(),
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}

export function bundledSkillRootCandidates(
  resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
  executablePath = process.execPath,
): readonly string[] {
  const candidates = [
    typeof resourcesPath === 'string' && resourcesPath.trim().length > 0
      ? path.join(resourcesPath, 'agent-skills')
      : undefined,
    path.join(path.dirname(executablePath), 'resources', 'agent-skills'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}
