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
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}
