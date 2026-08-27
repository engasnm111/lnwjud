import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

// Direct local stdio hosts still use the packaged launcher helpers below. Secure
// Tunnel itself targets the live Desktop loopback HTTP MCP so the host-selected
// Active Project and native exact-action approval remain authoritative.
const COMMAND_LINE = /(command:\s*)"[^"]*"/i;
const PACKAGED_EXECUTABLE = 'lnwjud.exe';
const PACKAGED_STDIO_LAUNCHER = 'lnwjud-mcp-stdio.cmd';
const RUNTIME_API_KEY_REF = 'env:CONTROL_PLANE_API_KEY';

export function posixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function rewriteTunnelYamlMcpCommand(yaml: string, stdioCmdPath: string): string {
  const quoted = `"${posixPath(stdioCmdPath)}"`;
  if (!COMMAND_LINE.test(yaml)) return yaml;
  return yaml.replace(COMMAND_LINE, `command: ${quoted}`);
}

export function rewriteTunnelYamlMcpServerUrl(yaml: string, serverUrl: string): string {
  const normalized = normalizeLoopbackMcpUrl(serverUrl);
  const json = parseJsonProfile(yaml);
  if (json !== null) {
    const mcp = asJsonRecord(json.mcp) ?? {};
    const existingUrls = Array.isArray(mcp.server_urls) ? mcp.server_urls : [];
    const nextUrls: unknown[] = [];
    let replacedMain = false;
    for (const entry of existingUrls) {
      const record = asJsonRecord(entry);
      if (record === null) {
        nextUrls.push(entry);
        continue;
      }
      if (!replacedMain && String(record.channel ?? '').toLowerCase() === 'main') {
        nextUrls.push({ ...record, channel: 'main', url: normalized });
        replacedMain = true;
      } else {
        nextUrls.push(record);
      }
    }
    if (!replacedMain) nextUrls.push({ channel: 'main', url: normalized });
    mcp.connection_max_ttl = '168h0m0s';
    mcp.server_urls = nextUrls;
    delete mcp.commands;
    json.mcp = mcp;
    return serializeJsonProfile(json, yaml);
  }
  return replaceTopLevelBlock(yaml, 'mcp', [
    'mcp:',
    '  connection_max_ttl: 168h0m0s',
    '  server_urls:',
    '    - channel: main',
    `      url: ${JSON.stringify(normalized)}`,
  ]);
}

export function rewriteTunnelYamlRuntimeApiKeyRef(yaml: string): string {
  const json = parseJsonProfile(yaml);
  if (json !== null) {
    const controlPlane = asJsonRecord(json.control_plane);
    if (controlPlane === null) return yaml;
    controlPlane.api_key = RUNTIME_API_KEY_REF;
    json.control_plane = controlPlane;
    return serializeJsonProfile(json, yaml);
  }

  const parsed = splitYaml(yaml);
  const range = findTopLevelBlock(parsed.lines, 'control_plane');
  if (range === null) return yaml;

  const next = [...parsed.lines];
  const apiKeyIndex = next.findIndex((line, index) => (
    index > range.start && index < range.end && /^\s+api_key\s*:/i.test(line)
  ));
  const replacement = `  api_key: ${JSON.stringify(RUNTIME_API_KEY_REF)}`;
  if (apiKeyIndex >= 0) next[apiKeyIndex] = replacement;
  else next.splice(range.end, 0, replacement);
  return joinYaml(next, parsed.newline, parsed.trailingNewline);
}

export function extractTunnelId(yaml: string): string | null {
  const json = parseJsonProfile(yaml);
  if (json !== null) {
    const controlPlane = asJsonRecord(json.control_plane);
    const tunnelId = controlPlane?.tunnel_id;
    return typeof tunnelId === 'string' && tunnelId.trim().length > 0 ? tunnelId.trim() : null;
  }

  const parsed = splitYaml(yaml);
  const range = findTopLevelBlock(parsed.lines, 'control_plane');
  if (range === null) return null;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = parsed.lines[index]?.match(/^\s+tunnel_id\s*:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/i);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function extractTunnelMcpServerUrl(yaml: string): string | null {
  const json = parseJsonProfile(yaml);
  if (json !== null) {
    const mcp = asJsonRecord(json.mcp);
    const entries = Array.isArray(mcp?.server_urls) ? mcp.server_urls : [];
    const ordered = [...entries].sort((left, right) => {
      const leftMain = String(asJsonRecord(left)?.channel ?? '').toLowerCase() === 'main' ? 0 : 1;
      const rightMain = String(asJsonRecord(right)?.channel ?? '').toLowerCase() === 'main' ? 0 : 1;
      return leftMain - rightMain;
    });
    for (const entry of ordered) {
      const url = asJsonRecord(entry)?.url;
      if (typeof url !== 'string') continue;
      try {
        return normalizeLoopbackMcpUrl(url);
      } catch {
        continue;
      }
    }
    return null;
  }

  const parsed = splitYaml(yaml);
  const range = findTopLevelBlock(parsed.lines, 'mcp');
  if (range === null) return null;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = parsed.lines[index]?.match(/^\s+url\s*:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/i);
    if (match?.[1] === undefined) continue;
    try {
      return normalizeLoopbackMcpUrl(match[1]);
    } catch {
      continue;
    }
  }
  return null;
}

export function normalizeLoopbackMcpUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl.trim());
  if (parsed.protocol !== 'http:') throw new Error('Desktop MCP tunnel target must use loopback HTTP');
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    throw new Error('Desktop MCP tunnel target must be loopback-only');
  }
  if (parsed.pathname !== '/mcp') parsed.pathname = '/mcp';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function resolveStdioLauncherPath(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.trim().length > 0 && existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * The packaged Electron executable uses the GUI subsystem. When a direct local
 * stdio host starts it as a child, its stdio handles can close immediately even
 * though Electron reports that the app is ready. The packaged launcher uses the
 * private Node 24 runtime shipped with lnwjud and keeps the MCP pipe owned by a
 * normal console process without system Node.js.
 *
 * This helper is for direct local stdio integrations only. Secure Tunnel uses the
 * Desktop loopback HTTP MCP and never spawns this launcher.
 *
 * An installed lnwjud.exe must never fall back to a launcher from a developer
 * repository. Installed builds accept only a canonical launcher beside
 * lnwjud.exe or inside that installation's canonical resources directory.
 * Junction or symlink escapes fail closed.
 */
export function preferredTunnelMcpCommand(execPath: string, cmdFallback: string | null): string | null {
  if (cmdFallback === null) return null;
  if (path.win32.basename(execPath).toLowerCase() !== PACKAGED_EXECUTABLE) return cmdFallback;
  if (!existsSync(execPath) || !existsSync(cmdFallback)) return null;

  try {
    const installDirectory = realpathSync.native(path.dirname(execPath));
    const launcher = realpathSync.native(cmdFallback);
    if (path.win32.basename(launcher).toLowerCase() !== PACKAGED_STDIO_LAUNCHER) return null;

    const launcherDirectory = realpathSync.native(path.dirname(launcher));
    if (sameWindowsPath(launcherDirectory, installDirectory)) return launcher;

    const resourcesCandidate = path.join(path.dirname(execPath), 'resources');
    if (!existsSync(resourcesCandidate)) return null;
    const resourcesDirectory = realpathSync.native(resourcesCandidate);
    if (!isCanonicalWithin(installDirectory, resourcesDirectory)) return null;
    return sameWindowsPath(launcherDirectory, resourcesDirectory) ? launcher : null;
  } catch {
    return null;
  }
}

export function packagedStdioLauncherCandidates(execPath: string, resourcesPath?: string): string[] {
  const execDir = path.dirname(execPath);
  const candidates = [
    path.join(execDir, 'lnwjud-mcp-stdio.cmd'),
    path.join(execDir, 'resources', 'lnwjud-mcp-stdio.cmd'),
  ];
  if (typeof resourcesPath === 'string' && resourcesPath.trim().length > 0) {
    candidates.push(path.join(resourcesPath, 'lnwjud-mcp-stdio.cmd'));
  }
  return candidates;
}

type JsonRecord = Record<string, unknown>;

function parseJsonProfile(value: string): JsonRecord | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return asJsonRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function asJsonRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function serializeJsonProfile(profile: JsonRecord, original: string): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(original);
  return JSON.stringify(profile, null, 2).replace(/\n/g, newline) + (trailingNewline ? newline : '');
}

interface SplitYaml {
  readonly lines: string[];
  readonly newline: '\n' | '\r\n';
  readonly trailingNewline: boolean;
}

function splitYaml(yaml: string): SplitYaml {
  const newline = yaml.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(yaml);
  const lines = yaml.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, newline, trailingNewline };
}

function joinYaml(lines: readonly string[], newline: '\n' | '\r\n', trailingNewline: boolean): string {
  return lines.join(newline) + (trailingNewline ? newline : '');
}

function findTopLevelBlock(lines: readonly string[], blockName: string): { readonly start: number; readonly end: number } | null {
  const blockPattern = new RegExp(`^${escapeRegExp(blockName)}\\s*:\\s*(?:#.*)?$`, 'i');
  const start = lines.findIndex((line) => blockPattern.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^[^\s#][^:]*:\s*/.test(line)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function replaceTopLevelBlock(yaml: string, blockName: string, replacement: readonly string[]): string {
  const parsed = splitYaml(yaml);
  const range = findTopLevelBlock(parsed.lines, blockName);
  if (range === null) return yaml;
  const next = [
    ...parsed.lines.slice(0, range.start),
    ...replacement,
    ...parsed.lines.slice(range.end),
  ];
  return joinYaml(next, parsed.newline, parsed.trailingNewline);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function isCanonicalWithin(root: string, candidate: string): boolean {
  const relative = path.win32.relative(path.win32.normalize(root).toLowerCase(), path.win32.normalize(candidate).toLowerCase());
  if (relative === '') return true;
  if (path.win32.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.win32.sep);
  return firstSegment !== '..';
}
