import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open as openFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import type { TunnelPersistentStatus, TunnelRunState, TunnelStatus } from '@lnwjud/ipc-contracts';
import { probeProcessStart, type ProcessProbeResult } from '@lnwjud/mcp-server';
import { formatTunnelExitMessage, tunnelExitHintFromLog } from './tunnel-exit.js';
import { acquireTunnelLock, readTunnelLock, type TunnelLockAcquisition, type TunnelLockOwner } from './tunnel-lock.js';
import { extractTunnelId, extractTunnelMcpServerUrl, normalizeLoopbackMcpUrl, rewriteTunnelYamlMcpServerUrl, rewriteTunnelYamlRuntimeApiKeyRef } from './tunnel-profile.js';
import { TunnelRuntimeAdapter, type TunnelRuntimeAdapterOptions } from './tunnel-runtime-adapter.js';
import { TunnelRuntimeReconciler, type TunnelRuntimeDesiredState, type TunnelRuntimeReconcilerAdapter } from './tunnel-runtime-reconciler.js';
import { TunnelRuntimeSupervisor } from './tunnel-runtime-supervisor.js';
import { maskTunnelId, TUNNEL_RUNTIME_ALIAS, type TunnelRuntimeSnapshot } from './tunnel-runtime-state.js';

const execFileAsync = promisify(execFile);

const PROFILE_NAME = 'lnwjud';
const SECRET_FILE = 'lnwjud.runtime.secret';
const CLIENT_PATH_SETTING = 'tunnel_client_path';
const MCP_CONNECTION_MAX_TTL = '168h0m0s';
const EXTERNAL_PROBE_TTL_MS = 4_000;
const RESTART_DELAY_MS = 3_000;
const MAX_AUTO_RESTARTS = 5;
const RESTART_WINDOW_MS = 30_000;
const MAX_HEALTH_METADATA_BYTES = 64 * 1024;
const MAX_HEALTH_URL_BYTES = 2 * 1024;
type ExternalTunnelProbe = 'live' | 'gone' | 'unverifiable';

class StartCancelledError extends Error {}

function throwIfStartCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StartCancelledError('Tunnel start was cancelled');
}

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly processStartedAt: string;
}

export interface TunnelControllerOptions {
  readonly getClientPath: () => string | null;
  readonly getBundledClientPath?: () => string | null;
  readonly setClientPath: (value: string) => void;
  readonly getDataPath: () => string;
  readonly getMcpServerUrl?: () => string | null | Promise<string | null>;
  readonly isExternalTunnelRunning?: () => Promise<boolean>;
  readonly verifiedExternalTunnelPids?: () => Promise<readonly number[]>;
  readonly currentLockOwner?: () => Promise<TunnelLockOwner>;
  readonly inspectLockProcess?: (pid: number) => Promise<ProcessProbeResult>;
  readonly stopTimeoutMs?: number;
  readonly escalationTimeoutMs?: number;
  readonly terminateOwnedProcessTree?: (pid: number) => Promise<void>;
  readonly inspectOwnedProcess?: (pid: number) => Promise<ProcessProbeResult>;
  readonly inspectOwnedProcessTree?: (rootPid: number) => Promise<readonly OwnedProcessIdentity[]>;
  readonly decryptSecret?: (encrypted: string) => Promise<string>;
  readonly probeHealthEndpoint?: (host: string, port: number) => Promise<boolean>;
  readonly healthProbeTimeoutMs?: number;
  readonly inspectFileVersion?: (filePath: string) => Promise<string | null>;
  readonly autoReconnect?: () => boolean;
  readonly maxAutoRestarts?: () => number;
  readonly getTunnelId?: () => string | null;
  readonly setTunnelId?: (value: string) => void;
  readonly createRuntimeAdapter?: (options: TunnelRuntimeAdapterOptions) => TunnelRuntimeReconcilerAdapter;
}

export class TunnelController {
  private child: ChildProcess | null = null;
  private ownedChildStartedAt: string | null = null;
  private state: TunnelRunState = 'stopped';
  private message: string | null = null;
  private externalProbeAt = 0;
  private lastExternalProbe: ExternalTunnelProbe = 'unverifiable';
  private foreignOwner: TunnelLockOwner | null = null;
  private intentionalStop = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private restartWindowStartedAt = 0;
  private lastApiKey: string | null = null;
  private tunnelLock: TunnelLockAcquisition | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private startInFlight: Promise<TunnelStatus> | null = null;
  private startAbortController: AbortController | null = null;
  private stopInFlight: Promise<TunnelStatus> | null = null;
  private runtimeSupervisor: TunnelRuntimeSupervisor | null = null;
  private runtimeSnapshot: TunnelRuntimeSnapshot | null = null;
  private runtimeMode: 'native-managed' | 'profile-child' | null = null;

  public constructor(private readonly options: TunnelControllerOptions) {}

  public profileDirectory(): string {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'tunnel-client');
  }

  public secretPath(): string {
    return path.join(this.profileDirectory(), SECRET_FILE);
  }

  public profilePath(): string {
    return path.join(this.profileDirectory(), `${PROFILE_NAME}.yaml`);
  }

  public logPath(): string {
    return path.join(this.profileDirectory(), 'lnwjud-tunnel.log');
  }

  public resolveClientPath(): string | null {
    const configured = this.options.getClientPath();
    if (configured !== null && configured.trim().length > 0 && existsSync(configured)) return configured;
    const bundled = this.options.getBundledClientPath?.() ?? null;
    if (bundled !== null && bundled.trim().length > 0 && existsSync(bundled)) return bundled;
    return configured ?? bundled;
  }

  public async hasApiKey(): Promise<boolean> {
    try {
      const raw = await readFile(this.secretPath(), 'utf8');
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async saveApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error('Runtime API key is required');
    await mkdir(this.profileDirectory(), { recursive: true });
    const encrypted = await encryptWithDpapi(trimmed);
    await writeFile(this.secretPath(), encrypted, 'utf8');
    this.lastApiKey = trimmed;
    if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
  }

  public async configureProfile(tunnelId: string): Promise<string> {
    const normalizedTunnelId = tunnelId.trim();
    if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(normalizedTunnelId)) throw new Error('Tunnel ID is invalid');
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) throw new Error('tunnel-client.exe was not found');
    const mcpServerUrl = await this.requireMcpServerUrl();
    if (!(await this.hasApiKey())) throw new Error('Save a Runtime API key first');
    const encryptedSecret = await readFile(this.secretPath(), 'utf8');
    const apiKey = (await (this.options.decryptSecret?.(encryptedSecret) ?? decryptWithDpapi(encryptedSecret))).trim();
    if (apiKey.length === 0) throw new Error('Saved Runtime API key is empty; save it again in Settings');
    await mkdir(this.profileDirectory(), { recursive: true });
    try {
      await execFileAsync(clientPath, buildTunnelInitArgs(normalizedTunnelId, mcpServerUrl, this.profileDirectory()), {
        env: tunnelClientEnv(apiKey, this.profileDirectory()),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
      });
    } catch (error: unknown) {
      const detail = extractExecDetail(error);
      throw new Error(detail.length > 0 ? detail : 'tunnel-client init failed');
    }
    await this.repairDesktopTunnelProfile();
    await runTunnelDoctor(clientPath, apiKey, this.profileDirectory());
    this.options.setTunnelId?.(normalizedTunnelId);
    this.disposeRuntimeSupervisor();
    return this.profilePath();
  }

  public setClientPath(clientPath: string): string {
    const trimmed = clientPath.trim();
    if (trimmed.length === 0) {
      this.options.setClientPath('');
      if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
      return '';
    }
    const resolved = path.resolve(trimmed);
    if (!existsSync(resolved)) throw new Error('tunnel-client.exe was not found');
    this.options.setClientPath(resolved);
    if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
    return resolved;
  }

  public async status(): Promise<TunnelStatus> {
    const clientPath = this.resolveClientPath();
    if (this.runtimeMode === 'native-managed') {
      const snapshot = this.runtimeSupervisor?.snapshot() ?? this.runtimeSnapshot;
      if (snapshot !== null) return this.statusFromRuntimeSnapshot(snapshot, clientPath);
    }
    let source: TunnelStatus['source'] = 'desktop';
    if (this.child !== null && this.child.exitCode === null) {
      this.state = 'running';
      this.message = null;
    } else if (this.child !== null && this.child.exitCode !== null) {
      this.child = null;
      if (this.state === 'running') this.state = 'stopped';
    } else if (this.tunnelLock === null) {
      // No desktop-owned child: reflect a tunnel started externally (e.g. start-lnwjud-tunnel.ps1).
      const externalProbe = await this.probeExternalRunning();
      if (externalProbe === 'live') {
        this.state = 'running';
        this.message = null;
        source = 'external';
      } else {
        const foreignOwner = await this.verifiedForeignOwner();
        if (foreignOwner !== null) {
          this.state = 'starting';
          this.message = `Tunnel is owned by PID ${foreignOwner.pid}; tunnel process liveness is ${externalProbe === 'unverifiable' ? 'unverifiable' : 'not yet confirmed'}`;
          source = 'external';
        } else if (externalProbe === 'unverifiable') {
          this.state = 'error';
          this.message = 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate';
        } else if (this.state !== 'error' || this.message?.startsWith('Tunnel process liveness is unverifiable') === true) {
          this.state = 'stopped';
          this.message = null;
        }
      }
    }
    return {
      state: this.state,
      source,
      hasApiKey: await this.hasApiKey(),
      clientPath,
      profileExists: existsSync(this.profilePath()),
      message: this.message,
      logPath: this.logPath(),
      persistent: await this.fallbackPersistentStatus(source),
    };
  }

  /**
   * Enrich Doctor diagnostics with the official runtime alias status without
   * taking ownership, reconnecting, or stopping the currently running tunnel.
   */
  public async diagnosticStatus(): Promise<TunnelStatus> {
    const status = await this.status();
    if (status.persistent === null || status.persistent.mode === 'native-managed') return status;
    const clientPath = status.clientPath;
    if (clientPath === null || !existsSync(clientPath)) return status;

    try {
      const observed = await this.createRuntimeAdapter(clientPath, '').status();
      if (!observed.exists) return {
        ...status,
        persistent: { ...status.persistent, runtimeAliasActive: false },
      };
      const savedTunnelId = await this.resolvePersistentTunnelId();
      const mismatch = savedTunnelId !== null && observed.tunnelId !== null && savedTunnelId !== observed.tunnelId;
      const observedRunning = observed.running;
      return {
        ...status,
        state: observedRunning ? 'running' : status.state,
        source: observedRunning ? 'external' : status.source,
        persistent: {
          ...status.persistent,
          runtimeAliasActive: observedRunning,
          state: observedRunning ? 'running' : status.persistent.state,
          healthy: observed.healthy ?? status.persistent.healthy,
          ready: observed.ready ?? status.persistent.ready,
          pollHealthy: observed.pollHealthy ?? status.persistent.pollHealthy,
          localMcpUrl: observed.mcpServerUrl ?? status.persistent.localMcpUrl,
          uiUrl: observed.uiUrl ?? status.persistent.uiUrl,
          lastErrorCode: mismatch ? 'TUNNEL_ID_MISMATCH' : status.persistent.lastErrorCode,
          capabilityEvidence: 'Runtime alias observed read-only via tunnel-client runtimes status; ' + status.persistent.capabilityEvidence,
        },
      };
    } catch {
      return status;
    }
  }

  private invalidateExternalProbeCache(): void {
    this.externalProbeAt = 0;
    this.lastExternalProbe = 'unverifiable';
  }

  private async probeExternalRunning(force = false): Promise<ExternalTunnelProbe> {
    const now = Date.now();
    if (!force && now - this.externalProbeAt < EXTERNAL_PROBE_TTL_MS) return this.lastExternalProbe;
    this.externalProbeAt = now;
    try {
      const result = await (this.options.isExternalTunnelRunning?.() ?? isLnwjudTunnelProcessRunning());
      this.lastExternalProbe = result || await this.configuredHealthIsLive() ? 'live' : 'gone';
    } catch {
      this.lastExternalProbe = await this.configuredHealthIsLive() ? 'live' : 'unverifiable';
    }
    return this.lastExternalProbe;
  }

  private async configuredHealthIsLive(): Promise<boolean> {
    const address = await this.resolveHealthAddress();
    if (address === null) return false;
    try {
      return await (this.options.probeHealthEndpoint?.(address.host, address.port)
        ?? probeLoopbackHealth(address.host, address.port, this.options.healthProbeTimeoutMs ?? 1_500));
    } catch {
      return false;
    }
  }

  public startAutomatically(): Promise<TunnelStatus> {
    if (this.intentionalStop) return this.status();
    return this.start();
  }

  public start(): Promise<TunnelStatus> {
    if (this.startInFlight !== null && this.startAbortController?.signal.aborted !== true) return this.startInFlight;
    const controller = new AbortController();
    const operation = this.enqueueLifecycle(() => this.startOnce(controller.signal));
    const tracked = operation.finally(() => {
      if (this.startInFlight === tracked) this.startInFlight = null;
      if (this.startAbortController === controller) this.startAbortController = null;
    });
    this.startAbortController = controller;
    this.startInFlight = tracked;
    return tracked;
  }

  private async startOnce(signal: AbortSignal): Promise<TunnelStatus> {
    this.intentionalStop = false;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.restartAttempts = 0;
    this.restartWindowStartedAt = 0;
    try {
      throwIfStartCancelled(signal);
      if (this.runtimeMode === 'native-managed' && this.runtimeSupervisor !== null) {
        const result = await this.runtimeSupervisor.kick();
        throwIfStartCancelled(signal);
        if (result !== null) {
          this.runtimeSnapshot = this.runtimeSupervisor.snapshot() ?? result.snapshot;
          this.applyRuntimeSnapshot(this.runtimeSnapshot);
          return this.statusFromRuntimeSnapshot(this.runtimeSnapshot, this.resolveClientPath());
        }
      }
      if (this.state === 'running' || this.state === 'starting') return this.status();
      if (this.child !== null && this.child.exitCode === null) return this.status();
      const externalProbe = this.tunnelLock === null ? await this.probeExternalRunning(true) : 'gone';
      throwIfStartCancelled(signal);
      const managedStatus = await this.tryStartNativeManagedRuntime(externalProbe, signal);
      if (managedStatus !== null) return managedStatus;
      if (externalProbe === 'live') {
        this.state = 'running';
        this.message = null;
        return this.status();
      }
      if (externalProbe === 'unverifiable') {
        const foreignOwner = await this.verifiedForeignOwner();
        throwIfStartCancelled(signal);
        this.state = foreignOwner === null ? 'error' : 'starting';
        this.message = foreignOwner === null
          ? 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate'
          : `Tunnel is owned by PID ${foreignOwner.pid}; tunnel process liveness is unverifiable`;
        return this.status();
      }
      const lockAcquired = await this.ensureTunnelLock();
      throwIfStartCancelled(signal);
      if (!lockAcquired) return this.status();

      const clientPath = this.resolveClientPath();
      if (clientPath === null || !existsSync(clientPath)) throw new Error('tunnel-client.exe was not found');
      const hasApiKey = await this.hasApiKey();
      throwIfStartCancelled(signal);
      if (!hasApiKey) throw new Error('Save a Runtime API key first');
      if (!existsSync(this.profilePath())) throw new Error('Missing tunnel profile lnwjud.yaml');

      const encryptedSecret = await readFile(this.secretPath(), 'utf8');
      throwIfStartCancelled(signal);
      const apiKey = (await (this.options.decryptSecret?.(encryptedSecret) ?? decryptWithDpapi(encryptedSecret))).trim();
      throwIfStartCancelled(signal);
      if (apiKey.length === 0) throw new Error('Saved Runtime API key is empty; save it again in Settings');
      this.lastApiKey = apiKey;
      this.state = 'starting';
      this.message = null;
      await mkdir(this.profileDirectory(), { recursive: true });
      throwIfStartCancelled(signal);
      await this.repairDesktopTunnelProfile();
      throwIfStartCancelled(signal);
      await runTunnelDoctor(clientPath, apiKey, this.profileDirectory());
      throwIfStartCancelled(signal);
      this.runtimeMode = 'profile-child';
      this.spawnRun(clientPath, apiKey);
      this.state = 'running';
      this.scheduleStableReset();
      return this.status();
    } catch (error: unknown) {
      const cancelled = signal.aborted || error instanceof StartCancelledError;
      this.state = cancelled ? 'stopped' : 'error';
      this.message = cancelled ? null : error instanceof Error ? error.message : 'Tunnel setup failed';
      this.lastApiKey = null;
      if (this.child === null || this.child.exitCode !== null) await this.releaseTunnelLock();
      return this.status();
    }
  }

  public stop(): Promise<TunnelStatus> {
    return this.requestStop();
  }

  public stopOwned(): Promise<TunnelStatus> {
    return this.requestStop();
  }

  private requestStop(): Promise<TunnelStatus> {
    this.intentionalStop = true;
    this.clearRestartTimer();
    this.startAbortController?.abort();
    if (this.stopInFlight !== null) return this.stopInFlight;
    const operation = this.enqueueLifecycle(() => this.stopOnce());
    const tracked = operation.finally(() => {
      if (this.stopInFlight === tracked) this.stopInFlight = null;
    });
    this.stopInFlight = tracked;
    return tracked;
  }

  private async stopOnce(): Promise<TunnelStatus> {
    if (this.runtimeMode === 'native-managed' && this.runtimeSupervisor !== null) {
      const result = await this.runtimeSupervisor.stopRuntime();
      if (result !== null && result.snapshot.state !== 'stopped') {
        throw new Error(result.snapshot.message ?? 'Tunnel runtime did not stop');
      }
      this.disposeRuntimeSupervisor();
      this.state = 'stopped';
      this.message = null;
      this.lastApiKey = null;
      this.restartAttempts = 0;
      this.clearStableTimer();
      this.invalidateExternalProbeCache();
      return this.status();
    }
    await this.stopPersistedNativeRuntimeIfOwned();
    await this.killOwnedChild();
    await this.releaseTunnelLock();
    this.state = 'stopped';
    this.message = null;
    this.lastApiKey = null;
    this.restartAttempts = 0;
    this.runtimeMode = null;
    this.clearStableTimer();
    this.invalidateExternalProbeCache();
    return this.status();
  }

  public async shutdownForDesktopExit(): Promise<void> {
    this.intentionalStop = true;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.startAbortController?.abort();
    if (this.runtimeMode === 'native-managed') {
      // Native runtimes are intentionally allowed to survive the short Desktop
      // restart gap. The next Desktop launch reconciles the same alias/tunnel ID
      // to the new loopback MCP URL.
      this.disposeRuntimeSupervisor();
      this.state = 'stopped';
      this.message = null;
      return;
    }
    await this.killOwnedChild();
    await this.releaseTunnelLock();
    this.runtimeMode = null;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async killOwnedChild(): Promise<void> {
    this.intentionalStop = true;
    this.clearRestartTimer();
    if (this.child !== null) {
      const child = this.child;
      if (child.exitCode !== null) {
        if (this.child === child) {
          this.child = null;
          this.ownedChildStartedAt = null;
        }
        return;
      }
      if (!child.kill()) throw new Error('Tunnel child did not accept stop signal; ownership retained');
      try {
        await waitForTunnelChildExit(child, this.options.stopTimeoutMs ?? 5_000);
      } catch (gracefulError: unknown) {
        const pid = child.pid;
        if (!Number.isInteger(pid) || (pid ?? 0) <= 0) throw gracefulError;
        const inspect = this.options.inspectOwnedProcess ?? probeProcessStart;
        if (this.ownedChildStartedAt === null) {
          const identityProbe = await inspect(pid as number);
          if (identityProbe.state === 'gone') {
            if (this.child === child) this.child = null;
            return;
          }
          if (identityProbe.state === 'unverifiable') throw new Error(`Tunnel child liveness is unverifiable (${identityProbe.reason}); ownership retained`);
          throw new Error('Tunnel child process identity was not recorded before shutdown; targeted escalation refused and ownership retained');
        }
        const beforeEscalation = await inspect(pid as number);
        if (beforeEscalation.state === 'gone') {
          if (this.child === child) this.child = null;
          return;
        }
        if (beforeEscalation.state === 'unverifiable') throw new Error(`Tunnel child liveness is unverifiable (${beforeEscalation.reason}); ownership retained`);
        if (beforeEscalation.processStartedAt !== this.ownedChildStartedAt) throw new Error('Tunnel child process identity changed; targeted escalation refused and ownership retained');

        const descendants = await (this.options.inspectOwnedProcessTree?.(pid as number) ?? inspectWindowsProcessTreeIdentities(pid as number));
        const expectedTree = normalizeOwnedProcessTree([
          { pid: pid as number, processStartedAt: this.ownedChildStartedAt },
          ...descendants,
        ]);
        await (this.options.terminateOwnedProcessTree?.(pid as number) ?? terminateWindowsProcessTree(pid as number));
        await waitForTunnelChildExit(child, this.options.escalationTimeoutMs ?? 2_000).catch(() => undefined);
        await verifyOwnedProcessTreeExited(expectedTree, inspect);
      }
      if (this.child === child) {
        this.child = null;
        this.ownedChildStartedAt = null;
      }
    }
  }

  public async incidentHealth(): Promise<{ readonly state: 'live' | 'unhealthy' | 'unavailable' | 'unknown'; readonly message: string | null }> {
    const address = await this.resolveHealthAddress();
    if (address === null) return { state: 'unavailable', message: 'tunnel health endpoint is unavailable from configured profile/log metadata' };
    try {
      const live = await (this.options.probeHealthEndpoint?.(address.host, address.port) ?? probeLoopbackHealth(address.host, address.port, this.options.healthProbeTimeoutMs ?? 1_500));
      return live ? { state: 'live', message: 'configured tunnel health endpoint is live' } : { state: 'unhealthy', message: 'configured tunnel health endpoint did not return live' };
    } catch {
      return { state: 'unhealthy', message: 'configured tunnel health endpoint probe failed' };
    }
  }

  public async clientVersion(): Promise<{ readonly value: string | null; readonly reason: string | null }> {
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) return { value: null, reason: 'configured_tunnel_client_not_found' };
    try {
      const value = await (this.options.inspectFileVersion?.(clientPath) ?? inspectWindowsFileVersion(clientPath));
      return value === null || value.trim().length === 0 ? { value: null, reason: 'file_version_metadata_unavailable' } : { value: value.trim().slice(0, 128), reason: null };
    } catch { return { value: null, reason: 'file_version_metadata_unavailable' }; }
  }

  public async incidentRelevantPids(): Promise<{ readonly pids: readonly number[]; readonly unavailableReason: string | null }> {
    const pids = new Set<number>();
    if (this.child !== null && this.child.exitCode === null && Number.isInteger(this.child.pid) && (this.child.pid ?? 0) > 0) pids.add(this.child.pid as number);
    if (this.tunnelLock !== null) pids.add(this.tunnelLock.owner.pid);
    try {
      const external = await (this.options.verifiedExternalTunnelPids?.() ?? findLnwjudTunnelProcessPids());
      for (const pid of external) if (Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647) pids.add(pid);
    } catch (error: unknown) {
      if (pids.size === 0) return { pids: [], unavailableReason: error instanceof Error ? `external_tunnel_pid_probe_failed:${error.message}` : 'external_tunnel_pid_probe_failed' };
    }
    return pids.size === 0 ? { pids: [], unavailableReason: 'no_verified_tunnel_pid' } : { pids: [...pids], unavailableReason: null };
  }

  private async resolveHealthAddress(): Promise<{ readonly host: string; readonly port: number } | null> {
    try {
      const profile = await readBoundedPrefix(this.profilePath(), MAX_HEALTH_METADATA_BYTES);
      const healthUrlFile = extractHealthUrlFile(profile);
      if (healthUrlFile !== null) {
        const resolvedUrlFile = path.isAbsolute(healthUrlFile) ? healthUrlFile : path.resolve(this.profileDirectory(), healthUrlFile);
        const currentRuntime = toHealthUrlAddress(await readBoundedPrefix(resolvedUrlFile, MAX_HEALTH_URL_BYTES).catch(() => ''));
        if (currentRuntime !== null) return currentRuntime;
      }
      const tail = await readBoundedTail(this.logPath(), MAX_HEALTH_METADATA_BYTES).catch(() => '');
      const runtimeAddresses = [...tail.matchAll(/health(?: server)?[^\r\n]{0,120}?(?:listening|listen_addr)[^\r\n]{0,120}?((?:127\.0\.0\.1|localhost):(\d{1,5}))/ig)]
        .map((match) => toHealthAddress(match[1], match[2]))
        .filter((entry): entry is { readonly host: string; readonly port: number } => entry !== null);
      const newestRuntime = runtimeAddresses.at(-1);
      if (newestRuntime !== undefined) return newestRuntime;
      const configured = /health:\s*[\s\S]{0,300}?listen_addr:\s*["']?((?:127\.0\.0\.1|localhost):(\d{1,5}))/i.exec(profile);
      return configured === null ? null : toHealthAddress(configured[1], configured[2]);
    } catch { return null; }
  }

  private async ensureTunnelLock(): Promise<boolean> {
    if (this.tunnelLock !== null) return true;
    try {
      const claim = await acquireTunnelLock({
        profileDirectory: this.profileDirectory(),
        ...(this.options.currentLockOwner === undefined ? {} : { owner: await this.options.currentLockOwner() }),
        ...(this.options.inspectLockProcess === undefined ? {} : { inspectProcess: this.options.inspectLockProcess }),
      });
      if (!claim.acquired) {
        this.foreignOwner = claim.owner;
        this.state = 'starting';
        this.message = `Tunnel is owned by PID ${claim.owner.pid}; tunnel process liveness is not yet confirmed`;
        return false;
      }
      this.foreignOwner = null;
      this.tunnelLock = claim;
      return true;
    } catch (error: unknown) {
      this.state = 'error';
      this.message = error instanceof Error ? error.message : 'Could not acquire tunnel ownership lock';
      return false;
    }
  }

  private async verifiedForeignOwner(): Promise<TunnelLockOwner | null> {
    const owner = await readTunnelLock(this.profileDirectory());
    if (owner === null) {
      this.foreignOwner = null;
      return null;
    }
    try {
      const probe = await (this.options.inspectLockProcess?.(owner.pid) ?? probeProcessStart(owner.pid));
      this.foreignOwner = probe.state === 'live' && probe.processStartedAt === owner.processStartedAt ? owner : null;
    } catch {
      this.foreignOwner = null;
    }
    return this.foreignOwner;
  }

  private async releaseTunnelLock(): Promise<void> {
    const claim = this.tunnelLock;
    if (claim === null) return;
    if (!(await claim.release())) throw new Error('Tunnel ownership lock release could not be confirmed; ownership retained');
    if (this.tunnelLock === claim) this.tunnelLock = null;
  }

  private spawnRun(clientPath: string, apiKey: string): void {
    const child = spawn(
      clientPath,
      [
        'run',
        '--profile', PROFILE_NAME,
        '--profile-dir', this.profileDirectory(),
        '--log.file', this.logPath(),
        '--mcp.connection-max-ttl', MCP_CONNECTION_MAX_TTL,
      ],
      {
        env: tunnelClientEnv(apiKey, this.profileDirectory()),
        windowsHide: true,
        // detached:true on Windows gives the child its own console window.
        detached: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    this.child = child;
    this.ownedChildStartedAt = null;
    if (Number.isInteger(child.pid) && (child.pid ?? 0) > 0) {
      const childPid = child.pid as number;
      void (this.options.inspectOwnedProcess?.(childPid) ?? probeProcessStart(childPid)).then((probe) => {
        if (this.child === child && probe.state === 'live') this.ownedChildStartedAt = probe.processStartedAt;
      }).catch(() => undefined);
    }
    child.on('error', (error) => {
      if (this.child === child) { this.child = null; this.ownedChildStartedAt = null; }
      this.state = 'error';
      this.message = error.message;
      this.scheduleRestart(clientPath);
    });
    child.on('exit', (code) => {
      if (this.child === child) { this.child = null; this.ownedChildStartedAt = null; }
      if (this.intentionalStop) {
        this.state = 'stopped';
        this.message = null;
        return;
      }
      void this.applyUnexpectedExit(code, clientPath);
    });
  }

  private async applyUnexpectedExit(code: number | null, clientPath: string): Promise<void> {
    const hint = await this.readExitHint();
    this.state = 'error';
    this.message = formatTunnelExitMessage(code, hint);
    const now = Date.now();
    if (this.restartWindowStartedAt === 0 || now - this.restartWindowStartedAt > RESTART_WINDOW_MS) {
      this.restartWindowStartedAt = now;
      this.restartAttempts = 0;
    }
    this.restartAttempts += 1;
    if (!this.autoReconnectEnabled()) return;
    const rapidThreshold = this.maxAutoRestarts();
    if (rapidThreshold > 0 && this.restartAttempts > rapidThreshold) {
      this.message = `${this.message} — reconnect continues with capped backoff after ${rapidThreshold} rapid exits`;
    }
    this.scheduleRestart(clientPath);
  }

  private async readExitHint(): Promise<string> {
    try {
      const raw = await readFile(this.logPath(), 'utf8');
      const tail = raw.split(/\r?\n/).slice(-120).join('\n');
      return tunnelExitHintFromLog(tail);
    } catch {
      return '';
    }
  }

  private scheduleRestart(clientPath: string): void {
    if (this.intentionalStop || !this.autoReconnectEnabled()) return;
    this.clearRestartTimer();
    const delay = Math.min(RESTART_DELAY_MS * (2 ** Math.max(0, this.restartAttempts - 1)), 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.intentionalStop || this.lastApiKey === null) return;
      void this.repairDesktopTunnelProfile()
        .then(() => {
          if (this.intentionalStop || this.lastApiKey === null) return;
          this.spawnRun(clientPath, this.lastApiKey);
          this.state = 'running';
          this.message = `Tunnel reconnecting (attempt ${this.restartAttempts}; retries continue until stopped)…`;
          this.scheduleStableReset();
        })
        .catch(() => undefined);
    }, delay);
  }

  private autoReconnectEnabled(): boolean {
    return this.options.autoReconnect?.() ?? true;
  }

  private maxAutoRestarts(): number {
    const configured = this.options.maxAutoRestarts?.() ?? MAX_AUTO_RESTARTS;
    return Number.isInteger(configured) && configured >= 0 && configured <= 50 ? configured : MAX_AUTO_RESTARTS;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
      this.restartWindowStartedAt = 0;
    }, RESTART_WINDOW_MS);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  public async stopPersistedNativeRuntimeIfOwned(): Promise<boolean> {
    const storedTunnelIdRaw = this.options.getTunnelId?.()?.trim() ?? '';
    const storedTunnelId = /^tunnel_[A-Za-z0-9_-]{8,128}$/.test(storedTunnelIdRaw) ? storedTunnelIdRaw : null;
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) return false;

    const adapter = this.createRuntimeAdapter(clientPath, '');
    if (storedTunnelId === null && adapter.runtimeAlias() !== TUNNEL_RUNTIME_ALIAS) return false;
    let capabilities;
    try {
      capabilities = await adapter.capabilities();
    } catch {
      return false;
    }
    if (!capabilities.nativeRuntimes) return false;

    let nativeStatus;
    try {
      nativeStatus = await adapter.status();
    } catch {
      return false;
    }
    if (!nativeStatus.exists) return false;
    if (storedTunnelId !== null && nativeStatus.tunnelId !== null && nativeStatus.tunnelId !== storedTunnelId) {
      throw new Error('Persistent tunnel alias lnwjud belongs to a different Tunnel ID; refusing to stop it automatically');
    }
    if (nativeStatus.running) await adapter.stop();
    this.invalidateExternalProbeCache();
    return true;
  }

  private createRuntimeAdapter(clientPath: string, apiKey: string): TunnelRuntimeReconcilerAdapter {
    const options: TunnelRuntimeAdapterOptions = {
      clientPath,
      profileDirectory: this.profileDirectory(),
      environment: tunnelClientEnv(apiKey, this.profileDirectory()),
    };
    return this.options.createRuntimeAdapter?.(options) ?? new TunnelRuntimeAdapter(options);
  }

  private async tryStartNativeManagedRuntime(externalProbe: ExternalTunnelProbe, signal: AbortSignal): Promise<TunnelStatus | null> {
    // Native supervision is opt-in at the composition boundary. Legacy/test
    // controllers without persistent identity storage keep the v4.10 fallback.
    if (this.options.getTunnelId === undefined || this.options.setTunnelId === undefined) return null;
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) return null;
    if (!existsSync(this.profilePath())) return null;

    const encryptedSecret = await readFile(this.secretPath(), 'utf8').catch(() => null);
    if (encryptedSecret === null) return null;
    const apiKey = (await (this.options.decryptSecret?.(encryptedSecret) ?? decryptWithDpapi(encryptedSecret))).trim();
    throwIfStartCancelled(signal);
    if (apiKey.length === 0) return null;
    this.lastApiKey = apiKey;

    const desiredTunnelId = await this.resolvePersistentTunnelId();
    if (desiredTunnelId === null) return null;
    await this.requireMcpServerUrl();
    throwIfStartCancelled(signal);

    const adapter = this.createRuntimeAdapter(clientPath, apiKey);
    const capabilities = await adapter.capabilities();
    throwIfStartCancelled(signal);
    if (!capabilities.managedConnect) return null;

    let nativeStatus;
    try {
      nativeStatus = await adapter.status();
    } catch (error: unknown) {
      this.state = 'error';
      this.message = error instanceof Error ? error.message : 'Native tunnel runtime status failed';
      return this.status();
    }
    throwIfStartCancelled(signal);
    // A legacy/profile process may already be running outside native alias
    // supervision. Never create a second tunnel-client in that case.
    if (!nativeStatus.exists && externalProbe === 'live') return null;
    if (!nativeStatus.exists && externalProbe === 'unverifiable') {
      this.state = 'error';
      this.message = 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate';
      return this.status();
    }

    this.disposeRuntimeSupervisor();
    const reconciler = new TunnelRuntimeReconciler({
      adapter,
      desiredState: async (): Promise<TunnelRuntimeDesiredState> => ({
        enabled: this.autoReconnectEnabled(),
        tunnelId: desiredTunnelId,
        mcpServerUrl: await this.requireMcpServerUrl(),
      }),
    });
    const supervisor = new TunnelRuntimeSupervisor({
      reconciler,
      enabled: (): boolean => this.autoReconnectEnabled(),
      onUpdate: (snapshot: TunnelRuntimeSnapshot): void => {
        if (this.runtimeSupervisor !== supervisor) return;
        this.runtimeSnapshot = snapshot;
        this.applyRuntimeSnapshot(snapshot);
      },
    });
    this.runtimeSupervisor = supervisor;
    this.runtimeMode = 'native-managed';
    const result = await supervisor.start();
    throwIfStartCancelled(signal);
    if (result === null) {
      this.disposeRuntimeSupervisor();
      return null;
    }
    if (result.action === 'fallback-required') {
      this.disposeRuntimeSupervisor();
      return null;
    }
    this.runtimeSnapshot = supervisor.snapshot() ?? result.snapshot;
    this.applyRuntimeSnapshot(this.runtimeSnapshot);
    return this.statusFromRuntimeSnapshot(this.runtimeSnapshot, clientPath);
  }

  private async resolvePersistentTunnelId(): Promise<string | null> {
    const stored = this.options.getTunnelId?.()?.trim();
    if (stored !== undefined && stored.length > 0) return stored;
    try {
      const yaml = await readFile(this.profilePath(), 'utf8');
      const tunnelId = extractTunnelId(yaml);
      if (tunnelId !== null) this.options.setTunnelId?.(tunnelId);
      return tunnelId;
    } catch {
      return null;
    }
  }

  private applyRuntimeSnapshot(snapshot: TunnelRuntimeSnapshot): void {
    this.state = snapshot.state === 'running' ? 'running'
      : snapshot.state === 'stopped' ? 'stopped'
        : snapshot.state === 'starting' || snapshot.state === 'reconnecting' ? 'starting'
          : 'error';
    this.message = snapshot.message;
  }

  private async statusFromRuntimeSnapshot(snapshot: TunnelRuntimeSnapshot, clientPath: string | null): Promise<TunnelStatus> {
    this.applyRuntimeSnapshot(snapshot);
    return {
      state: this.state,
      source: 'desktop',
      hasApiKey: await this.hasApiKey(),
      clientPath,
      profileExists: existsSync(this.profilePath()),
      message: this.message,
      logPath: this.logPath(),
      persistent: this.persistentStatusFromSnapshot(snapshot),
    };
  }

  private persistentStatusFromSnapshot(snapshot: TunnelRuntimeSnapshot): TunnelPersistentStatus {
    return {
      enabled: this.autoReconnectEnabled(),
      tunnelIdMasked: maskTunnelId(snapshot.tunnelId),
      runtimeAlias: snapshot.alias,
      runtimeAliasActive: snapshot.state === 'running' || snapshot.state === 'reconnecting',
      mode: snapshot.mode,
      state: snapshot.state,
      healthy: snapshot.healthy,
      ready: snapshot.ready,
      pollHealthy: snapshot.pollHealthy,
      reconnectCount: snapshot.reconnectCount,
      lastConnectedAt: snapshot.lastConnectedAt,
      lastReconnectAt: snapshot.lastReconnectAt,
      nextReconnectAt: snapshot.nextReconnectAt,
      lastErrorCode: snapshot.lastErrorCode,
      clientVersion: snapshot.capabilities.clientVersion,
      localMcpUrl: snapshot.mcpServerUrl,
      uiUrl: snapshot.uiUrl,
      readyBeforeRetire: snapshot.capabilities.readyBeforeRetire,
      strictZeroDowntime: snapshot.capabilities.strictZeroDowntime,
      capabilityEvidence: snapshot.capabilities.evidence,
    };
  }

  private async fallbackPersistentStatus(source: TunnelStatus['source']): Promise<TunnelPersistentStatus | null> {
    const profileExists = existsSync(this.profilePath());
    const tunnelId = profileExists ? await this.resolvePersistentTunnelId() : null;
    if (!profileExists && source !== 'external') return null;
    let localMcpUrl: string | null = null;
    try { localMcpUrl = extractTunnelMcpServerUrl(await readFile(this.profilePath(), 'utf8')); } catch { /* profile unavailable */ }
    return {
      enabled: this.autoReconnectEnabled(),
      tunnelIdMasked: maskTunnelId(tunnelId),
      runtimeAlias: PROFILE_NAME,
      mode: source === 'external' ? 'external' : 'profile-child',
      state: this.state === 'running' ? 'running' : this.state === 'starting' ? 'starting' : this.state === 'error' ? 'error' : 'stopped',
      healthy: null,
      ready: null,
      pollHealthy: null,
      reconnectCount: this.restartAttempts,
      lastConnectedAt: null,
      lastReconnectAt: null,
      nextReconnectAt: null,
      lastErrorCode: this.state === 'error' ? 'PROFILE_RUNTIME_ERROR' : null,
      clientVersion: null,
      localMcpUrl,
      uiUrl: null,
      readyBeforeRetire: false,
      strictZeroDowntime: false,
      capabilityEvidence: 'Compatibility profile runtime; ready-before-retire overlap is not proven',
    };
  }

  private disposeRuntimeSupervisor(): void {
    this.runtimeSupervisor?.dispose();
    this.runtimeSupervisor = null;
    this.runtimeSnapshot = null;
    if (this.runtimeMode === 'native-managed') this.runtimeMode = null;
  }

  private async requireMcpServerUrl(): Promise<string> {
    const value = await this.options.getMcpServerUrl?.();
    if (value === null || value === undefined || value.trim().length === 0) {
      throw new Error('Desktop MCP is unavailable; start lnwjud and try again');
    }
    return normalizeLoopbackMcpUrl(value);
  }

  private async repairDesktopTunnelProfile(): Promise<void> {
    const serverUrl = await this.requireMcpServerUrl();
    const yaml = await readFile(this.profilePath(), 'utf8');
    const withDesktopMcp = rewriteTunnelYamlMcpServerUrl(yaml, serverUrl);
    if (extractTunnelMcpServerUrl(withDesktopMcp) === null) {
      throw new Error('Tunnel profile does not contain a usable Desktop MCP binding; run Configure Tunnel again');
    }
    const next = rewriteTunnelYamlRuntimeApiKeyRef(withDesktopMcp);
    if (next !== yaml) await writeFile(this.profilePath(), next, 'utf8');
  }
}

export { CLIENT_PATH_SETTING };

export function buildTunnelInitArgs(tunnelId: string, mcpServerUrl: string, profileDirectory: string): string[] {
  return [
    'init',
    '--force',
    '--sample', 'sample_mcp_remote_no_auth',
    '--profile', PROFILE_NAME,
    '--profile-dir', profileDirectory,
    '--tunnel-id', tunnelId,
    '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY',
    '--health-listen-addr', '127.0.0.1:0',
    '--mcp-server-url', normalizeLoopbackMcpUrl(mcpServerUrl),
  ];
}

async function encryptWithDpapi(plain: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$plain = [Console]::In.ReadToEnd()',
    '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
    'ConvertFrom-SecureString -SecureString $secure',
  ].join('; ');
  return runPowerShellWithStdin(script, plain);
}

async function decryptWithDpapi(encrypted: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$encrypted = [Console]::In.ReadToEnd().Trim()',
    '$secure = ConvertTo-SecureString -String $encrypted',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('; ');
  return runPowerShellWithStdin(script, encrypted);
}

function runPowerShellWithStdin(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code ?? 'unknown'}`));
        return;
      }
      const value = stdout.replace(/\r?\n$/, '');
      if (value.length === 0) {
        reject(new Error('PowerShell returned an empty result'));
        return;
      }
      resolve(value);
    });
    child.stdin.end(input, 'utf8');
  });
}

export function tunnelClientEnv(apiKey: string, profileDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const userProfile = process.env.USERPROFILE ?? os.homedir();
  const appData = process.env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
  env.CONTROL_PLANE_API_KEY = apiKey.trim();
  env.MCP_CONNECTION_MAX_TTL = MCP_CONNECTION_MAX_TTL;
  // Secure Tunnel forwards to the already-running Desktop HTTP MCP. Do not pass
  // headless lnwjud authorization/scope settings to the transport-only child.
  delete env.LNWJUD_DATA_PATH;
  delete env.LNWJUD_UNRESTRICTED;
  env.TUNNEL_CLIENT_PROFILE = PROFILE_NAME;
  env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;
  env.USERPROFILE = userProfile;
  env.APPDATA = appData;
  env.HOME = userProfile;
  delete env.XDG_CONFIG_HOME;
  return env;
}

async function runTunnelDoctor(clientPath: string, apiKey: string, profileDirectory: string): Promise<void> {
  try {
    await execFileAsync(clientPath, ['doctor', '--profile', PROFILE_NAME, '--profile-dir', profileDirectory, '--explain'], {
      env: tunnelClientEnv(apiKey, profileDirectory),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (error: unknown) {
    const detail = extractExecDetail(error);
    throw new Error(detail.length > 0 ? detail : 'tunnel-client doctor failed');
  }
}

function extractExecDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stderr.length > 0) return stderr.slice(0, 500);
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
  if (stdout.length > 0) return stdout.slice(0, 500);
  return typeof record.message === 'string' ? record.message : '';
}

async function isLnwjudTunnelProcessRunning(): Promise<boolean> {
  return (await findLnwjudTunnelProcessPids()).length > 0;
}

async function findLnwjudTunnelProcessPids(): Promise<readonly number[]> {
  const result = await Promise.race([
    execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'tunnel-client.exe'\" -ErrorAction Stop | Where-Object { $_.CommandLine -match '(?i)(--profile\\s+lnwjud|lnwjud\\.yaml)' } | Select-Object -ExpandProperty ProcessId) -join ','",
    ], { windowsHide: true, encoding: 'utf8', timeout: 3_000 }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('tunnel process probe timed out')), 3_500);
    }),
  ]);
  return result.stdout.trim().split(',').map((value) => Number(value.trim())).filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647);
}

export function waitForTunnelChildExit(child: Pick<ChildProcess, 'exitCode' | 'once' | 'removeListener'>, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Tunnel child exit was not observed; ownership retained'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function inspectWindowsProcessTreeIdentities(rootPid: number): Promise<readonly OwnedProcessIdentity[]> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { if($null -ne $_.CreationDate){ [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; ProcessStartedAt=$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture) } } }",
    "$rows | ConvertTo-Json -Compress",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 3_000,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout.trim() || '[]');
  const rawRows = (Array.isArray(parsed) ? parsed : [parsed]).filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  const rows = rawRows.map((row) => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    processStartedAt: typeof row.ProcessStartedAt === 'string' ? row.ProcessStartedAt : '',
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.parentPid) && row.parentPid >= 0 && validOwnedProcessTimestamp(row.processStartedAt));
  const included = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.pid) || !included.has(row.parentPid)) continue;
      included.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => row.pid !== rootPid && included.has(row.pid)).map((row) => ({ pid: row.pid, processStartedAt: row.processStartedAt }));
}

function normalizeOwnedProcessTree(identities: readonly OwnedProcessIdentity[]): readonly OwnedProcessIdentity[] {
  const normalized = new Map<number, OwnedProcessIdentity>();
  for (const identity of identities) {
    if (!Number.isInteger(identity.pid) || identity.pid <= 0 || identity.pid > 2_147_483_647 || !validOwnedProcessTimestamp(identity.processStartedAt)) {
      throw new Error('Tunnel child process tree identity is invalid; ownership retained');
    }
    const existing = normalized.get(identity.pid);
    if (existing !== undefined && existing.processStartedAt !== identity.processStartedAt) {
      throw new Error('Tunnel child process tree identity is conflicting; ownership retained');
    }
    normalized.set(identity.pid, identity);
  }
  return [...normalized.values()];
}

async function verifyOwnedProcessTreeExited(
  identities: readonly OwnedProcessIdentity[],
  inspect: (pid: number) => Promise<ProcessProbeResult>,
): Promise<void> {
  for (const identity of identities) {
    const probe = await inspect(identity.pid);
    if (probe.state === 'unverifiable') {
      throw new Error(`Tunnel child process tree liveness is unverifiable (${probe.reason}); ownership retained`);
    }
    if (probe.state === 'live' && probe.processStartedAt === identity.processStartedAt) {
      throw new Error(`Tunnel child process tree remained live at PID ${identity.pid} after targeted escalation; ownership retained`);
    }
  }
}

function validOwnedProcessTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 5_000,
    encoding: 'utf8',
  });
}

function probeLoopbackHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      resolve(live);
    };
    const healthRequest = httpRequest({ host, port, path: '/healthz', method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 4_096) healthRequest.destroy(new Error('health response exceeded bound'));
      });
      response.once('end', () => finish(response.statusCode === 200 && isLiveHealthBody(body)));
      response.once('error', () => finish(false));
    });
    deadline = setTimeout(() => {
      healthRequest.destroy(new Error('health request total deadline exceeded'));
      finish(false);
    }, Math.max(1, timeoutMs));
    healthRequest.once('error', () => finish(false));
    healthRequest.end();
  });
}

async function readBoundedTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await openFile(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(maxBytes, stats.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readBoundedPrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await openFile(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(maxBytes, stats.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function toHealthAddress(address: string | undefined, portValue: string | undefined): { readonly host: string; readonly port: number } | null {
  if (address === undefined || portValue === undefined) return null;
  const [host] = address.split(':');
  const port = Number(portValue);
  if ((host !== '127.0.0.1' && host !== 'localhost') || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { host, port };
}

function extractHealthUrlFile(profile: string): string | null {
  try {
    const parsed: unknown = JSON.parse(profile);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const health = (parsed as Record<string, unknown>).health;
      if (typeof health === 'object' && health !== null && !Array.isArray(health)) {
        const value = (health as Record<string, unknown>).url_file;
        if (typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0')) return value.trim();
      }
    }
  } catch { /* YAML profile fallback below */ }
  const match = /^\s*url_file\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\r\n]+))/im.exec(profile);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return value !== undefined && value.length > 0 && value.length <= 4_096 && !value.includes('\0') ? value : null;
}

function toHealthUrlAddress(rawUrl: string): { readonly host: string; readonly port: number } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) return null;
    return toHealthAddress(`${parsed.hostname}:${parsed.port}`, parsed.port);
  } catch {
    return null;
  }
}

function isLiveHealthBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.toLowerCase() === 'live') return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).status === 'string'
      && ((parsed as Record<string, unknown>).status as string).toLowerCase() === 'live';
  } catch {
    return false;
  }
}

async function inspectWindowsFileVersion(filePath: string): Promise<string | null> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$item = Get-Item -LiteralPath $args[0]; $item.VersionInfo.ProductVersion', filePath], { windowsHide: true, timeout: 3_000, encoding: 'utf8' });
  const value = stdout.trim().split(/\r?\n/)[0] ?? '';
  return value.length === 0 ? null : value;
}
