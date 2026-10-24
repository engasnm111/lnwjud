import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import type { StaleTunnelAliasCleanupRequest } from '@lnwjud/process';
import { lstat, mkdir, open as openFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { reconcileLocalTunnelRuntimeProcesses, type LocalTunnelRuntimeGuardRequest } from './tunnel-runtime-process-guard.js';
import { TunnelAliasRetirementJournal } from './tunnel-runtime-alias-journal.js';
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
  /** Durable backup directory outside app data so interrupted alias removal can be recovered. */
  readonly recoveryDirectory?: string;
  readonly alias?: string;
  readonly execute?: TunnelRuntimeExecutor;
  readonly stopVerifyAttempts?: number;
  readonly stopVerifyIntervalMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly processGuard?: (request: LocalTunnelRuntimeGuardRequest) => Promise<void>;
  readonly clearStaleTunnelAlias?: (request: StaleTunnelAliasCleanupRequest) => Promise<void>;
}

export interface NativeRuntimeConnectRequest {
  readonly tunnelId: string;
  readonly mcpServerUrl: string;
}

export class TunnelRuntimeAdapter {
  private capabilitiesCache: TunnelRuntimeCapabilities | null = null;
  private lastStatus: NativeTunnelRuntimeStatus | null = null;
  private readonly alias: string;
  private readonly execute: TunnelRuntimeExecutor;
  private readonly processGuard: (request: LocalTunnelRuntimeGuardRequest) => Promise<void>;

  public constructor(private readonly options: TunnelRuntimeAdapterOptions) {
    this.alias = options.alias?.trim() || TUNNEL_RUNTIME_ALIAS;
    this.execute = options.execute ?? defaultExecutor;
    this.processGuard = options.processGuard ?? reconcileLocalTunnelRuntimeProcesses;
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

  public async status(forceCli = false): Promise<NativeTunnelRuntimeStatus> {
    if (!forceCli && this.lastStatus?.running === true) {
      const local = await probeLocalRuntimeStatus(this.lastStatus);
      if (local !== null) {
        this.lastStatus = local;
        return local;
      }
    }
    const result = await this.capture(['runtimes', 'status', this.alias, '--json'], 15_000);
    if (!result.ok) {
      const message = normalizedCliMessage(result.stderr, result.stdout);
      if (isUnknownAliasMessage(message)) {
        this.lastStatus = missingRuntime(message);
        return this.lastStatus;
      }
      throw new Error(message || `tunnel-client runtimes status ${this.alias} failed`);
    }
    const parsed = parseNativeRuntimeStatus(result.stdout, result.stderr);
    this.lastStatus = await probeLocalRuntimeStatus(parsed) ?? parsed;
    return this.lastStatus;
  }

  public async connect(request: NativeRuntimeConnectRequest): Promise<NativeTunnelRuntimeStatus> {
    const tunnelId = request.tunnelId.trim();
    if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(tunnelId)) throw new Error('Tunnel ID is invalid');
    const mcpServerUrl = request.mcpServerUrl.trim();
    await this.recoverStoppedAliasRetirement();
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
    this.lastStatus = await probeLocalRuntimeStatus(parsed) ?? parsed;
    await this.ensureSingleProcess(tunnelId, this.lastStatus);
    return this.lastStatus;
  }

  public async ensureSingleProcess(tunnelId: string, status: NativeTunnelRuntimeStatus): Promise<void> {
    await this.recoverStoppedAliasRetirement();
    if (process.platform !== 'win32') return;
    try {
      if (status.running && status.pid === null) throw new Error('Managed tunnel PID is missing; refusing to retire local runtimes without an authoritative owner');
      await this.processGuard({
        clientPath: this.options.clientPath,
        profileDirectory: this.options.profileDirectory,
        alias: this.alias,
        tunnelId,
        keepPid: status.running ? status.pid : null,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`lnwjud could not safely check the local Tunnel processes. Restart Windows, reopen lnwjud, then check the Tunnel status. Details: ${detail}`);
    }
  }

  /**
   * Remove only a confirmed stopped lnwjud local alias. The official v0.0.16
   * "runtimes rm" also removes profile and health files, so snapshot and restore
   * those owned files. It leaves the shared Desktop history log untouched and
   * never deletes the remote tunnel, calls "stop", or targets another alias.
   */
  public async retireStoppedAlias(expectedTunnelId: string): Promise<void> {
    if (this.alias !== TUNNEL_RUNTIME_ALIAS || !/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(expectedTunnelId)) {
      throw new Error('Cannot verify the dedicated lnwjud native runtime alias');
    }
    await this.recoverStoppedAliasRetirement();
    const journal = this.options.recoveryDirectory === undefined
      ? null : new TunnelAliasRetirementJournal(this.options.recoveryDirectory, this.options.profileDirectory);
    // Recover a prior interrupted local removal before trusting profile identity.
    await journal?.recover();
    const status = await this.status(true);
    if (!status.exists) return;
    if (status.processStateEvidence !== 'stopped' || status.running || status.tunnelId !== expectedTunnelId) {
      throw new Error('Native Tunnel alias is active or its identity changed; refusing local alias removal');
    }
    if (status.pid !== null) {
      if (this.options.clearStaleTunnelAlias === undefined) {
        throw new Error('Safe stopped Tunnel record cleanup is unavailable; refusing to stop a historical PID');
      }
      const stateRoot = resolveNativeTunnelStateRoot(this.options.environment);
      const [aliases, processes] = await Promise.all([
        readBoundedRuntimeMetadata(path.join(stateRoot, 'aliases.yaml')),
        readBoundedRuntimeMetadata(path.join(stateRoot, 'processes.yaml')),
      ]);
      await this.options.clearStaleTunnelAlias({
        stateRoot, alias: 'lnwjud', expectedTunnelId, expectedPid: status.pid,
        profileDirectory: path.resolve(this.options.profileDirectory),
        expectedAliasesSha256: createHash('sha256').update(aliases).digest('hex'),
        expectedProcessesSha256: createHash('sha256').update(processes).digest('hex'),
      });
      if ((await this.status(true)).exists) throw new Error('Native Tunnel alias remains after stopped-record cleanup');
      return;
    }
    const directory = path.resolve(this.options.profileDirectory);
    const dirStat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (dirStat !== null && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) {
      throw new Error('Tunnel profile directory is not a trusted directory; refusing alias removal');
    }
    const paths = [
      path.join(directory, 'lnwjud.yaml'),
      path.join(directory, 'lnwjud.runtime.secret'),
      path.join(directory, 'lnwjud.oauth.session.secret'),
    ];
    const profileMeta = await lstat(paths[0]!).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (profileMeta !== null && (!profileMeta.isFile() || profileMeta.isSymbolicLink() || profileMeta.size > 1024 * 1024)) {
      throw new Error('Tunnel profile is unsafe or oversized; refusing alias removal');
    }
    const profile = await readFile(paths[0]!, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (profile !== null) {
      let healthFile: string | null = null;
      try {
        const json = JSON.parse(profile) as { health?: { url_file?: unknown } };
        if (typeof json.health?.url_file === 'string') healthFile = json.health.url_file;
      } catch {
        healthFile = /^\s*url_file\s*:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(profile)?.[1]?.trim() ?? null;
      }
      if (healthFile !== null) {
        const target = path.resolve(directory, healthFile);
        const rel = path.relative(directory, target);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new Error('Tunnel health URL file escapes the lnwjud profile directory');
        }
        paths.push(target);
      }
    }
    const originals: Array<{ file: string; data: Buffer; mode: number }> = [];
    for (const file of paths) {
      for (let parent = path.dirname(file); parent !== directory; parent = path.dirname(parent)) {
        const rel = path.relative(directory, parent);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new Error('Tunnel health artifact escapes the profile directory');
        }
        const ancestor = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (ancestor !== null && (!ancestor.isDirectory() || ancestor.isSymbolicLink())) {
          throw new Error('Tunnel health artifact directory is untrusted; refusing alias removal');
        }
      }
      const meta = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (meta === null) continue;
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 16 * 1024 * 1024) {
        throw new Error('Tunnel profile contains an unsafe or oversized local artifact');
      }
      originals.push({ file, data: await readFile(file), mode: meta.mode & 0o777 });
    }
    // Revalidate immediately before invoking the destructive local CLI operation.
    const recheck = await this.status(true);
    if (!recheck.exists || recheck.processStateEvidence !== 'stopped' || recheck.running || recheck.pid !== null || recheck.tunnelId !== expectedTunnelId) {
      throw new Error('Native Tunnel alias changed before local removal; refusing');
    }
    // Manifest and backups must be persisted before CLI can delete local files.
    await journal?.prepare(originals);
    let failure: unknown = null;
    try {
      const removed = await this.capture(['runtimes', 'rm', this.alias, '--json'], 30_000);
      if (!removed.ok) throw new Error(normalizedCliMessage(removed.stderr, removed.stdout) || 'Local Tunnel alias removal failed');
      const after = await this.status(true);
      if (after.exists) throw new Error('Local Tunnel alias still exists after runtimes rm');
    } catch (error: unknown) {
      failure = error;
    }
    // Recover persisted backups on success or failure; leave the durable journal
    // untouched if restoration fails so the next Desktop start can retry.
    if (journal !== null) {
      await journal.recover();
    } else for (const original of originals) {
      try {
        const currentMeta = await lstat(original.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (currentMeta !== null && (!currentMeta.isFile() || currentMeta.isSymbolicLink())) {
          throw new Error('Concurrent artifact replaced by non-regular file; refusing overwrite');
        }
        const current = await readFile(original.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (current !== null) {
          if (!current.equals(original.data)) throw new Error('Concurrent profile change detected; refusing overwrite');
          continue;
        }
        await mkdir(path.dirname(original.file), { recursive: true });
        await writeFile(original.file, original.data, { flag: 'wx', mode: original.mode });
      } catch (error: unknown) {
        throw new Error(`Local alias cleanup could not restore ${path.basename(original.file)}; do not reset/update until recovery: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failure !== null) throw failure;
  }

  public async recoverStoppedAliasRetirement(): Promise<void> {
    const stateRoot = resolveNativeTunnelStateRoot(this.options.environment);
    if (!existsSync(path.join(stateRoot, '.lnwjud-stale-alias.json'))) return;
    if (this.options.clearStaleTunnelAlias === undefined || this.alias !== TUNNEL_RUNTIME_ALIAS) {
      throw new Error('Stopped Tunnel alias recovery requires the verified native metadata helper');
    }
    await this.options.clearStaleTunnelAlias({
      recoveryOnly: true, stateRoot, alias: 'lnwjud', profileDirectory: path.resolve(this.options.profileDirectory),
    });
  }

  public async stop(tunnelId?: string): Promise<NativeTunnelRuntimeStatus> {
    await this.recoverStoppedAliasRetirement();
    const expectedTunnelId = tunnelId ?? this.lastStatus?.tunnelId ?? null;
    const before = await this.status(true);
    if (!before.exists) {
      if (expectedTunnelId !== null) await this.ensureSingleProcess(expectedTunnelId, before);
      return before;
    }
    if (expectedTunnelId === null || before.tunnelId !== expectedTunnelId || (before.running && before.pid === null)) {
      throw new Error('Native Tunnel ID or running PID cannot be verified for this alias; refusing runtimes stop');
    }
    const result = await this.capture(['runtimes', 'stop', this.alias, '--json'], 30_000);
    if (!result.ok) {
      const message = normalizedCliMessage(result.stderr, result.stdout);
      if (isUnknownAliasMessage(message)) {
        const missing = missingRuntime(message);
        if (expectedTunnelId !== null) await this.ensureSingleProcess(expectedTunnelId, missing);
        return missing;
      }
      throw new Error(message || 'tunnel-client runtimes stop failed');
    }

    const attempts = Math.max(1, Math.min(100, this.options.stopVerifyAttempts ?? DEFAULT_STOP_VERIFY_ATTEMPTS));
    const intervalMs = Math.max(0, Math.min(5_000, this.options.stopVerifyIntervalMs ?? DEFAULT_STOP_VERIFY_INTERVAL_MS));
    const sleep = this.options.sleep ?? delay;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.status(true);
      if (!current.exists || !current.running) {
        if (expectedTunnelId !== null) await this.ensureSingleProcess(expectedTunnelId, current);
        return current;
      }
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

function resolveNativeTunnelStateRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment.TUNNEL_CLIENT_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const home = environment.HOME?.trim() || os.homedir();
  const legacy = [
    ...(environment.CODEX_HOME?.trim() ? [path.join(environment.CODEX_HOME.trim(), 'tunnel-mcp')] : []),
    path.join(home, '.codex', 'tunnel-mcp'), path.join(home, '.tunnel-client'),
  ];
  for (const candidate of legacy) {
    try { if (statSync(candidate).isDirectory()) return path.resolve(candidate); } catch { continue; }
  }
  if (environment.XDG_STATE_HOME?.trim()) return path.resolve(environment.XDG_STATE_HOME.trim(), 'tunnel-client');
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'tunnel-client')
    : path.join(home, '.local', 'state', 'tunnel-client');
}

async function readBoundedRuntimeMetadata(filename: string): Promise<Buffer> {
  const maximum = 1024 * 1024;
  const pathMetadata = await lstat(filename);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1) {
    throw new Error('Tunnel runtime metadata must be an ordinary private file');
  }
  const file = await openFile(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('Tunnel runtime metadata is unsafe or oversized');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error('Tunnel runtime metadata is oversized');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function probeLocalRuntimeStatus(status: NativeTunnelRuntimeStatus): Promise<NativeTunnelRuntimeStatus | null> {
  if (!status.running) return null;
  if (status.pid !== null && !isProcessAlive(status.pid)) return null;
  const baseUrl = await resolveRuntimeHealthBaseUrl(status);
  if (baseUrl === null) return null;
  const [healthz, readyz, adminStatus] = await Promise.all([
    probeLoopbackEndpoint(baseUrl, '/healthz'),
    probeLoopbackEndpoint(baseUrl, '/readyz'),
    probeLoopbackEndpoint(baseUrl, '/api/status', 1_500, 64 * 1024),
  ]);
  if (healthz === null || readyz === null || adminStatus === null) return null;
  const admin = parseAdminRuntimeStatus(adminStatus.body);
  if (admin === null || (status.tunnelId !== null && admin.tunnelId !== status.tunnelId)) return null;
  const legacySystem = await probeLoopbackEndpoint(baseUrl, '/api/system', 1_500, 256 * 1024);
  let pollHealthy = legacySystem === null ? undefined : parseLegacySystemPollHealth(legacySystem.body);
  if (pollHealthy === undefined) {
    const controlPlane = await probeLoopbackEndpoint(baseUrl, '/health/control-plane');
    if (controlPlane === null) return null;
    pollHealthy = parseControlPlaneComponentHealth(controlPlane.body);
  }
  if (pollHealthy === undefined) return null;
  return {
    ...status,
    running: true,
    mcpServerUrl: admin.mcpServerUrl ?? status.mcpServerUrl,
    healthy: healthz.statusCode === 200,
    ready: readyz.statusCode === 200,
    pollHealthy,
  };
}

async function resolveRuntimeHealthBaseUrl(status: NativeTunnelRuntimeStatus): Promise<string | null> {
  let candidate = status.healthUrl?.trim() ?? '';
  if (candidate.length === 0 && status.healthUrlFile !== undefined && status.healthUrlFile !== null) {
    candidate = (await readBoundedHealthUrlFile(status.healthUrlFile))?.trim() ?? '';
  }
  if (candidate.length === 0) return null;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function readBoundedHealthUrlFile(filePath: string): Promise<string | null> {
  try {
    const handle = await openFile(filePath, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size <= 0 || stats.size > 4_096) return null;
      const buffer = Buffer.alloc(Number(stats.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

interface LoopbackProbeResult {
  readonly statusCode: number;
  readonly body: string;
}

function probeLoopbackEndpoint(baseUrl: string, pathname: string, timeoutMs = 1_500, maxBodyBytes = 16 * 1024): Promise<LoopbackProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LoopbackProbeResult | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let url: URL;
    try {
      url = new URL(pathname, `${baseUrl}/`);
    } catch {
      finish(null);
      return;
    }
    const request = httpRequest(url, { method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) request.destroy(new Error('health response exceeded bound'));
      });
      response.once('end', () => finish({ statusCode: response.statusCode ?? 0, body }));
      response.once('error', () => finish(null));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('health request timed out')));
    request.once('error', () => finish(null));
    request.end();
  });
}

function parseAdminRuntimeStatus(body: string): { readonly tunnelId: string; readonly mcpServerUrl: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const value = typeof record.control_plane_tunnel_id === 'string'
      ? record.control_plane_tunnel_id
      : typeof record.tunnel_id === 'string'
        ? record.tunnel_id
        : undefined;
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return null;
    return {
      tunnelId: trimmed,
      mcpServerUrl: typeof record.mcp_server_url === 'string' ? matchMcpUrl(record.mcp_server_url) : null,
    };
  } catch {
    return null;
  }
}

function parseLegacySystemPollHealth(body: string): boolean | null | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const proxyHealth = (parsed as Record<string, unknown>).proxy_health;
    if (!Array.isArray(proxyHealth)) return undefined;
    for (const candidate of proxyHealth) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
      const summary = candidate as Record<string, unknown>;
      const route = summary.route;
      if (typeof route !== 'object' || route === null || Array.isArray(route)) continue;
      const kind = typeof (route as Record<string, unknown>).kind === 'string'
        ? String((route as Record<string, unknown>).kind).toLowerCase()
        : '';
      if (kind !== 'control_plane') continue;
      const state = typeof summary.health_state === 'string' ? summary.health_state.toLowerCase() : '';
      if (state === 'direct' || state === 'healthy') return true;
      if (state === 'unhealthy' || state === 'failed' || state === 'degraded' || state === 'error') return false;
      if (state === 'unknown' || state === '') return null;
      return undefined;
    }
    return null;
  } catch {
    return undefined;
  }
}

function parseControlPlaneComponentHealth(body: string): boolean | null | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    if (status === 'ok') return true;
    if (status === 'degraded') return false;
    if (status === 'unknown' || status === 'disabled') return null;
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function parseNativeRuntimeStatus(stdout: string, stderr = ''): NativeTunnelRuntimeStatus {
  const text = stdout.trim();
  if (text.length === 0) {
    return {
      processStateEvidence: 'unknown',
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
      processStateEvidence: 'unknown',
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
    processStateEvidence: nativeProcessStateEvidence(flat),
    exists: pickBoolean(flat, ['exists', 'known']) ?? true,
    running: pickBoolean(flat, ['process.running', 'runtime.running', 'running', 'process_running']) ?? inferRunning(flat),
    healthy: pickBoolean(flat, ['health.healthy', 'healthy', 'health.live', 'healthz.live', 'health_ok']),
    ready: pickBoolean(flat, ['health.ready', 'ready', 'readyz.ready', 'ready_ok']),
    pollHealthy: pickControlPlanePollHealth(flat),
    tunnelId: pickString(flat, ['tunnel_id', 'tunnel.id', 'tunnelid']) ?? matchTunnelId(text),
    mcpServerUrl: pickRuntimeMcpServerUrl(flat, text),
    pid: pickNumber(flat, ['process.pid', 'pid', 'runtime.pid']),
    uiUrl: pickString(flat, ['ui_url', 'health.ui_url', 'admin_ui_url', 'url']) ?? matchUiUrl(text),
    healthUrl: pickString(flat, ['health_url', 'local.effective_health.url', 'local.effective_health.base_url', 'local.health.url', 'local.health.base_url']),
    healthUrlFile: pickString(flat, ['health_url_file', 'process.health_url_file', 'local.health.path']),
    message: pickString(flat, ['message', 'error', 'status_message']) ?? normalizedCliMessage(stderr),
  };
}

function nativeProcessStateEvidence(flat: ReadonlyMap<string, unknown>): 'running' | 'stopped' | 'unknown' {
  const evidence = new Set<boolean>();
  for (const key of ['process.running', 'runtime.running', 'running', 'process_running', 'local.process_running']) {
    const value = pickBoolean(flat, [key]);
    if (value !== null) evidence.add(value);
  }
  if (evidence.size === 1) return evidence.has(true) ? 'running' : 'stopped';
  if (evidence.size > 1) return 'unknown';
  const state = pickString(flat, ['runtime_state', 'local.runtime_state', 'runtime.state', 'process.state', 'state']);
  if (state !== null && /^(stopped|dead|exited)$/i.test(state)) return 'stopped';
  if (state !== null && /^(running|connected|ready)$/i.test(state)) return 'running';
  return 'unknown';
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
