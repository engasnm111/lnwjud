import { DEFAULT_EXTENSIONS_SETTINGS, type ExtensionsSettings, type McpServerLaunchConfig } from './types.js';

export function parseExtensionsSettings(raw: string | null | undefined): ExtensionsSettings {
  if (raw === undefined || raw === null || raw.trim().length === 0) return DEFAULT_EXTENSIONS_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_EXTENSIONS_SETTINGS;
    const record = parsed as Record<string, unknown>;
    const mode = record.mode === 'allowlist' ? 'allowlist' : 'enable_all';
    return {
      mode,
      disabledServers: stringArray(record.disabledServers),
      enabledServers: stringArray(record.enabledServers),
      disabledSkillRoots: stringArray(record.disabledSkillRoots),
      extraSkillRoots: stringArray(record.extraSkillRoots),
      extraMcpServers: mcpServerMap(record.extraMcpServers),
    };
  } catch {
    return DEFAULT_EXTENSIONS_SETTINGS;
  }
}

export function isServerEnabled(name: string, settings: ExtensionsSettings): boolean {
  const normalized = name.trim().toLowerCase();
  if (settings.disabledServers.some((entry) => entry.trim().toLowerCase() === normalized)) return false;
  if (settings.mode === 'allowlist') {
    return settings.enabledServers.some((entry) => entry.trim().toLowerCase() === normalized);
  }
  return true;
}

export function isSkillRootEnabled(rootPath: string, settings: ExtensionsSettings): boolean {
  const normalized = normalizePathKey(rootPath);
  return !settings.disabledSkillRoots.some((entry) => normalizePathKey(entry) === normalized);
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function mcpServerMap(value: unknown): Readonly<Record<string, McpServerLaunchConfig>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, McpServerLaunchConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    const config = asLaunchConfig(name, entry);
    if (config !== undefined) result[name] = config;
  }
  return result;
}

function asLaunchConfig(name: string, value: unknown): McpServerLaunchConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.trim().length === 0) return undefined;
  const parsedArgs = Array.isArray(record.args) ? record.args.filter((entry): entry is string => typeof entry === 'string') : undefined;
  const args = parsedArgs === undefined ? undefined : repairLegacySerenaArgs(name, record.command, parsedArgs);
  const env = typeof record.env === 'object' && record.env !== null && !Array.isArray(record.env)
    ? Object.fromEntries(Object.entries(record.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  return {
    command: record.command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
  };
}

const SERENA_BOOLEAN_FLAGS = new Set([
  '--enable-web-dashboard',
  '--enable-gui-log-window',
  '--open-web-dashboard',
  '--trace-lsp-communication',
]);

function repairLegacySerenaArgs(name: string, command: string, args: readonly string[]): readonly string[] {
  if (name.trim().toLowerCase() !== 'serena') return args;
  if (!/(?:^|[\\/])serena(?:\.exe)?$/i.test(command.trim())) return args;
  if (!args.includes('start-mcp-server')) return args;

  const repaired: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    repaired.push(argument);
    if (!SERENA_BOOLEAN_FLAGS.has(argument)) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) repaired.push('false');
  }
  return repaired;
}

function normalizePathKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
