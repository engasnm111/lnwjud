import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open as openFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import type { TunnelAuthStatus, TunnelPersistentStatus, TunnelRunState, TunnelStatus } from '@lnwjud/ipc-contracts';
import { probeProcessStart, type ProcessProbeResult } from '@lnwjud/mcp-server';
import type { SecretProtector } from '@lnwjud/shared';
import { LegacyApiKeyCredentialProvider, type TunnelAuthDiagnostics, type TunnelAuthProvider, type TunnelNetworkErrorDiagnostic } from './tunnel-auth.js';
import { formatTunnelExitMessage, tunnelExitHintFromLog } from './tunnel-exit.js';
import { acquireTunnelLock, readTunnelLock, type TunnelLockAcquisition, type TunnelLockOwner } from './tunnel-lock.js';
import { extractTunnelId, extractTunnelMcpServerUrl, normalizeLoopbackMcpUrl, rewriteTunnelYamlMcpServerUrl, rewriteTunnelYamlRuntimeApiKeyRef } from './tunnel-profile.js';
import { TunnelRuntimeAdapter, type TunnelRuntimeAdapterOptions } from './tunnel-runtime-adapter.js';
import { tunnelAliasRecoveryDirectory } from './tunnel-runtime-alias-journal.js';
import { TunnelRuntimeReconciler, type TunnelRuntimeDesiredState, type TunnelRuntimeReconcilerAdapter } from './tunnel-runtime-reconciler.js';
import { TunnelRuntimeSupervisor } from './tunnel-runtime-supervisor.js';
import { maskTunnelId, TUNNEL_RUNTIME_ALIAS, type TunnelRuntimeSnapshot } from './tunnel-runtime-state.js';

const execFileAsync = promisify(execFile);

const PROFILE_NAME = 'lnwjud';
export const TUNNEL_SECRET_FILE_NAME = 'lnwjud.runtime.secret';
const CLIENT_PATH_SETTING = 'tunnel_client_path';
const MCP_CONNECTION_MAX_TTL = '168h0m0s';
const MCP_MAX_CONCURRENT_REQUESTS = '32';
const EXTERNAL_PROBE_TTL_MS = 4_000;
const RESTART_DELAY_MS = 3_000;
const MAX_AUTO_RESTARTS = 5;
const RESTART_WINDOW_MS = 30_000;
const MAX_HEALTH_METADATA_BYTES = 64 * 1024;
const MAX_HEALTH_URL_BYTES = 2 * 1024;
const MAX_DIAGNOSTIC_STDERR_BYTES = 16 * 1024;
type ExternalTunnelProbe = 'live' | 'gone' | 'unverifiable';

export function resolveTunnelProfileDirectory(environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim();
    const base = appData !== undefined && path.win32.isAbsolute(appData) ? appData : join(homeDirectory, 'AppData', 'Roaming');
    return join(base, 'tunnel-client');
  }
  const dataHome = platform === 'darwin'
    ? join(homeDirectory, 'Library', 'Application Support')
    : (environment.XDG_DATA_HOME?.trim() && path.posix.isAbsolute(environment.XDG_DATA_HOME.trim())
      ? environment.XDG_DATA_HOME.trim()
      : join(homeDirectory, '.local', 'share'));
  return join(dataHome, 'lnwjud', 'tunnel-client');
}

class StartCancelledError extends Error {}

function throwIfStartCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StartCancelledError('Tunnel start was cancelled');
}

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly processStartedAt: string;
}

export interface TunnelControllerOptions {
  readonly platform?: NodeJS.Platform;
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
  readonly terminateOwnedProcessTree?: (pid: number, expectedProcessStartedAt?: string) => Promise<void>;
  readonly inspectOwnedProcess?: (pid: number) => Promise<ProcessProbeResult>;
  readonly inspectOwnedProcessTree?: (rootPid: number) => Promise<readonly OwnedProcessIdentity[]>;
  readonly secretProtector?: SecretProtector;
  readonly encryptSecret?: (plainText: string) => Promise<string>;
  readonly decryptSecret?: (encrypted: string) => Promise<string>;
  /** Optional OAuth-aware/composite provider. Defaults to the legacy DPAPI Runtime API key provider. */
  readonly authProvider?: TunnelAuthProvider;
  readonly probeHealthEndpoint?: (host: string, port: number) => Promise<boolean>;
  readonly healthProbeTimeoutMs?: number;
  readonly inspectFileVersion?: (filePath: string) => Promise<string | null>;
  readonly autoReconnect?: () => boolean;
  readonly maxAutoRestarts?: () => number;
  readonly getTunnelId?: () => string | null;
  readonly setTunnelId?: (value: string) => void;
  readonly getRuntimeDesiredState?: () => 'running' | 'stopped' | null;
  readonly setRuntimeDesiredState?: (value: 'running' | 'stopped') => void;
  readonly getRuntimeOwnerPath?: () => string | null;
  readonly setRuntimeOwnerPath?: (value: string) => void;
  readonly createRuntimeAdapter?: (options: TunnelRuntimeAdapterOptions) => TunnelRuntimeReconcilerAdapter;
  readonly clearStaleTunnelAlias?: TunnelRuntimeAdapterOptions['clearStaleTunnelAlias'];
}

export interface TunnelProcessDiagnostics {
  readonly currentPid: number | null;
  readonly lastPid: number | null;
  readonly lastProcessStartedAt: string | null;
  readonly lastExitAt: string | null;
  readonly lastExitCode: number | null;
  readonly lastSignal: string | null;
  readonly lastTerminationReason: 'running' | 'exit' | 'spawn_error' | 'intentional_stop' | 'unknown';
  readonly exitMetadataUnavailableReason: string | null;
  readonly stderrTail: string | null;
  readonly lastSpawnError: string | null;
  readonly webSocketCloseCode: number | null;
  readonly httpStatus: number | null;
  readonly networkError: TunnelNetworkErrorDiagnostic | null;
}

export interface TunnelRestartDiagnostics {
  readonly consecutiveAttempts: number;
  readonly totalAttempts: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly scheduled: boolean;
  readonly lastScheduledAt: string | null;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastResult: 'never' | 'scheduled' | 'started' | 'stable' | 'failed' | 'cancelled';
  readonly lastError: string | null;
}

export interface TunnelIncidentRuntimeDiagnostics {
  readonly process: TunnelProcessDiagnostics;
  readonly restart: TunnelRestartDiagnostics;
  readonly auth: TunnelAuthDiagnostics | null;
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
  private restartAttemptTotal = 0;
  private restartSuccessTotal = 0;
  private restartFailureTotal = 0;
  private restartLastScheduledAt: string | null = null;
  private restartLastStartedAt: string | null = null;
  private restartLastCompletedAt: string | null = null;
  private restartLastResult: TunnelRestartDiagnostics['lastResult'] = 'never';
  private restartLastError: string | null = null;
  private lastChildPid: number | null = null;
  private lastChildStartedAt: string | null = null;
  private lastChildExitAt: string | null = null;
  private lastChildExitCode: number | null = null;
  private lastChildSignal: string | null = null;
  private lastChildTerminationReason: TunnelProcessDiagnostics['lastTerminationReason'] = 'unknown';
  private childStderrTail = '';
  private lastChildSpawnError: string | null = null;
  private lastWebSocketCloseCode: number | null = null;
  private lastHttpStatus: number | null = null;
  private lastNetworkError: TunnelNetworkErrorDiagnostic | null = null;
  private lastApiKey: string | null = null;
  private tunnelLock: TunnelLockAcquisition | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private startInFlight: Promise<TunnelStatus> | null = null;
  private startAbortController: AbortController | null = null;
  private stopInFlight: Promise<TunnelStatus> | null = null;
  private runtimeSupervisor: TunnelRuntimeSupervisor | null = null;
  private runtimeSnapshot: TunnelRuntimeSnapshot | null = null;
  private runtimeMode: 'native-managed' | 'profile-child' | null = null;
  /** Saved credentials/profile/client changed; apply them on the next explicit Start without disrupting edits in progress. */
  private runtimeConfigurationDirty = false;
  private readonly options: TunnelControllerOptions;
  private readonly authProvider: TunnelAuthProvider;

  public constructor(options: TunnelControllerOptions) {
    this.options = options;
    this.authProvider = options.authProvider ?? new LegacyApiKeyCredentialProvider({
      secretPath: (): string => this.secretPath(),
      ...(options.secretProtector === undefined ? {} : { secretProtector: options.secretProtector }),
      ...(options.encryptSecret === undefined ? {} : { encryptSecret: options.encryptSecret }),
      ...(options.decryptSecret === undefined ? {} : { decryptSecret: options.decryptSecret }),
    });
  }

  public profileDirectory(): string {
    return resolveTunnelProfileDirectory(process.env, os.homedir(), this.options.platform ?? process.platform);
  }

  public secretPath(): string {
    return path.join(this.profileDirectory(), TUNNEL_SECRET_FILE_NAME);
  }

  public profilePath(): string {
    return path.join(this.profileDirectory(), `${PROFILE_NAME}.yaml`);
  }

  public logPath(): string {
    return path.join(this.profileDirectory(), 'lnwjud-tunnel.log');
  }

  public resolveClientPath(): string | null {
    const configured = this.options.getClientPath();
    if (configured !== null && configured.trim().length > 0) return configured;
    const bundled = this.options.getBundledClientPath?.() ?? null;
    return bundled;
  }

  public async authStatus(): Promise<TunnelAuthStatus> {
    return this.authProvider.status();
  }

  public async hasApiKey(): Promise<boolean> {
    return (await this.authStatus()).hasLegacyApiKey;
  }

  public async saveApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error('Runtime API key is required');
    await this.authProvider.saveLegacyApiKey(trimmed);
    this.lastApiKey = trimmed;
    this.markAuthConfigurationChanged();
  }

  public markAuthConfigurationChanged(): void {
    this.lastApiKey = null;
    this.runtimeConfigurationDirty = true;
    if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
  }

  public async configureProfile(tunnelId: string): Promise<string> {
    const normalizedTunnelId = tunnelId.trim();
    if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(normalizedTunnelId)) throw new Error('Tunnel ID is invalid');
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) throw new Error('Bundled tunnel-client executable was not found');
    const mcpServerUrl = await this.requireMcpServerUrl();
    const auth = await this.authStatus();
    if (!auth.runtimeCredentialAvailable) throw new Error(auth.message ?? 'Save a Runtime API key first');
    const credential = await this.authProvider.getRuntimeCredential();
    if (credential === null || credential.value.trim().length === 0) throw new Error('Saved Runtime API key is empty; save it again in Settings');
    const apiKey = credential.value.trim();
    await mkdir(this.profileDirectory(), { recursive: true });
    try {
      await execFileAsync(clientPath, buildTunnelInitArgs(normalizedTunnelId, mcpServerUrl, this.profileDirectory()), {
        env: tunnelClientEnv(apiKey, this.profileDirectory(), this.options.platform ?? process.platform),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
      });
    } catch (error: unknown) {
      const detail = extractExecDetail(error);
      throw new Error(detail.length > 0 ? detail : 'tunnel-client init failed');
    }
    await this.repairDesktopTunnelProfile();
    await runTunnelDoctor(clientPath, apiKey, this.profileDirectory(), this.options.platform ?? process.platform);
    this.options.setTunnelId?.(normalizedTunnelId);
    this.runtimeConfigurationDirty = true;
    this.disposeRuntimeSupervisor();
    return this.profilePath();
  }

  public setClientPath(clientPath: string): string {
    const trimmed = clientPath.trim();
    if (trimmed.length === 0) {
      this.options.setClientPath('');
      this.runtimeConfigurationDirty = true;
      if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
      return '';
    }
    const resolved = path.resolve(trimmed);
    if (!existsSync(resolved)) throw new Error('Tunnel-client executable was not found');
    this.options.setClientPath(resolved);
    this.runtimeConfigurationDirty = true;
    if (this.runtimeMode === 'native-managed') this.disposeRuntimeSupervisor();
    return resolved;
  }

  /**
   * Switch the selected tunnel-client without ever running two owners at once.
   * The currently active runtime is stopped and verified through its recorded
   * owner executable before the new selection is committed.
   */
  public async replaceClientPath(clientPath: string): Promise<string> {
    const trimmed = clientPath.trim();
    const next = trimmed.length === 0 ? '' : path.resolve(trimmed);
    if (next.length > 0 && !existsSync(next)) throw new Error('Tunnel-client executable was not found');

    const currentRaw = this.options.getClientPath()?.trim() ?? '';
    const current = currentRaw.length === 0 ? '' : path.resolve(currentRaw);
    if (current.toLowerCase() === next.toLowerCase()) return next;

    const desiredState = this.runtimeDesiredState();
    const status = await this.status();
    const runtimeActive = status.state === 'running'
      || status.state === 'starting'
      || status.persistent?.runtimeAliasActive === true
      || this.runtimeOwnerPath() !== null;
    if (runtimeActive) {
      const stopped = await this.requestStop();
      if (
        stopped.state === 'running'
        || stopped.state === 'starting'
        || stopped.persistent?.runtimeAliasActive === true
      ) {
        throw new Error('Could not positively verify the Persistent Tunnel Runtime stopped; client path was not changed');
      }
      if (
        this.runtimeOwnerPath() !== null
        || (this.child !== null && this.child.exitCode === null)
        || this.tunnelLock !== null
      ) {
        throw new Error(
          `Could not positively verify the recorded Persistent Tunnel Runtime stopped; client path was not changed `
          + `(owner=${this.runtimeOwnerPath() ?? 'none'}, child=${this.child?.pid ?? 'none'}, lock=${this.tunnelLock === null ? 'none' : 'held'})`,
        );
      }
    }

    this.options.setClientPath(next);
    this.runtimeConfigurationDirty = true;
    this.intentionalStop = desiredState === 'stopped';
    return next;
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
          if (this.intentionalStop || this.runtimeDesiredState() === 'stopped') {
            this.state = 'stopped';
            this.message = null;
          } else {
            this.state = 'error';
            this.message = 'Tunnel process liveness is unverifiable; refusing to start a possible duplicate';
          }
        } else if (this.state !== 'error' || this.message?.startsWith('Tunnel process liveness is unverifiable') === true) {
          this.state = 'stopped';
          this.message = null;
        }
      }
    }
    const auth = await this.authStatus();
    return {
      state: this.state,
      source,
      hasApiKey: auth.hasLegacyApiKey,
      authReady: auth.authReady,
      runtimeCredentialAvailable: auth.runtimeCredentialAvailable,
      auth,
      clientPath,
      configuredClientPath: this.options.getClientPath()?.trim() || null,
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
    const ttl = (this.state === 'stopped' || this.state === 'error') ? 15_000 : EXTERNAL_PROBE_TTL_MS;
    if (!force && now - this.externalProbeAt < ttl) return this.lastExternalProbe;
    this.externalProbeAt = now;
    try {
      if (await this.configuredHealthIsLive()) {
        this.lastExternalProbe = 'live';
        return 'live';
      }
      if ((this.options.platform ?? process.platform) === 'win32' && this.options.isExternalTunnelRunning === undefined) {
        const lock = await readTunnelLock(this.profileDirectory());
        if (lock === null) {
          this.lastExternalProbe = 'gone';
          return 'gone';
        }
      }
      const result = await (this.options.isExternalTunnelRunning?.() ?? isLnwjudTunnelProcessRunning(this.options.platform ?? process.platform));
      this.lastExternalProbe = result ? 'live' : 'gone';
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

  public async reconcileStoppedRuntime(): Promise<TunnelStatus | null> {
    if (this.runtimeDesiredState() !== 'stopped') return null;
    const status = await this.status();
    const survivingRuntime = status.state === 'running'
      || status.state === 'starting'
      || status.persistent?.runtimeAliasActive === true
      || this.runtimeOwnerPath() !== null;
    if (survivingRuntime) return this.requestStop();
    return status;
  }

  public async startAutomatically(): Promise<TunnelStatus> {
    const stopped = await this.reconcileStoppedRuntime();
    if (stopped !== null) return stopped;
    if (this.intentionalStop) return this.status();
    return this.startWithIntent(false);
  }

  public start(): Promise<TunnelStatus> {
    this.options.setRuntimeDesiredState?.('running');
    return this.startWithIntent(true);
  }

  private startWithIntent(allowPersistentConfigurationReplacement: boolean): Promise<TunnelStatus> {
    if (this.startInFlight !== null && this.startAbortController?.signal.aborted !== true) return this.startInFlight;
    const controller = new AbortController();
    const operation = this.enqueueLifecycle(() => this.startOnce(controller.signal, allowPersistentConfigurationReplacement));
    const tracked = operation.finally(() => {
      if (this.startInFlight === tracked) this.startInFlight = null;
      if (this.startAbortController === controller) this.startAbortController = null;
    });
    this.startAbortController = controller;
    this.startInFlight = tracked;
    return tracked;
  }

  private async startOnce(signal: AbortSignal, allowPersistentConfigurationReplacement: boolean): Promise<TunnelStatus> {
    this.intentionalStop = false;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.restartAttempts = 0;
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
      // A status probe may have marked a surviving persistent runtime as
      // running/external before Desktop has re-adopted the native alias. Only
      // short-circuit for a process we actually own; otherwise continue into
      // native reconciliation so update/restart can rebind the same Tunnel ID
      // to the current Desktop MCP endpoint without spawning a duplicate.
      if (this.child !== null && this.child.exitCode === null) return this.status();
      const externalProbe = this.tunnelLock === null ? await this.probeExternalRunning(true) : 'gone';
      throwIfStartCancelled(signal);
      const managedStatus = await this.tryStartNativeManagedRuntime(externalProbe, signal, allowPersistentConfigurationReplacement);
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
      if (clientPath === null || !existsSync(clientPath)) throw new Error('Bundled tunnel-client executable was not found');
      const auth = await this.authStatus();
      throwIfStartCancelled(signal);
      if (!auth.runtimeCredentialAvailable) throw new Error(auth.message ?? 'Save a Runtime API key first');
      if (!existsSync(this.profilePath())) throw new Error('Missing tunnel profile lnwjud.yaml');

      const credential = await this.authProvider.getRuntimeCredential();
      throwIfStartCancelled(signal);
      const apiKey = credential?.value.trim() ?? '';
      throwIfStartCancelled(signal);
      if (apiKey.length === 0) throw new Error('Saved Runtime API key is empty; save it again in Settings');
      this.lastApiKey = apiKey;
      this.state = 'starting';
      this.message = null;
      await mkdir(this.profileDirectory(), { recursive: true });
      throwIfStartCancelled(signal);
      await this.repairDesktopTunnelProfile();
      throwIfStartCancelled(signal);
      await runTunnelDoctor(clientPath, apiKey, this.profileDirectory(), this.options.platform ?? process.platform);
      throwIfStartCancelled(signal);
      this.runtimeMode = 'profile-child';
      this.spawnRun(clientPath, apiKey);
      this.state = 'running';
      this.runtimeConfigurationDirty = false;
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
    this.options.setRuntimeDesiredState?.('stopped');
    return this.requestStop();
  }

  public stopOwned(): Promise<TunnelStatus> {
    return this.requestStop();
  }

  /** A user-confirmed factory reset must retire the external native alias before deleting app data. */
  public async prepareFactoryReset(): Promise<void> {
    const configuredPath = this.resolveClientPath();
    const clientPath = configuredPath !== null && existsSync(configuredPath)
      ? configuredPath : this.options.getBundledClientPath?.() ?? null;
    if (clientPath === null || !existsSync(clientPath)) {
      throw new Error('Cannot verify the local persistent Tunnel alias: bundled tunnel-client is unavailable. Reset was not started.');
    }
    const adapter = this.createRuntimeAdapter(clientPath, '');
    const capabilities = await adapter.capabilities();
    if (!capabilities.nativeRuntimes) {
      throw new Error('Cannot verify persistent Tunnel alias state with this tunnel-client. Reset was not started.');
    }
    await adapter.recoverStoppedAliasRetirement?.();
    const initial = await adapter.status();
    if (initial.exists && initial.running) {
      const configuredTunnelId = await this.resolvePersistentTunnelId();
      const savedOwner = this.runtimeOwnerPath();
      if (initial.pid === null || initial.tunnelId === null || initial.tunnelId !== configuredTunnelId
        || (this.runtimeMode !== 'native-managed' && (savedOwner === null || savedOwner !== path.resolve(clientPath)))) {
        throw new Error('Running Tunnel alias identity or process ownership is not verified. Reset did not begin; stop the original owned Tunnel first.');
      }
    }
    await this.stop();
    const status = await adapter.status();
    if (!status.exists) {
      if (await this.probeExternalRunning(true) !== 'gone') {
        throw new Error('Tunnel process still exists without native alias metadata; reset did not begin.');
      }
      return;
    }
    if (status.running || status.pid !== null || status.tunnelId === null) {
      throw new Error('Persistent Tunnel alias is still active or ownership cannot be verified. Stop the owned Tunnel first; reset did not begin.');
    }
    if (await this.probeExternalRunning(true) !== 'gone') {
      throw new Error('Tunnel process liveness is not verified as stopped; reset did not begin.');
    }
    if (adapter.retireStoppedAlias === undefined) {
      throw new Error('The installed tunnel-client cannot safely retire a stopped alias; reset did not begin.');
    }
    await adapter.retireStoppedAlias(status.tunnelId);
    if ((await adapter.status()).exists) {
      throw new Error('Persistent Tunnel alias remains after local cleanup; reset did not begin.');
    }
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
        if (!await this.stopPersistedNativeRuntimeIfOwned()) {
          throw new Error(result.snapshot.message ?? 'Tunnel runtime did not stop');
        }
      }
      this.disposeRuntimeSupervisor();
      this.options.setRuntimeOwnerPath?.('');
      this.state = 'stopped';
      this.message = null;
      this.lastApiKey = null;
      this.restartAttempts = 0;
      this.clearStableTimer();
      this.invalidateExternalProbeCache();
      return this.status();
    }
    await this.killOwnedChild();
    // A profile-child is the positively owned runtime even when the selected
    // client cannot expose native runtime controls. Stop that child first so
    // the persisted-owner reconciliation can safely prove no survivor remains.
    await this.stopPersistedNativeRuntimeIfOwned();
    await this.releaseTunnelLock();
    this.options.setRuntimeOwnerPath?.('');
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
    this.options.setRuntimeOwnerPath?.('');
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
      const platform = this.options.platform ?? process.platform;
      // On POSIX, ChildProcess.kill() is a naked PID signal and can target a
      // reused process group. Require the recorded start identity before any
      // destructive signal and use the group-aware path below.
      if (platform !== 'win32') {
        const pid = child.pid;
        if (!Number.isInteger(pid) || (pid ?? 0) <= 0) throw new Error('Tunnel child PID is unavailable; ownership retained');
        const expectedStartedAt = this.ownedChildStartedAt;
        if (expectedStartedAt === null) throw new Error('Tunnel child process identity was not recorded before shutdown; targeted termination refused and ownership retained');
        const inspect = this.options.inspectOwnedProcess ?? ((candidatePid: number): Promise<ProcessProbeResult> => probeProcessStart(candidatePid, { platform }));
        const beforeTermination = await inspect(pid as number);
        if (beforeTermination.state === 'gone') {
          if (this.child === child) {
            this.child = null;
            this.ownedChildStartedAt = null;
          }
          return;
        }
        if (beforeTermination.state === 'unverifiable') throw new Error(`Tunnel child liveness is unverifiable (${beforeTermination.reason}); ownership retained`);
        if (beforeTermination.processStartedAt !== expectedStartedAt) throw new Error('Tunnel child process identity changed; targeted termination refused and ownership retained');

        const descendants = await (this.options.inspectOwnedProcessTree?.(pid as number) ?? inspectOwnedProcessTreeIdentities(pid as number, platform));
        const expectedTree = normalizeOwnedProcessTree([
          { pid: pid as number, processStartedAt: expectedStartedAt },
          ...descendants,
        ]);
        await (this.options.terminateOwnedProcessTree?.(pid as number, expectedStartedAt) ?? terminateOwnedProcessTree(pid as number, platform, expectedStartedAt));
        await waitForTunnelChildExit(child, this.options.escalationTimeoutMs ?? 2_000).catch(() => undefined);
        await verifyOwnedProcessTreeExited(expectedTree, inspect);
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
      const inspect = this.options.inspectOwnedProcess ?? ((pid: number): Promise<ProcessProbeResult> => probeProcessStart(pid, { platform: this.options.platform ?? process.platform }));
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

        const descendants = await (this.options.inspectOwnedProcessTree?.(pid as number) ?? inspectOwnedProcessTreeIdentities(pid as number, this.options.platform ?? process.platform));
        const expectedTree = normalizeOwnedProcessTree([
          { pid: pid as number, processStartedAt: this.ownedChildStartedAt },
          ...descendants,
        ]);
        await (this.options.terminateOwnedProcessTree?.(pid as number, this.ownedChildStartedAt ?? undefined) ?? terminateOwnedProcessTree(pid as number, platform, this.ownedChildStartedAt ?? undefined));
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
      const metadataValue = await this.options.inspectFileVersion?.(clientPath);
      if (metadataValue !== undefined && metadataValue !== null && metadataValue.trim().length > 0) {
        return { value: metadataValue.trim().slice(0, 128), reason: null };
      }
      const value = await inspectTunnelClientVersion(clientPath, this.options.platform ?? process.platform);
      return value === null || value.trim().length === 0
        ? { value: null, reason: 'file_metadata_and_cli_version_unavailable' }
        : { value: value.trim().slice(0, 128), reason: null };
    } catch (error: unknown) {
      const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {};
      const code = typeof record.code === 'string' ? record.code : null;
      const message = error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : 'unknown';
      return { value: null, reason: `version_probe_failed:${code ?? message}`.slice(0, 256) };
    }
  }

  public async incidentRelevantPids(): Promise<{ readonly pids: readonly number[]; readonly unavailableReason: string | null }> {
    const pids = new Set<number>();
    if (this.child !== null && this.child.exitCode === null && Number.isInteger(this.child.pid) && (this.child.pid ?? 0) > 0) pids.add(this.child.pid as number);
    if (this.tunnelLock !== null) pids.add(this.tunnelLock.owner.pid);
    try {
      const external = await (this.options.verifiedExternalTunnelPids?.() ?? findLnwjudTunnelProcessPids(this.options.platform ?? process.platform));
      for (const pid of external) if (Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647) pids.add(pid);
    } catch (error: unknown) {
      if (pids.size === 0) return { pids: [], unavailableReason: error instanceof Error ? `external_tunnel_pid_probe_failed:${error.message}` : 'external_tunnel_pid_probe_failed' };
    }
    return pids.size === 0 ? { pids: [], unavailableReason: 'no_verified_tunnel_pid' } : { pids: [...pids], unavailableReason: null };
  }

  public incidentRuntimeDiagnostics(): TunnelIncidentRuntimeDiagnostics {
    const managed = this.runtimeMode === 'native-managed' ? this.runtimeSnapshot : null;
    const directCurrentPid = this.child !== null && this.child.exitCode === null && Number.isInteger(this.child.pid) && (this.child.pid ?? 0) > 0
      ? this.child.pid as number
      : null;
    const managedCurrentPid = managed !== null && (managed.state === 'running' || managed.state === 'reconnecting' || managed.state === 'starting')
      ? managed.processPid
      : null;
    const currentPid = directCurrentPid ?? managedCurrentPid;
    const lastPid = this.lastChildPid ?? managed?.lastProcessPid ?? null;
    const nativeSupervisor = this.runtimeMode === 'native-managed' ? this.runtimeSupervisor?.diagnostics() ?? null : null;
    const nativeExitMetadataUnavailable = this.runtimeMode === 'native-managed'
      && this.lastChildExitAt === null
      && currentPid === null;
    return {
      process: {
        currentPid,
        lastPid,
        lastProcessStartedAt: this.lastChildStartedAt,
        lastExitAt: this.lastChildExitAt,
        lastExitCode: this.lastChildExitCode,
        lastSignal: this.lastChildSignal,
        lastTerminationReason: currentPid === null ? this.lastChildTerminationReason : 'running',
        exitMetadataUnavailableReason: nativeExitMetadataUnavailable ? 'native_managed_runtime_does_not_expose_exit_code_signal_or_stderr' : null,
        stderrTail: this.childStderrTail.trim().length === 0 ? null : this.childStderrTail.trim(),
        lastSpawnError: this.lastChildSpawnError,
        webSocketCloseCode: this.lastWebSocketCloseCode,
        httpStatus: this.lastHttpStatus,
        networkError: this.lastNetworkError,
      },
      restart: nativeSupervisor === null ? {
        consecutiveAttempts: this.restartAttempts,
        totalAttempts: this.restartAttemptTotal,
        successCount: this.restartSuccessTotal,
        failureCount: this.restartFailureTotal,
        scheduled: this.restartTimer !== null,
        lastScheduledAt: this.restartLastScheduledAt,
        lastStartedAt: this.restartLastStartedAt,
        lastCompletedAt: this.restartLastCompletedAt,
        lastResult: this.restartLastResult,
        lastError: this.restartLastError,
      } : {
        consecutiveAttempts: managed?.consecutiveFailures ?? 0,
        totalAttempts: nativeSupervisor.restartAttemptCount,
        successCount: nativeSupervisor.restartSuccessCount,
        failureCount: nativeSupervisor.restartFailureCount,
        scheduled: nativeSupervisor.restartScheduled,
        lastScheduledAt: nativeSupervisor.lastScheduledAt,
        lastStartedAt: nativeSupervisor.lastStartedAt,
        lastCompletedAt: nativeSupervisor.lastCompletedAt,
        lastResult: nativeSupervisor.lastResult === 'success' ? 'stable' : nativeSupervisor.lastResult === 'failure' ? 'failed' : nativeSupervisor.lastResult,
        lastError: nativeSupervisor.lastError,
      },
      auth: this.authProvider.diagnostics?.() ?? null,
    };
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
        platform: this.options.platform ?? process.platform,
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
      const probe = await (this.options.inspectLockProcess?.(owner.pid) ?? probeProcessStart(owner.pid, { platform: this.options.platform ?? process.platform }));
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
        env: tunnelClientEnv(apiKey, this.profileDirectory(), this.options.platform ?? process.platform),
        windowsHide: true,
        // detached:true on Windows gives the child its own console window.
        detached: (this.options.platform ?? process.platform) !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    this.child = child;
    this.options.setRuntimeOwnerPath?.(path.resolve(clientPath));
    this.ownedChildStartedAt = null;
    this.childStderrTail = '';
    this.lastChildSpawnError = null;
    this.lastWebSocketCloseCode = null;
    this.lastHttpStatus = null;
    this.lastNetworkError = null;
    this.lastChildExitAt = null;
    this.lastChildExitCode = null;
    this.lastChildSignal = null;
    this.lastChildTerminationReason = 'running';
    this.lastChildStartedAt = new Date().toISOString();
    this.lastChildPid = Number.isInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid as number : null;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = String(chunk);
      this.childStderrTail = appendBoundedTail(this.childStderrTail, text, MAX_DIAGNOSTIC_STDERR_BYTES);
      const transport = parseTransportDiagnostic(text);
      if (transport.webSocketCloseCode !== null) this.lastWebSocketCloseCode = transport.webSocketCloseCode;
      if (transport.httpStatus !== null) this.lastHttpStatus = transport.httpStatus;
      if (transport.networkError !== null) this.lastNetworkError = transport.networkError;
    });
    if (this.lastChildPid !== null) {
      const childPid = this.lastChildPid;
      void (this.options.inspectOwnedProcess?.(childPid) ?? probeProcessStart(childPid, { platform: this.options.platform ?? process.platform })).then((probe) => {
        if (this.child === child && probe.state === 'live') {
          this.ownedChildStartedAt = probe.processStartedAt;
          this.lastChildStartedAt = probe.processStartedAt;
        }
      }).catch(() => undefined);
    }
    let terminalHandled = false;
    const handleTerminal = (code: number | null, signal: string | null, terminationReason: 'exit' | 'spawn_error', errorMessage?: string): void => {
      if (terminalHandled) return;
      terminalHandled = true;
      const exitedAt = new Date().toISOString();
      this.lastChildExitAt = exitedAt;
      this.lastChildExitCode = code;
      this.lastChildSignal = signal;
      this.lastChildTerminationReason = this.intentionalStop ? 'intentional_stop' : terminationReason;
      if (errorMessage !== undefined) {
        this.lastChildSpawnError = errorMessage.slice(0, 512);
        const transport = parseTransportDiagnostic(errorMessage);
        if (transport.webSocketCloseCode !== null) this.lastWebSocketCloseCode = transport.webSocketCloseCode;
        if (transport.httpStatus !== null) this.lastHttpStatus = transport.httpStatus;
        if (transport.networkError !== null) this.lastNetworkError = transport.networkError;
      }
      if (this.restartLastResult === 'started') {
        this.restartFailureTotal += 1;
        this.restartLastCompletedAt = exitedAt;
        this.restartLastResult = 'failed';
        this.restartLastError = errorMessage ?? formatTunnelExitMessage(code, undefined);
      }
      if (this.child === child) { this.child = null; this.ownedChildStartedAt = null; }
      if (this.intentionalStop) {
        this.state = 'stopped';
        this.message = null;
        return;
      }
      void this.applyUnexpectedExit(code, clientPath, errorMessage);
    };
    child.on('error', (error) => { handleTerminal(null, null, 'spawn_error', error.message); });
    child.on('exit', (code, signal) => { handleTerminal(code, signal, 'exit'); });
  }

  private async applyUnexpectedExit(code: number | null, clientPath: string, errorMessage?: string): Promise<void> {
    const hint = await this.readExitHint();
    this.state = 'error';
    this.message = errorMessage ?? formatTunnelExitMessage(code, hint);
    this.restartAttempts += 1;
    if (!this.autoReconnectEnabled() || this.runtimeDesiredState() === 'stopped') {
      this.options.setRuntimeOwnerPath?.('');
      return;
    }
    const rapidThreshold = this.maxAutoRestarts();
    if (rapidThreshold > 0 && this.restartAttempts >= rapidThreshold) {
      this.clearRestartTimer();
      this.message = `${this.message} — automatic restart paused after ${this.restartAttempts} rapid failures. Fix the tunnel configuration and press Start Tunnel to retry.`;
      this.options.setRuntimeOwnerPath?.('');
      return;
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
    const rapidThreshold = this.maxAutoRestarts();
    if (this.intentionalStop || this.runtimeDesiredState() === 'stopped' || !this.autoReconnectEnabled() || (rapidThreshold > 0 && this.restartAttempts >= rapidThreshold)) return;
    this.clearRestartTimer();
    const delay = Math.min(RESTART_DELAY_MS * (2 ** Math.max(0, this.restartAttempts - 1)), 30_000);
    this.restartLastScheduledAt = new Date().toISOString();
    this.restartLastResult = 'scheduled';
    this.restartLastError = null;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.intentionalStop || this.lastApiKey === null) {
        this.restartLastCompletedAt = new Date().toISOString();
        this.restartLastResult = 'cancelled';
        return;
      }
      this.restartAttemptTotal += 1;
      this.restartLastStartedAt = new Date().toISOString();
      this.restartLastResult = 'started';
      void this.repairDesktopTunnelProfile()
        .then(() => {
          if (this.intentionalStop || this.lastApiKey === null) {
            this.restartLastCompletedAt = new Date().toISOString();
            this.restartLastResult = 'cancelled';
            return;
          }
          this.spawnRun(clientPath, this.lastApiKey);
          this.state = 'running';
          this.message = `Tunnel reconnecting (attempt ${this.restartAttempts}; retries continue until stopped)…`;
          this.scheduleStableReset();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Tunnel restart preparation failed';
          this.restartFailureTotal += 1;
          this.restartLastCompletedAt = new Date().toISOString();
          this.restartLastResult = 'failed';
          this.restartLastError = message.slice(0, 512);
          void this.applyUnexpectedExit(null, clientPath, message);
        });
    }, delay);
  }

  private runtimeDesiredState(): 'running' | 'stopped' {
    return this.options.getRuntimeDesiredState?.() === 'stopped' ? 'stopped' : 'running';
  }

  private runtimeOwnerPath(): string | null {
    const value = this.options.getRuntimeOwnerPath?.()?.trim() ?? '';
    return value.length === 0 ? null : path.resolve(value);
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
      if (this.restartLastResult === 'scheduled') {
        this.restartLastCompletedAt = new Date().toISOString();
        this.restartLastResult = 'cancelled';
      }
    }
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (this.restartLastResult === 'started') {
        this.restartSuccessTotal += 1;
        this.restartLastCompletedAt = new Date().toISOString();
        this.restartLastResult = 'stable';
        this.restartLastError = null;
      }
      this.restartAttempts = 0;
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
    const recordedOwner = this.runtimeOwnerPath();
    if (recordedOwner !== null && !existsSync(recordedOwner)) {
      return this.clearRecordedRuntimeOwnerOnlyWhenExternalGone('the recorded owner executable is missing');
    }
    const clientPath = recordedOwner ?? this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) return false;

    const adapter = this.createRuntimeAdapter(clientPath, '');
    if (storedTunnelId === null && adapter.runtimeAlias() !== TUNNEL_RUNTIME_ALIAS) {
      if (recordedOwner !== null) {
        return this.clearRecordedRuntimeOwnerOnlyWhenExternalGone('its dedicated lnwjud alias is unavailable');
      }
      return false;
    }
    let capabilities;
    try {
      capabilities = await adapter.capabilities();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'capability probe failed';
      throw new Error(`Could not verify the recorded Persistent Tunnel Runtime owner through ${clientPath}: ${detail}`);
    }
    if (!capabilities.nativeRuntimes) {
      if (recordedOwner !== null) {
        return this.clearRecordedRuntimeOwnerOnlyWhenExternalGone('its owner does not expose native runtime control');
      }
      return false;
    }

    let nativeStatus;
    try {
      await adapter.recoverStoppedAliasRetirement?.();
      nativeStatus = await adapter.status();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'status probe failed';
      throw new Error(`Could not verify the recorded Persistent Tunnel Runtime owner through ${clientPath}: ${detail}`);
    }
    if (!nativeStatus.exists) {
      if (storedTunnelId !== null) await adapter.ensureSingleProcess?.(storedTunnelId, nativeStatus);
      if (recordedOwner !== null) {
        return this.clearRecordedRuntimeOwnerOnlyWhenExternalGone('the recorded owner reports that the lnwjud alias is absent');
      }
      return false;
    }
    if (storedTunnelId !== null && nativeStatus.tunnelId !== null && nativeStatus.tunnelId !== storedTunnelId) {
      if (nativeStatus.processStateEvidence !== 'stopped' || nativeStatus.running) {
        throw new Error('Persistent tunnel alias lnwjud belongs to a different Tunnel ID; refusing to stop it automatically');
      }
      await adapter.ensureSingleProcess?.(storedTunnelId, nativeStatus);
      if (await this.probeExternalRunning(true) !== 'gone' || adapter.retireStoppedAlias === undefined) {
        throw new Error('Stopped lnwjud Tunnel alias has a different Tunnel ID, but safe cleanup could not be verified. No other runtime was stopped; explicitly stop the original runtime and retry.');
      }
      await adapter.retireStoppedAlias(nativeStatus.tunnelId);
      this.options.setRuntimeOwnerPath?.('');
      this.invalidateExternalProbeCache();
      return true;
    }
    if (nativeStatus.running) {
      if (storedTunnelId === null || nativeStatus.tunnelId !== storedTunnelId || nativeStatus.pid === null
        || recordedOwner === null || recordedOwner !== path.resolve(clientPath)) {
        throw new Error('Running native Tunnel alias ownership is not proven by saved Tunnel ID, owner executable and PID; refusing to stop it automatically');
      }
      const stopped = await adapter.stop(storedTunnelId);
      if (stopped.exists && stopped.running) {
        throw new Error('Could not positively verify the recorded Persistent Tunnel Runtime stopped');
      }
    } else {
      const expectedTunnelId = storedTunnelId ?? nativeStatus.tunnelId;
      if (expectedTunnelId !== null) await adapter.ensureSingleProcess?.(expectedTunnelId, nativeStatus);
    }
    if (recordedOwner !== null) {
      return this.clearRecordedRuntimeOwnerOnlyWhenExternalGone('the recorded owner reports that the lnwjud alias is stopped');
    }
    this.options.setRuntimeOwnerPath?.('');
    this.invalidateExternalProbeCache();
    return true;
  }

  private async clearRecordedRuntimeOwnerOnlyWhenExternalGone(reason: string): Promise<boolean> {
    const externalProbe = await this.probeExternalRunning(true);
    if (externalProbe !== 'gone') {
      throw new Error(`Could not positively verify the recorded Persistent Tunnel Runtime stopped: ${reason}; external liveness is ${externalProbe}`);
    }
    this.options.setRuntimeOwnerPath?.('');
    this.invalidateExternalProbeCache();
    return true;
  }

  private createRuntimeAdapter(clientPath: string, apiKey: string): TunnelRuntimeReconcilerAdapter {
    const options: TunnelRuntimeAdapterOptions = {
      clientPath,
      profileDirectory: this.profileDirectory(),
      recoveryDirectory: tunnelAliasRecoveryDirectory(this.options.getDataPath()),
      environment: tunnelClientEnv(apiKey, this.profileDirectory(), this.options.platform ?? process.platform),
      ...(this.options.clearStaleTunnelAlias === undefined ? {} : { clearStaleTunnelAlias: this.options.clearStaleTunnelAlias }),
    };
    return this.options.createRuntimeAdapter?.(options) ?? new TunnelRuntimeAdapter(options);
  }

  private async tryStartNativeManagedRuntime(
    externalProbe: ExternalTunnelProbe,
    signal: AbortSignal,
    allowPersistentConfigurationReplacement: boolean,
  ): Promise<TunnelStatus | null> {
    // Native supervision is opt-in at the composition boundary. Legacy/test
    // controllers without persistent identity storage keep the v4.10 fallback.
    if (this.options.getTunnelId === undefined || this.options.setTunnelId === undefined) return null;
    const clientPath = this.resolveClientPath();
    if (clientPath === null || !existsSync(clientPath)) return null;
    if (!existsSync(this.profilePath())) return null;

    const auth = await this.authStatus();
    if (!auth.runtimeCredentialAvailable) return null;
    const credential = await this.authProvider.getRuntimeCredential();
    const apiKey = credential?.value.trim() ?? '';
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
    if (allowPersistentConfigurationReplacement) await adapter.recoverStoppedAliasRetirement?.();

    let nativeStatus;
    try {
      nativeStatus = await adapter.status();
    } catch (error: unknown) {
      this.state = 'error';
      this.message = error instanceof Error ? error.message : 'Native tunnel runtime status failed';
      return this.status();
    }
    throwIfStartCancelled(signal);
    const tunnelIdMismatch = nativeStatus.exists && nativeStatus.tunnelId !== null && nativeStatus.tunnelId !== desiredTunnelId;
    const restartPersistentRuntime = allowPersistentConfigurationReplacement
      && nativeStatus.exists
      && (tunnelIdMismatch || this.runtimeConfigurationDirty);
    if (restartPersistentRuntime && tunnelIdMismatch && nativeStatus.running) {
      const message = 'Tunnel ID changed while the current Persistent Tunnel Runtime is still running. Automatic retire-before-ready replacement is refused because the official tunnel-client does not expose a proven ready-before-retire overlap primitive. Stop the existing runtime explicitly, then Start Tunnel again.';
      this.state = 'error';
      this.message = message;
      const status = await this.status();
      return { ...status, state: 'error', message };
    }
    if (restartPersistentRuntime && this.runtimeConfigurationDirty && nativeStatus.running) {
      this.state = 'starting';
      this.message = 'Applying updated tunnel credentials/configuration while preserving the current managed runtime until reconnect readiness is confirmed.';
    }
    // A managed process can outlive the alias metadata after an upgrade. Verify
    // and retire that exact process before treating the external probe as a
    // separate legacy runtime or launching another managed client.
    if (!nativeStatus.exists && externalProbe === 'live') {
      await adapter.ensureSingleProcess?.(desiredTunnelId, nativeStatus);
      this.invalidateExternalProbeCache();
      externalProbe = await this.probeExternalRunning(true);
    }
    // A legacy/profile process may already be running outside native alias
    // supervision. Never create a second tunnel-client in that case. A known
    // native alias remains authoritative even if the generic external probe is live.
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
      allowStoppedTunnelIdReplacement: allowPersistentConfigurationReplacement,
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
    this.options.setRuntimeOwnerPath?.(path.resolve(clientPath));
    this.runtimeSnapshot = supervisor.snapshot() ?? result.snapshot;
    this.applyRuntimeSnapshot(this.runtimeSnapshot);
    if (this.runtimeSnapshot.state === 'running' && (allowPersistentConfigurationReplacement || !this.runtimeConfigurationDirty)) {
      this.runtimeConfigurationDirty = false;
    }
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
    const auth = await this.authStatus();
    return {
      state: this.state,
      source: 'desktop',
      hasApiKey: auth.hasLegacyApiKey,
      authReady: auth.authReady,
      runtimeCredentialAvailable: auth.runtimeCredentialAvailable,
      auth,
      clientPath,
      configuredClientPath: this.options.getClientPath()?.trim() || null,
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

export function tunnelClientEnv(apiKey: string, profileDirectory: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CONTROL_PLANE_API_KEY = apiKey.trim();
  env.MCP_CONNECTION_MAX_TTL = MCP_CONNECTION_MAX_TTL;
  // Three or more AI chats can legitimately fan out several tool calls each.
  // tunnel-client defaults to 10 active MCP requests, which can turn a normal
  // multi-chat burst into queueing/timeout pressure even though Desktop MCP is
  // session-concurrent. Keep one shared tunnel and give it explicit headroom.
  env.MCP_MAX_CONCURRENT_REQUESTS = MCP_MAX_CONCURRENT_REQUESTS;
  // Secure Tunnel forwards to the already-running Desktop HTTP MCP. Do not pass
  // headless lnwjud authorization/scope settings to the transport-only child.
  delete env.LNWJUD_DATA_PATH;
  delete env.LNWJUD_UNRESTRICTED;
  env.TUNNEL_CLIENT_PROFILE = PROFILE_NAME;
  env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;
  if (platform === 'win32') {
    const userProfile = process.env.USERPROFILE ?? os.homedir();
    const appData = process.env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
    env.USERPROFILE = userProfile;
    env.APPDATA = appData;
    env.HOME = userProfile;
    delete env.XDG_CONFIG_HOME;
  } else {
    env.HOME = process.env.HOME ?? os.homedir();
    delete env.USERPROFILE;
    delete env.APPDATA;
  }
  return env;
}

async function runTunnelDoctor(clientPath: string, apiKey: string, profileDirectory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    await execFileAsync(clientPath, ['doctor', '--profile', PROFILE_NAME, '--profile-dir', profileDirectory, '--explain'], {
      env: tunnelClientEnv(apiKey, profileDirectory, platform),
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

async function isLnwjudTunnelProcessRunning(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return (await findLnwjudTunnelProcessPids(platform)).length > 0;
}

async function findLnwjudTunnelProcessPids(platform: NodeJS.Platform = process.platform): Promise<readonly number[]> {
  if (platform !== 'win32') {
    const result = await Promise.race([
      execFileAsync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024 }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('tunnel process probe timed out')), 3_500); }),
    ]);
    const pids: number[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match === null) continue;
      const pid = Number(match[1]);
      const command = match[2]?.trim() ?? '';
      if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) continue;
      if (!/(?:^|[\\/])tunnel-client(?:\s|$)/i.test(command)) continue;
      if (!/(?:--profile\s+(?:"lnwjud"|'lnwjud'|lnwjud)(?:\s|$)|(?:^|[\\/])lnwjud\.ya?ml(?:\s|$))/i.test(command)) continue;
      pids.push(pid);
    }
    return [...new Set(pids)];
  }
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

async function inspectOwnedProcessTreeIdentities(rootPid: number, platform: NodeJS.Platform = process.platform): Promise<readonly OwnedProcessIdentity[]> {
  if (platform !== 'win32') return inspectPosixProcessTreeIdentities(rootPid);
  return inspectWindowsProcessTreeIdentities(rootPid);
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

async function inspectPosixProcessTreeIdentities(rootPid: number): Promise<readonly OwnedProcessIdentity[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const rows: Array<{ readonly pid: number; readonly parentPid: number; readonly processStartedAt: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const parsedStart = Date.parse(match[3] ?? '');
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0 || !Number.isFinite(parsedStart)) continue;
    const processStartedAt = new Date(parsedStart).toISOString();
    if (!validOwnedProcessTimestamp(processStartedAt)) continue;
    rows.push({ pid, parentPid, processStartedAt });
  }
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
  return rows.filter((row) => row.pid !== rootPid && included.has(row.pid)).map((row) => ({
    pid: row.pid,
    processStartedAt: row.processStartedAt,
  }));
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

async function terminateOwnedProcessTree(pid: number, platform: NodeJS.Platform = process.platform, expectedStartedAt?: string): Promise<void> {
  if (platform === 'win32') {
    await terminateWindowsProcessTree(pid);
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('POSIX process identity is invalid');
  if (expectedStartedAt === undefined) throw new Error('POSIX process start identity is required; targeted termination refused');
  const verifyIdentity = async (): Promise<boolean> => {
    const probe = await probeProcessStart(pid, { platform });
    if (probe.state === 'gone') return false;
    if (probe.state === 'unverifiable') throw new Error(`POSIX process liveness is unverifiable (${probe.reason}); targeted termination refused`);
    if (probe.processStartedAt !== expectedStartedAt) throw new Error('POSIX process identity changed; targeted termination refused');
    return true;
  };
  if (!(await verifyIdentity())) return;
  try {
    // The tunnel child is spawned detached, so its PID is the process-group ID.
    // Never fall back to kill(pid): that could target a reused/unrelated process.
    process.kill(-pid, 'SIGTERM');
  } catch (error: unknown) {
    if (!isNoSuchProcess(error)) throw new Error('POSIX process-group termination could not be started', { cause: error });
    if (await verifyIdentity()) throw new Error('POSIX process-group identity could not be verified');
    return;
  }
  if (await waitForProcessGone(pid, 1_500)) return;
  if (!(await verifyIdentity())) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error: unknown) {
    if (!isNoSuchProcess(error)) throw new Error('POSIX process-group escalation could not be started', { cause: error });
    if (!(await verifyIdentity())) return;
  }
  if (!(await waitForProcessGone(pid, 1_500))) throw new Error('POSIX process-group termination could not be verified');
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 5_000,
    encoding: 'utf8',
  });
}

function appendBoundedTail(current: string, chunk: string, maxBytes: number): string {
  const combined = `${current}${chunk}`;
  const encoded = Buffer.from(combined, 'utf8');
  if (encoded.byteLength <= maxBytes) return combined;
  return encoded.subarray(encoded.byteLength - maxBytes).toString('utf8');
}

function parseTransportDiagnostic(text: string): {
  readonly webSocketCloseCode: number | null;
  readonly httpStatus: number | null;
  readonly networkError: TunnelNetworkErrorDiagnostic | null;
} {
  const normalized = text.trim();
  const wsMatch = normalized.match(/(?:websocket|web\s*socket|\bws\b|connection)[^\r\n]{0,96}?(?:close(?:d)?(?:\s+code)?|code)\D{0,8}(1\d{3}|[234]\d{3})/i)
    ?? normalized.match(/(?:close(?:d)?\s+code)\D{0,8}(1\d{3}|[234]\d{3})/i);
  const httpMatch = normalized.match(/(?:http(?:\/\d(?:\.\d)?)?(?:\s+status)?|status(?:\s+code)?)\D{0,12}([45]\d{2})/i);
  const codeMatch = normalized.match(/\b(ECONNRESET|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CERT_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|ERR_SSL_[A-Z0-9_]+)\b/i);
  const haystack = normalized.toUpperCase();
  let category: TunnelNetworkErrorDiagnostic['category'] | null = null;
  if (/ECONNRESET|\bEPIPE\b|SOCKET[^\r\n]*CLOSED/.test(haystack)) category = 'connection_reset';
  else if (/ETIMEDOUT|ESOCKETTIMEDOUT|\bTIMEOUT\b|TIMED OUT/.test(haystack)) category = 'timeout';
  else if (/ENOTFOUND|EAI_AGAIN|\bDNS\b/.test(haystack)) category = 'dns';
  else if (/CERT_|\bTLS\b|\bSSL\b|ERR_TLS|ERR_SSL/.test(haystack)) category = 'tls';
  else if (/ECONNREFUSED/.test(haystack)) category = 'connection_refused';
  else if (httpMatch !== null) category = 'http';
  const networkError = category === null ? null : {
    code: codeMatch?.[1]?.toUpperCase() ?? (httpMatch?.[1] === undefined ? null : `HTTP_${httpMatch[1]}`),
    category,
    message: normalized.slice(-512),
  };
  return {
    webSocketCloseCode: wsMatch?.[1] === undefined ? null : Number.parseInt(wsMatch[1], 10),
    httpStatus: httpMatch?.[1] === undefined ? null : Number.parseInt(httpMatch[1], 10),
    networkError,
  };
}

async function inspectTunnelClientVersion(filePath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') {
    const metadata = await inspectWindowsFileVersion(filePath).catch(() => null);
    if (metadata !== null && metadata.trim().length > 0) return metadata.trim();
  }
  const result = await execFileAsync(filePath, ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 16 * 1024,
    ...(platform === 'win32' ? { windowsHide: true } : {}),
  });
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(/\r?\n/))
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return output === undefined ? null : output.slice(0, 128);
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
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
