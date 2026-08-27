import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import {
  TUNNEL_RUNTIME_ALIAS,
  type NativeTunnelRuntimeStatus,
  type TunnelRuntimeCapabilities,
} from './tunnel-runtime-state.js';

const execFileAsync = promisify(execFile);
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_STOP_VERIFY_ATTEMPTS = 20;
const DEFAULT_STOP_VERIFY_INTERVAL_MS = 250;

export interface TunnelRuntimeExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type TunnelRuntimeExecutor = (
  executable: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<TunnelRuntimeExecResult>;

export interface TunnelRuntimeAdapterOptions {
  readonly clientPath: string;
  readonly profileDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly alias?: string;
  readonly execute?: TunnelRuntimeExecutor;
  readonly stopVerifyAttempts?: number;
  readonly stopVerifyIntervalMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface NativeRuntimeConnectRequest {
  readonly tunnelId: string;
  readonly mcpServerUrl: string;
}

export class TunnelRuntimeAdapter {
  private capabilitiesCache: TunnelRuntimeCapabilities | null = null;
  private readonly alias: string;
  private readonly execute: TunnelRuntimeExecutor;

  public constructor(private readonly options: TunnelRuntimeAdapterOptions) {
    this.alias = options.alias?.trim() || TUNNEL_RUNTIME_ALIAS;
    this.execute = options.execute ?? defaultExecutor;
  }

  public runtimeAlias(): string {
    return this.alias;
  }

  public async capabilities(force = false): Promise<TunnelRuntimeCapabilities> {
    if (!force && this.capabilitiesCache !== null) return this.capabilitiesCache;
    const [version, runtimesHelp, connectHelp, healthHelp] = await Promise.all([
      this.capture(['--version'], 10_000),
      this.capture(['runtimes', '--help'], 10_000),
      this.capture(['runtimes', 'connect', '--help'], 10_000),
      this.capture(['health', '--help'], 10_000),
    ]);
    const runtimeText = `${runtimesHelp.stdout}\n${runtimesHelp.stderr}`;
    const connectText = `${connectHelp.stdout}\n${connectHelp.stderr}`;
    const healthText = `${healthHelp.stdout}\n${healthHelp.stderr}`;
    const nativeRuntimes = runtimesHelp.ok && /\bconnect\b/i.test(runtimeText) && /\bstatus\b/i.test(runtimeText) && /\bstop\b/i.test(runtimeText);
    const managedConnect = nativeRuntimes && connectHelp.ok
      && /--alias\b/.test(connectText)
      && /--tunnel-id\b/.test(connectText)
      && /--runtime-api-key\b/.test(connectText)
      && /--mcp-server-url\b/.test(connectText);
    const healthProbe = healthHelp.ok && /\/healthz/i.test(healthText) && /\/readyz/i.test(healthText);
    const pollHealthGate = healthProbe && /--require-control-plane-poll\b/.test(healthText);
    // No overlap/A-B assumption is made from generic managed reconnect support.
    // A future official client must expose an explicit documented/testable handoff
    // surface before this flag can become true.
    const readyBeforeRetire = false;
    const strictZeroDowntime = managedConnect && healthProbe && pollHealthGate && readyBeforeRetire;
    const clientVersion = firstNonEmptyLine(version.stdout, version.stderr);
    this.capabilitiesCache = {
      clientVersion,
      nativeRuntimes,
      managedConnect,
      healthProbe,
      pollHealthGate,
      readyBeforeRetire,
      strictZeroDowntime,
      evidence: strictZeroDowntime
        ? 'official client exposes managed runtime, readiness/poll health, and proven ready-before-retire handoff'
        : readyBeforeRetire
          ? 'managed runtime is available but required health gates are incomplete'
          : 'managed runtime may be available; official client does not expose a proven ready-before-retire overlap primitive',
    };
    return this.capabilitiesCache;
  }

  public async status(): Promise<NativeTunnelRuntimeStatus> {
    const result = await this.capture(['runtimes', 'status', this.alias, '--json'], 15_000);
    if (!result.ok) {
      const message = normalizedCliMessage(result.stderr, result.stdout);
      if (isUnknownAliasMessage(message)) return missingRuntime(message);
      throw new Error(message || `tunnel-client runtimes status ${this.alias} failed`);
    }
    return parseNativeRuntimeStatus(result.stdout, result.stderr);
  }

  public async connect(request: NativeRuntimeConnectRequest): Promise<NativeTunnelRuntimeStatus> {
    const tunnelId = request.tunnelId.trim();
    if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(tunnelId)) throw new Error('Tunnel ID is invalid');
    const mcpServerUrl = request.mcpServerUrl.trim();
    const result = await this.capture([
      'runtimes', 'connect',
      '--alias', this.alias,
      '--tunnel-id', tunnelId,
      '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY',
      '--mcp-server-url', mcpServerUrl,
      '--profile', this.alias,
      '--profile-dir', this.options.profileDirectory,
      '--json',
    ], 90_000);
    if (!result.ok) throw new Error(normalizedCliMessage(result.stderr, result.stdout) || 'tunnel-client runtimes connect failed');
    const parsed = parseNativeRuntimeStatus(result.stdout, result.stderr);
    if (parsed.tunnelId !== null && parsed.tunnelId !== tunnelId) {
      throw new Error(`Native runtime tunnel ID mismatch: expected ${tunnelId}`);
    }
    return parsed;
  }

  public async stop(): Promise<NativeTunnelRuntimeStatus> {
    const result = await this.capture(['runtimes', 'stop', this.alias, '--json'], 30_000);
    if (!result.ok) {
      const message = normalizedCliMessage(result.stderr, result.stdout);
      if (isUnknownAliasMessage(message)) return missingRuntime(message);
      throw new Error(message || 'tunnel-client runtimes stop failed');
    }

    const attempts = Math.max(1, Math.min(100, this.options.stopVerifyAttempts ?? DEFAULT_STOP_VERIFY_ATTEMPTS));
    const intervalMs = Math.max(0, Math.min(5_000, this.options.stopVerifyIntervalMs ?? DEFAULT_STOP_VERIFY_INTERVAL_MS));
    const sleep = this.options.sleep ?? delay;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.status();
      if (!current.exists || !current.running) return current;
      if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
    }
    throw new Error(`Tunnel runtime ${this.alias} is still running after stop`);
  }

  private async capture(args: readonly string[], timeout: number): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
    try {
      const result = await this.execute(this.options.clientPath, args, {
        env: this.options.environment,
        windowsHide: true,
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      });
      return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (error: unknown) {
      const record = asExecError(error);
      return { ok: false, stdout: record.stdout, stderr: record.stderr || record.message };
    }
  }
}

async function defaultExecutor(executable: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<TunnelRuntimeExecResult> {
  const result = await execFileAsync(executable, [...args], options);
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export function parseNativeRuntimeStatus(stdout: string, stderr = ''): NativeTunnelRuntimeStatus {
  const text = stdout.trim();
  if (text.length === 0) {
    return {
      exists: true,
      running: false,
      healthy: null,
      ready: null,
      pollHealthy: null,
      tunnelId: null,
      mcpServerUrl: null,
      pid: null,
      uiUrl: null,
      message: normalizedCliMessage(stderr),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      exists: true,
      running: /\brunning\b/i.test(text) && !/\bnot running\b/i.test(text),
      healthy: wordBoolean(text, 'healthy'),
      ready: wordBoolean(text, 'ready'),
      pollHealthy: pollBoolean(text),
      tunnelId: matchTunnelId(text),
      mcpServerUrl: matchMcpUrl(text),
      pid: matchPid(text),
      uiUrl: matchUiUrl(text),
      message: normalizedCliMessage(stderr, stdout),
    };
  }
  const flat = flattenJson(parsed);
  return {
    exists: pickBoolean(flat, ['exists', 'known']) ?? true,
    running: pickBoolean(flat, ['process.running', 'runtime.running', 'running', 'process_running']) ?? inferRunning(flat),
    healthy: pickBoolean(flat, ['health.healthy', 'healthy', 'health.live', 'healthz.live', 'health_ok']),
    ready: pickBoolean(flat, ['health.ready', 'ready', 'readyz.ready', 'ready_ok']),
    pollHealthy: pickControlPlanePollHealth(flat),
    tunnelId: pickString(flat, ['tunnel_id', 'tunnel.id', 'tunnelid']) ?? matchTunnelId(text),
    mcpServerUrl: pickRuntimeMcpServerUrl(flat, text),
    pid: pickNumber(flat, ['process.pid', 'pid', 'runtime.pid']),
    uiUrl: pickString(flat, ['ui_url', 'health.ui_url', 'admin_ui_url', 'url']) ?? matchUiUrl(text),
    message: pickString(flat, ['message', 'error', 'status_message']) ?? normalizedCliMessage(stderr),
  };
}

function missingRuntime(message: string | null): NativeTunnelRuntimeStatus {
  return {
    exists: false,
    running: false,
    healthy: null,
    ready: null,
    pollHealthy: null,
    tunnelId: null,
    mcpServerUrl: null,
    pid: null,
    uiUrl: null,
    message,
  };
}

function flattenJson(value: unknown, prefix = '', output: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenJson(entry, prefix.length === 0 ? String(index) : `${prefix}.${index}`, output));
    return output;
  }
  if (typeof value !== 'object' || value === null) {
    if (prefix.length > 0) output.set(normalizeKey(prefix), value);
    return output;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix.length === 0 ? key : `${prefix}.${key}`;
    output.set(normalizeKey(next), entry);
    flattenJson(entry, next, output);
  }
  return output;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[-\s]/g, '_');
}

function pickBoolean(flat: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = flat.get(normalizeKey(key));
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (/^(true|yes|ok|healthy|ready|running|live)$/i.test(value.trim())) return true;
      if (/^(false|no|down|unhealthy|not_ready|stopped|dead)$/i.test(value.trim())) return false;
    }
  }
  return null;
}

function pickString(flat: ReadonlyMap<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = flat.get(normalizeKey(key));
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 2048);
  }
  return null;
}

function pickNumber(flat: ReadonlyMap<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = flat.get(normalizeKey(key));
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
  }
  return null;
}

function pickControlPlanePollHealth(flat: ReadonlyMap<string, unknown>): boolean | null {
  const direct = pickBoolean(flat, [
    'control_plane.poll_healthy',
    'controlplanepollhealthy',
    'poll_healthy',
    'pollhealthy',
    'control_plane_poll_healthy',
  ]);
  if (direct !== null) return direct;

  const state = pickString(flat, [
    'control_plane_poll_health.state',
    'local.control_plane_poll_health.state',
    'control_plane.poll_health.state',
  ]);
  if (state === null || /^(unknown|unavailable|not_observable|not-observable)$/i.test(state)) return null;
  if (/^(true|ok|healthy|ready|live|connected)$/i.test(state)) return true;
  if (/^(false|down|unhealthy|failed|error|dead|disconnected)$/i.test(state)) return false;
  return null;
}

function pickRuntimeMcpServerUrl(flat: ReadonlyMap<string, unknown>, text: string): string | null {
  const direct = pickString(flat, ['mcp_server_url', 'mcp.server_url', 'mcp.url', 'server_url']);
  const directMatch = direct === null ? null : matchMcpUrl(direct);
  if (directMatch !== null) return directMatch;

  const targetKind = pickString(flat, ['target_kind', 'process.target_kind', 'runtime.target_kind']);
  if (targetKind === null || /server[_-]?url|mcp/i.test(targetKind)) {
    const target = pickString(flat, ['target_value', 'process.target_value', 'runtime.target_value']);
    const targetMatch = target === null ? null : matchMcpUrl(target);
    if (targetMatch !== null) return targetMatch;
  }
  return matchMcpUrl(text);
}

function inferRunning(flat: ReadonlyMap<string, unknown>): boolean {
  const state = pickString(flat, ['state', 'runtime.state', 'process.state', 'status']);
  return state !== null && /running|connected|ready|healthy/i.test(state) && !/stopped|failed|error|dead/i.test(state);
}

function wordBoolean(text: string, word: string): boolean | null {
  const match = new RegExp(`${word}[^\\r\\n:=]{0,20}[:=]?\\s*(true|false|yes|no|ok|live|down)`, 'i').exec(text);
  if (match?.[1] === undefined) return null;
  return /^(true|yes|ok|live)$/i.test(match[1]);
}

function pollBoolean(text: string): boolean | null {
  const match = /(?:poll|control[-_ ]plane)[^\r\n:=]{0,60}[:=]?\s*(true|false|yes|no|ok|live|down|healthy|unhealthy)/i.exec(text);
  if (match?.[1] === undefined) return null;
  return /^(true|yes|ok|live|healthy)$/i.test(match[1]);
}

function matchTunnelId(text: string): string | null {
  return /\btunnel_[A-Za-z0-9_-]{8,128}\b/.exec(text)?.[0] ?? null;
}

function matchMcpUrl(text: string): string | null {
  return /http:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):\d{1,5}\/mcp\b/i.exec(text)?.[0] ?? null;
}

function matchUiUrl(text: string): string | null {
  return /http:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):\d{1,5}\/ui\b/i.exec(text)?.[0] ?? null;
}

function matchPid(text: string): number | null {
  const value = Number(/\bpid\s*[:=]\s*(\d{1,10})\b/i.exec(text)?.[1]);
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

function isUnknownAliasMessage(message: string | null): boolean {
  return message !== null && /alias .* (?:is not known|not found|does not exist)|run create or connect first/i.test(message);
}

function normalizedCliMessage(...parts: readonly string[]): string | null {
  const value = parts.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(' — ');
  return value.length === 0 ? null : value.replace(/\s+/g, ' ').slice(0, 1024);
}

function firstNonEmptyLine(...parts: readonly string[]): string | null {
  for (const part of parts) {
    const line = part.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
    if (line !== undefined) return line.slice(0, 256);
  }
  return null;
}

function asExecError(error: unknown): { readonly stdout: string; readonly stderr: string; readonly message: string } {
  if (typeof error !== 'object' || error === null) return { stdout: '', stderr: '', message: String(error) };
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return {
    stdout: typeof record.stdout === 'string' ? record.stdout : '',
    stderr: typeof record.stderr === 'string' ? record.stderr : '',
    message: typeof record.message === 'string' ? record.message : 'tunnel-client command failed',
  };
}

export { DEFAULT_EXEC_TIMEOUT_MS };
