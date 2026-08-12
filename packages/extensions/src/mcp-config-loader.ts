import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isServerEnabled } from './allowlist.js';
import type { DiscoveredMcpServer, ExtensionsSettings, McpServerLaunchConfig } from './types.js';

export interface McpConfigLoaderOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
  readonly settings: ExtensionsSettings;
  readonly env?: NodeJS.ProcessEnv;
}

export class McpConfigLoader {
  public constructor(private readonly options: McpConfigLoaderOptions) {}

  public async discover(): Promise<readonly DiscoveredMcpServer[]> {
    const home = this.options.homeDir ?? os.homedir();
    const appData = this.options.appDataDir ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const discovered: DiscoveredMcpServer[] = [];

    await this.loadFile(
      discovered,
      path.join(home, '.cursor', 'mcp.json'),
      'cursor',
    );
    await this.loadFile(
      discovered,
      path.join(appData, 'Claude', 'claude_desktop_config.json'),
      'claude-desktop',
    );

    for (const [name, config] of Object.entries(this.options.settings.extraMcpServers)) {
      discovered.push(this.toServer(name, 'lnwjud-settings', config));
    }

    return dedupeServers(discovered);
  }

  private async loadFile(target: DiscoveredMcpServer[], filePath: string, source: string): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const record = parsed as Record<string, unknown>;
      const servers = (record.mcpServers ?? record.mcp) as unknown;
      if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return;
      for (const [name, entry] of Object.entries(servers)) {
        const config = normalizeLaunchConfig(entry, this.options.workspaceRoot, this.options.env ?? process.env);
        if (config === undefined) continue;
        target.push(this.toServer(name, source, config));
      }
    } catch {
      // Missing or invalid config files are ignored.
    }
  }

  private toServer(name: string, source: string, config: McpServerLaunchConfig): DiscoveredMcpServer {
    const exclusion = exclusionReason(name, config);
    const enabled = exclusion === undefined && isServerEnabled(name, this.options.settings);
    return {
      name,
      source,
      enabled,
      excluded: exclusion !== undefined,
      ...(exclusion === undefined ? {} : { exclusionReason: exclusion }),
      config,
    };
  }
}

export function normalizeLaunchConfig(
  value: unknown,
  workspaceRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): McpServerLaunchConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.trim().length === 0) return undefined;
  const args = Array.isArray(record.args)
    ? record.args.filter((entry): entry is string => typeof entry === 'string').map((entry) => substitute(entry, workspaceRoot, env))
    : undefined;
  const envConfig = typeof record.env === 'object' && record.env !== null && !Array.isArray(record.env)
    ? Object.fromEntries(
      Object.entries(record.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, entry]) => [key, substitute(entry, workspaceRoot, env)]),
    )
    : undefined;
  return {
    command: substitute(record.command, workspaceRoot, env),
    ...(args === undefined ? {} : { args }),
    ...(envConfig === undefined ? {} : { env: envConfig }),
    ...(typeof record.cwd === 'string' ? { cwd: substitute(record.cwd, workspaceRoot, env) } : {}),
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
  };
}

export function exclusionReason(name: string, config: McpServerLaunchConfig): string | undefined {
  const lowered = name.trim().toLowerCase();
  if (lowered === 'lnwjud' || lowered.startsWith('lnwjud-')) {
    return 'Refusing to aggregate lnwjud itself';
  }
  const command = path.basename(config.command).toLowerCase();
  if (command === 'lnwjud' || command === 'lnwjud.exe' || command.includes('lnwjud')) {
    return 'Refusing to aggregate lnwjud itself';
  }
  const args = (config.args ?? []).join(' ').toLowerCase();
  if (args.includes('--mcp-stdio') && command.includes('lnwjud')) {
    return 'Refusing to aggregate lnwjud itself';
  }
  return undefined;
}

function substitute(value: string, workspaceRoot: string | undefined, env: NodeJS.ProcessEnv): string {
  let result = value;
  if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
    result = result.replaceAll('${workspaceFolder}', workspaceRoot);
  }
  result = result.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '');
  return result;
}

function dedupeServers(servers: readonly DiscoveredMcpServer[]): readonly DiscoveredMcpServer[] {
  const byName = new Map<string, DiscoveredMcpServer>();
  for (const server of servers) {
    const existing = byName.get(server.name);
    if (existing === undefined) {
      byName.set(server.name, server);
      continue;
    }
    // Later sources (settings) override earlier discoveries.
    byName.set(server.name, server);
  }
  return [...byName.values()];
}
