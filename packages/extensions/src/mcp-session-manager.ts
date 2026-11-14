import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import {
  createProcessTreeTerminator,
  type WindowsMcpStdioOwner,
  type WindowsMcpStdioChildLaunch,
  type ProcessTreeTerminator,
} from '@lnwjud/process';
import type { ExternalMcpContractDrift, McpResourceSummary, McpServerLaunchConfig, McpSessionLifecycle, McpToolSummary } from './types.js';

export interface McpClientSession {
  listTools(signal?: AbortSignal): Promise<readonly McpToolSummary[]>;
  listResources(signal?: AbortSignal): Promise<readonly McpResourceSummary[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(config: McpServerLaunchConfig, signal?: AbortSignal): Promise<McpClientSession>;
}

class McpConnectionCleanupError extends AggregateError {
  public constructor(connectionError: unknown, cleanupError: unknown, readonly session: McpClientSession) {
    super([connectionError, cleanupError], 'Child MCP connection failed and cleanup could not be verified', { cause: connectionError });
  }
}

export interface McpSessionManagerOptions {
  readonly clientFactory?: McpClientFactory;
  readonly processTreeTerminator?: ProcessTreeTerminator;
  readonly windowsMcpStdioOwner?: WindowsMcpStdioOwner;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

interface ManagedSession {
  readonly session: McpClientSession;
  tools: readonly McpToolSummary[];
  readonly launchFingerprint: string;
  catalogFingerprint: string;
  readonly launchDriftDetected: boolean;
  lastUsedAt: number;
  queue: Promise<unknown>;
  inFlight: number;
}

interface PendingConnection {
  readonly launchFingerprint: string;
  readonly controller: AbortController;
  readonly promise: Promise<ManagedSession>;
  readonly factorySettled: Promise<void>;
  factoryComplete: boolean;
  cleanupPending: boolean;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly retiringSessions = new Map<string, Promise<void>>();
  private readonly lastLaunchFingerprints = new Map<string, string>();
  private readonly lastCatalogFingerprints = new Map<string, string>();
  private readonly factory: McpClientFactory;
  private readonly callTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly processTreeTerminator: ProcessTreeTerminator;
  private readonly closeFailures = new Map<string, string>();
  private readonly unverifiedSessions = new Map<string, McpClientSession>();
  private idleTimer: NodeJS.Timeout | undefined;
  private idleSweep: Promise<void> | undefined;
  private closed = false;

  public constructor(options: McpSessionManagerOptions = {}) {
    this.processTreeTerminator = options.processTreeTerminator ?? createProcessTreeTerminator();
    this.factory = options.clientFactory ?? createDefaultMcpClientFactory(this.processTreeTerminator, options.windowsMcpStdioOwner);
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  public isConnected(server: string): boolean {
    return this.sessions.has(server);
  }

  public lifecycle(server: string): McpSessionLifecycle {
    if (this.sessions.has(server)) return 'connected';
    return this.closeFailures.has(server)
      || this.pendingConnections.get(server)?.cleanupPending === true
      || this.retiringSessions.has(server)
      ? 'termination_unverified'
      : 'disconnected';
  }

  /** Reconcile settings before every discovery-backed operation. */
  public async reconcile(
    servers: readonly { readonly name: string; readonly config: McpServerLaunchConfig; readonly enabled: boolean; readonly excluded: boolean }[],
  ): Promise<void> {
    const desired = new Map(
      servers
        .filter((server) => server.enabled && !server.excluded)
        .map((server) => [server.name, fingerprintExternalMcpValue(server.config)] as const),
    );
    const closing: Promise<void>[] = [];
    for (const [name, managed] of this.sessions) {
      if (desired.get(name) !== managed.launchFingerprint) closing.push(this.drop(name, managed));
    }
    for (const [name, pending] of this.pendingConnections) {
      if (desired.get(name) !== pending.launchFingerprint) {
        pending.controller.abort(new Error('MCP server settings changed'));
        closing.push(this.awaitPending(pending.promise));
      }
    }
    await Promise.all(closing);
  }

  public async disconnect(server: string): Promise<void> {
    const pending = this.pendingConnections.get(server);
    if (pending !== undefined) {
      pending.controller.abort(new Error('MCP server disconnected'));
      await this.awaitPending(pending.promise);
    }
    await this.drop(server);
  }

  public async describe(server: string, config: McpServerLaunchConfig, signal?: AbortSignal): Promise<Result<{
    readonly connected: boolean;
    readonly tools: readonly McpToolSummary[];
    readonly launchFingerprint: string;
    readonly catalogFingerprint: string;
    readonly drift: ExternalMcpContractDrift;
  }>> {
    let managed: ManagedSession | undefined;
    try {
      if (isAborted(signal)) return cancelledCall();
      managed = await this.ensure(server, config, signal);
      if (isAborted(signal)) return cancelledCall();
      const refreshed = await this.refreshCatalog(server, managed, signal);
      managed.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok({
        connected: true,
        tools: managed.tools,
        launchFingerprint: managed.launchFingerprint,
        catalogFingerprint: managed.catalogFingerprint,
        drift: {
          detected: managed.launchDriftDetected || refreshed.detected,
          reasons: [
            ...(managed.launchDriftDetected ? ['launch_config' as const] : []),
            ...(refreshed.detected ? ['tool_catalog' as const] : []),
          ],
          ...(refreshed.previousCatalogFingerprint === undefined ? {} : { previousCatalogFingerprint: refreshed.previousCatalogFingerprint }),
        },
      });
    } catch (error: unknown) {
      if (managed !== undefined) await this.drop(server, managed);
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async listResources(
    server: string,
    config: McpServerLaunchConfig,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly connected: boolean; readonly resources: readonly McpResourceSummary[] }>> {
    let managed: ManagedSession | undefined;
    try {
      if (isAborted(signal)) return cancelledCall();
      managed = await this.ensure(server, config, signal);
      const activeManaged = managed;
      if (isAborted(signal)) return cancelledCall();
      const resources = await withTimeout(
        (callSignal) => this.enqueue(activeManaged, () => activeManaged.session.listResources(callSignal)),
        this.callTimeoutMs,
        `Timed out listing resources for ${server}`,
        signal,
      );
      activeManaged.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok({ connected: true, resources });
    } catch (error: unknown) {
      if (managed !== undefined) await this.drop(server, managed);
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async call(
    server: string,
    config: McpServerLaunchConfig,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    let managed: ManagedSession | undefined;
    let catalogReady = false;
    try {
      if (isAborted(signal)) return cancelledCall();
      managed = await this.ensure(server, config, signal);
      const activeManaged = managed;
      if (isAborted(signal)) return cancelledCall();
      await this.refreshCatalog(server, activeManaged, signal);
      catalogReady = true;
      const declaredTool = activeManaged.tools.find((entry) => entry.name === tool);
      if (declaredTool === undefined) {
        const availableTools = activeManaged.tools.slice(0, 20).map((entry) => entry.name).join(', ');
        const availableHint = availableTools.length === 0 ? 'No child tools are currently declared.' : `Declared tools include: ${availableTools}.`;
        return err(appError('INVALID_INPUT', `Child MCP tool is not declared by ${server}: ${tool}. Refresh with mcp_describe before retrying. ${availableHint}`));
      }
      const result = await withTimeout(
        (callSignal) => this.enqueue(activeManaged, () => activeManaged.session.callTool(tool, args, callSignal)),
        this.callTimeoutMs,
        `Timed out calling ${server}/${tool}`,
        signal,
      );
      const envelopeError = validateCallToolResultEnvelope(result);
      if (envelopeError !== undefined) return err(appError('INVALID_INPUT', `Invalid child MCP result for ${server}/${tool}: ${envelopeError}`));
      const outputError = validateDeclaredOutput(declaredTool, result);
      if (outputError !== undefined) return err(appError('INVALID_INPUT', `Child MCP output schema mismatch for ${server}/${tool}: ${outputError}`));
      activeManaged.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok(result);
    } catch (error: unknown) {
      if (managed !== undefined && (!catalogReady || isAborted(signal) || isMcpCallTimeout(error, server))) {
        await this.drop(server, managed);
      }
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const pending = [...this.pendingConnections.values()];
    for (const connection of pending) connection.controller.abort(new Error('Child MCP session manager is closed'));
    await Promise.all(pending.map(async (connection) => {
      await this.awaitPending(connection.promise);
      await this.awaitPending(connection.factorySettled);
    }));
    const retiring = [...this.retiringSessions.values()];
    const closers = [...this.sessions.entries()].map(([name, managed]) => this.drop(name, managed));
    await Promise.all([...retiring, ...closers]);
    const retries = [...this.unverifiedSessions.entries()].map(([name, session]) => this.closeSession(name, session));
    await Promise.all(retries);
  }

  private async ensure(server: string, config: McpServerLaunchConfig, signal?: AbortSignal): Promise<ManagedSession> {
    if (this.closed) throw new Error('Child MCP session manager is closed');
    if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
    const retirement = this.retiringSessions.get(server);
    if (retirement !== undefined) {
      await retirement;
      if (this.closed) throw new Error('Child MCP session manager is closed');
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      if (this.unverifiedSessions.has(server)) {
        throw new Error(`Child MCP termination is unverified for ${server}: ${this.closeFailures.get(server) ?? 'close failed'}`);
      }
    }
    const unverified = this.unverifiedSessions.get(server);
    if (unverified !== undefined) {
      await this.closeSession(server, unverified);
      if (this.closed) throw new Error('Child MCP session manager is closed');
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      if (this.unverifiedSessions.has(server)) {
        throw new Error(`Child MCP termination is unverified for ${server}: ${this.closeFailures.get(server) ?? 'close failed'}`);
      }
    }
    const launchFingerprint = fingerprintExternalMcpValue(config);
    const existing = this.sessions.get(server);
    if (existing !== undefined && existing.launchFingerprint === launchFingerprint) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing !== undefined) {
      await this.drop(server, existing);
      if (this.closed) throw new Error('Child MCP session manager is closed');
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      if (this.unverifiedSessions.has(server)) {
        throw new Error(`Child MCP termination is unverified for ${server}: ${this.closeFailures.get(server) ?? 'close failed'}`);
      }
    }

    const existingPending = this.pendingConnections.get(server);
    if (existingPending !== undefined) {
      if (existingPending.launchFingerprint === launchFingerprint) return await awaitWithAbort(existingPending.promise, signal);
      existingPending.controller.abort(new Error('MCP server launch configuration changed'));
      await existingPending.promise.catch(() => undefined);
      if (this.pendingConnections.get(server) === existingPending) {
        if (!existingPending.factoryComplete) {
          existingPending.cleanupPending = true;
          throw new Error(`Child MCP termination is unverified for ${server}: connection cleanup is still pending`);
        }
        this.pendingConnections.delete(server);
      }
      return this.ensure(server, config, signal);
    }

    if (this.closed) throw new Error('Child MCP session manager is closed');
    if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
    const controller = new AbortController();
    let resolveFactorySettled!: () => void;
    const factorySettled = new Promise<void>((resolve) => { resolveFactorySettled = resolve; });
    const pendingRef: { current?: PendingConnection } = {};
    let factoryComplete = false;
    let cleanupPending = false;
    const settleFactory = (): void => {
      if (factoryComplete) return;
      factoryComplete = true;
      cleanupPending = false;
      if (pendingRef.current !== undefined) {
        pendingRef.current.factoryComplete = true;
        pendingRef.current.cleanupPending = false;
      }
      resolveFactorySettled();
    };
    const promise = this.connectManaged(server, config, launchFingerprint, settleFactory, controller.signal);
    const pending: PendingConnection = { launchFingerprint, controller, promise, factorySettled, factoryComplete, cleanupPending };
    pendingRef.current = pending;
    this.pendingConnections.set(server, pending);
    void promise.catch(() => {
      if (!factoryComplete) {
        cleanupPending = true;
        pending.cleanupPending = true;
      }
    });
    void Promise.all([promise.then(() => undefined, () => undefined), factorySettled]).then(() => {
      if (this.pendingConnections.get(server) === pending) this.pendingConnections.delete(server);
    });
    return await awaitWithAbort(promise, signal);
  }

  private async connectManaged(
    server: string,
    config: McpServerLaunchConfig,
    launchFingerprint: string,
    settleFactory: () => void,
    signal?: AbortSignal,
  ): Promise<ManagedSession> {
    let factoryStarted = false;
    let session: McpClientSession;
    try {
      session = await withTimeout(
      (connectSignal) => {
        let connection: Promise<McpClientSession>;
        try {
          connection = this.factory.connect(config, connectSignal);
        } catch (error: unknown) {
          settleFactory();
          throw error;
        }
        factoryStarted = true;
        void connection.catch((error: unknown) => {
          if (error instanceof McpConnectionCleanupError) {
            this.closeFailures.set(server, sanitizeError(error));
            this.unverifiedSessions.set(server, error.session);
          }
          settleFactory();
        });
        return connection;
      },
      this.callTimeoutMs,
      `Timed out connecting to ${server}`,
      signal,
      async (lateSession) => {
        try { await this.closeSession(server, lateSession); } finally { settleFactory(); }
      },
      );
      settleFactory();
    } catch (error: unknown) {
      if (!factoryStarted) settleFactory();
      throw error;
    }
    try {
      if (this.closed) throw new Error('Child MCP session manager is closed');
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      const listedTools = await withTimeout(
        (listSignal) => session.listTools(listSignal),
        this.callTimeoutMs,
        `Timed out listing initial tools for ${server}`,
        signal,
      );
      if (this.closed) throw new Error('Child MCP session manager is closed');
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      const tools = normalizeExternalToolCatalog(listedTools);
      const catalogFingerprint = fingerprintExternalMcpValue(tools);
      const previousLaunchFingerprint = this.lastLaunchFingerprints.get(server);
      const managed: ManagedSession = {
        session,
        tools,
        launchFingerprint,
        catalogFingerprint,
        launchDriftDetected: previousLaunchFingerprint !== undefined && previousLaunchFingerprint !== launchFingerprint,
        lastUsedAt: Date.now(),
        queue: Promise.resolve(),
        inFlight: 0,
      };
      this.lastLaunchFingerprints.set(server, launchFingerprint);
      this.lastCatalogFingerprints.set(server, catalogFingerprint);
      const replaced = this.sessions.get(server);
      if (replaced !== undefined) {
        this.sessions.delete(server);
        await this.closeManaged(server, replaced);
      }
      if (this.closed) throw new Error('Child MCP session manager is closed');
      this.sessions.set(server, managed);
      this.closeFailures.delete(server);
      this.scheduleIdleSweep();
      return managed;
    } catch (error: unknown) {
      await this.closeSession(server, session);
      throw error;
    }
  }

  private async refreshCatalog(
    server: string,
    managed: ManagedSession,
    signal?: AbortSignal,
  ): Promise<{ readonly detected: boolean; readonly previousCatalogFingerprint?: string }> {
    const listedTools = await withTimeout(
      (callSignal) => this.enqueue(managed, () => managed.session.listTools(callSignal)),
      this.callTimeoutMs,
      `Timed out refreshing tool catalog for ${server}`,
      signal,
    );
    const tools = normalizeExternalToolCatalog(listedTools);
    const nextFingerprint = fingerprintExternalMcpValue(tools);
    const previousFingerprint = managed.catalogFingerprint;
    managed.tools = tools;
    managed.catalogFingerprint = nextFingerprint;
    managed.lastUsedAt = Date.now();
    this.lastCatalogFingerprints.set(server, nextFingerprint);
    return nextFingerprint === previousFingerprint
      ? { detected: false }
      : { detected: true, previousCatalogFingerprint: previousFingerprint };
  }

  private enqueue<T>(managed: ManagedSession, operation: () => Promise<T>): Promise<T> {
    managed.inFlight += 1;
    managed.lastUsedAt = Date.now();
    const next = managed.queue.then(operation, operation);
    const settled = next.finally(() => {
      managed.inFlight -= 1;
      managed.lastUsedAt = Date.now();
    });
    managed.queue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async drop(server: string, expected?: ManagedSession): Promise<void> {
    const retiring = this.retiringSessions.get(server);
    if (retiring !== undefined) return retiring;
    const managed = this.sessions.get(server);
    if (managed === undefined || (expected !== undefined && managed !== expected)) return;
    this.sessions.delete(server);
    const retirement = Promise.resolve().then(() => this.closeManaged(server, managed));
    this.retiringSessions.set(server, retirement);
    try {
      await retirement;
    } finally {
      if (this.retiringSessions.get(server) === retirement) this.retiringSessions.delete(server);
    }
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer !== undefined || this.closed || this.sessions.size === 0) return;
    this.idleTimer = setInterval(() => { void this.sweepIdle(); }, Math.min(30_000, this.idleTimeoutMs));
  }

  private async sweepIdle(): Promise<void> {
    if (this.idleSweep !== undefined) return this.idleSweep;
    const sweep = Promise.resolve().then(async () => {
      const now = Date.now();
      for (const [name, managed] of this.sessions) {
        if (managed.inFlight === 0 && now - managed.lastUsedAt >= this.idleTimeoutMs) await this.drop(name);
      }
    });
    this.idleSweep = sweep;
    try {
      await sweep;
    } finally {
      this.idleSweep = undefined;
      if (this.sessions.size === 0 && this.idleTimer !== undefined) {
        clearInterval(this.idleTimer);
        this.idleTimer = undefined;
      }
    }
  }

  private async closeManaged(server: string, managed: ManagedSession): Promise<void> {
    if (managed.inFlight > 0) {
      await Promise.race([
        managed.queue,
        delay(this.callTimeoutMs),
      ]);
    }
    await this.closeSession(server, managed.session);
  }

  private async closeSession(server: string, session: McpClientSession): Promise<void> {
    try {
      await session.close();
      this.closeFailures.delete(server);
      if (this.unverifiedSessions.get(server) === session) this.unverifiedSessions.delete(server);
    } catch (error: unknown) {
      this.closeFailures.set(server, sanitizeError(error));
      this.unverifiedSessions.set(server, session);
    }
  }

  private async awaitPending<T>(promise: Promise<T>): Promise<void> {
    await Promise.race([promise.then(() => undefined, () => undefined), delay(this.callTimeoutMs)]);
  }
}

export function createDefaultMcpClientFactory(
  processTreeTerminator: ProcessTreeTerminator = createProcessTreeTerminator(),
  windowsMcpStdioOwner?: WindowsMcpStdioOwner,
): McpClientFactory {
  return {
    async connect(config: McpServerLaunchConfig, signal?: AbortSignal): Promise<McpClientSession> {
    if (process.platform === 'win32' && windowsMcpStdioOwner === undefined) throw new Error('MCP_WINDOWS_JOB_PROXY_REQUIRED');
    const windowsLaunch = process.platform === 'win32'
      ? await windowsMcpStdioOwner!.prepare(config)
      : undefined;
    const useSessionWrapper = process.platform === 'linux';
    const command = useSessionWrapper ? 'setsid' : config.command;
    const args = useSessionWrapper ? [config.command, ...(config.args ?? [])] : [...(config.args ?? [])];
    type OwnedChildRecord = { readonly child: ChildProcess; readonly pid: number | null; readonly ticket?: WindowsMcpStdioChildLaunch; verified: boolean };
    const ownedChildren = new Map<StdioClientTransport, OwnedChildRecord>();
    const mainTransport: { current?: StdioClientTransport } = {};
    let pinReleaseRequested = false;
    let pinReleased = false;
    let connectionClosed = windowsLaunch === undefined;
    let connectionClosing = false;
    let probeCleanupFailure: unknown;
    const maybeReleasePin = (): void => {
      if (windowsLaunch === undefined || pinReleased || !pinReleaseRequested) return;
      if (!connectionClosed || [...ownedChildren.values()].some(record => !record.verified
        || record.child.pid !== undefined && record.child.exitCode === null && record.child.signalCode === null)) return;
      pinReleased = true;
      windowsLaunch.release();
    };
    const requestPinRelease = (): void => {
      pinReleaseRequested = true;
      maybeReleasePin();
    };
    const registerOwnedChild = (owner: StdioClientTransport, child: ChildProcess, ticket?: WindowsMcpStdioChildLaunch): void => {
      ownedChildren.set(owner, { child, pid: owner.pid, verified: false, ...(ticket === undefined ? {} : { ticket }) });
      child.once('close', () => {
        if (owner === mainTransport.current) pinReleaseRequested = true;
        maybeReleasePin();
      });
    };
    const sdkSiblingDispose: unknown = Reflect.get(StdioClientTransport.prototype, '_dispose');
    if (typeof sdkSiblingDispose !== 'function') {
      if (windowsLaunch !== undefined) { await windowsLaunch.closeOwnedConnection(); windowsLaunch.release(); }
      pinReleased = windowsLaunch !== undefined;
      throw new Error('MCP_SDK_STDIO_DISPOSAL_UNAVAILABLE');
    }
    const verifyOwnedChild = async (owner: StdioClientTransport): Promise<void> => {
      const record = ownedChildren.get(owner);
      if (record === undefined) {
        if (owner instanceof OwnedStdioClientTransport) await owner.ticket?.closeResource();
        return;
      }
      if (record.verified || process.platform === 'darwin') return;
      if (process.platform === 'win32') {
        if (windowsLaunch === undefined) throw new Error('MCP_WINDOWS_JOB_PROXY_REQUIRED');
        if (record.ticket === undefined) throw new Error('MCP_NATIVE_CHILD_TICKET_REQUIRED');
        const proof = await record.ticket.closeResource(record.child);
        if (proof.scope !== windowsLaunch.cleanupScope || proof.containment !== 'unisolated_same_user' || proof.writerDrainVerified !== false)
          throw new Error('MCP_NATIVE_JOB_SCOPE_INVALID');
      } else {
        if (record.pid === null) throw new Error('MCP_CHILD_IDENTITY_UNVERIFIED');
        await processTreeTerminator.stop(record.child, record.pid);
      }
      record.verified = true;
    };
    const disposeOwnedTransport = async (owner: StdioClientTransport): Promise<void> => {
      let cleanupError: unknown;
      try { await verifyOwnedChild(owner); } catch (error: unknown) { cleanupError = error; }
      try { await Reflect.apply(sdkSiblingDispose, owner, []); } catch (error: unknown) { cleanupError ??= error; }
      if (cleanupError !== undefined) {
        if (owner !== mainTransport.current) probeCleanupFailure ??= cleanupError;
        throw cleanupError;
      }
      const record = ownedChildren.get(owner);
      if (record !== undefined) record.verified = true;
    };
    class OwnedStdioClientTransport extends StdioClientTransport {
      public ticket: WindowsMcpStdioChildLaunch | undefined;
      private readonly parameters: ConstructorParameters<typeof StdioClientTransport>[0];
      public constructor(parameters: ConstructorParameters<typeof StdioClientTransport>[0]) {
        const owned = { ...parameters, args: [...(parameters.args ?? [])], env: { ...parameters.env } };
        super(owned);
        if (windowsLaunch !== undefined && Reflect.get(this, '_serverParams') !== owned) throw new Error('MCP_SDK_STDIO_PARAMETERS_UNAVAILABLE');
        this.parameters = owned;
      }
      public override async start(): Promise<void> {
        if (connectionClosing) throw new Error('MCP_NATIVE_CONNECTION_CLOSED');
        if (this === mainTransport.current && probeCleanupFailure !== undefined) {
          throw new Error('MCP_PROBE_CLEANUP_UNVERIFIED', { cause: probeCleanupFailure });
        }
        if (windowsLaunch !== undefined) {
          this.ticket = await windowsLaunch.prepareChild();
          if (connectionClosing) { await this.ticket.closeResource(); throw new Error('MCP_NATIVE_CONNECTION_CLOSED'); }
          this.parameters.command = this.ticket.command;
          this.parameters.args = [...this.ticket.args];
          this.parameters.env = { ...this.ticket.env };
        }
        const started = super.start();
        const child: unknown = Reflect.get(this, '_process');
        if (child instanceof ChildProcess) registerOwnedChild(this, child, this.ticket);
        return started.then(() => {
          const record = ownedChildren.get(this);
          if (record === undefined || process.platform !== 'win32' && (record.pid === null || record.child.pid !== record.pid)) {
            throw new Error('MCP_CHILD_IDENTITY_UNVERIFIED');
          }
        });
      }
    }
    // SDK 2.0.0 clones stdio probes only when the prototype owns its private disposal hook.
    Object.defineProperty(OwnedStdioClientTransport.prototype, '_dispose', {
      configurable: false,
      value: async function (this: OwnedStdioClientTransport): Promise<void> {
        await disposeOwnedTransport(this);
      },
    });
    let transport: StdioClientTransport;
    try {
      transport = new OwnedStdioClientTransport({
        command,
        args,
        ...(windowsLaunch === undefined && config.cwd !== undefined ? { cwd: config.cwd } : {}),
        env: {
          ...definedEnv(process.env),
          ...(config.env ?? {}),
        },
        stderr: 'pipe',
      });
    } catch (error: unknown) {
      if (windowsLaunch !== undefined) { await windowsLaunch.closeOwnedConnection(); windowsLaunch.release(); }
      pinReleased = windowsLaunch !== undefined;
      throw error;
    }
    mainTransport.current = transport;
    let cleanupPid: number | null = null;
    const startSdkTransport = transport.start.bind(transport);
    transport.start = async (): Promise<void> => {
      try {
        await startSdkTransport();
      } finally {
        cleanupPid = ownedChildren.get(transport)?.pid ?? null;
        if (!ownedChildren.has(transport)) requestPinRelease();
      }
      const record = ownedChildren.get(transport);
      if (record === undefined
        || process.platform !== 'win32' && (record.pid === null || record.child.pid !== record.pid)) {
        throw new Error('MCP_CHILD_IDENTITY_UNVERIFIED');
      }
    };
    let treeStopAttempt: Promise<void> | undefined;
    let transportCloseAttempt: Promise<void> | undefined;
    let transportCleanupFailure: unknown;
    const stopChildTree = (): Promise<void> => {
      connectionClosing = true;
      treeStopAttempt ??= (async (): Promise<void> => {
        let firstError: unknown;
        if (windowsLaunch !== undefined) {
          try {
            const proof = await windowsLaunch.closeOwnedConnection();
            if (proof.scope !== windowsLaunch.cleanupScope || proof.containment !== 'unisolated_same_user' || proof.writerDrainVerified !== false) throw new Error('MCP_NATIVE_JOB_SCOPE_INVALID');
            connectionClosed = true;
          } catch (error: unknown) { firstError = error; }
        }
        for (const [owner, record] of ownedChildren) {
          if (record.verified || process.platform === 'darwin' && owner === transport) continue;
          try {
            if (process.platform === 'darwin') await disposeOwnedTransport(owner);
            else await verifyOwnedChild(owner);
          } catch (error: unknown) {
            firstError ??= error;
          }
        }
        if (firstError !== undefined) throw firstError;
      })();
      return treeStopAttempt;
    };
    const closeSdkTransport = transport.close.bind(transport);
    transport.close = async (): Promise<void> => {
      transportCloseAttempt ??= (async (): Promise<void> => {
        try { await stopChildTree(); } catch (error: unknown) { transportCleanupFailure ??= error; }
        try { await closeSdkTransport(); } catch (error: unknown) { transportCleanupFailure ??= error; }
        requestPinRelease();
      })();
      await transportCloseAttempt;
    };
    const disposeStderrDrain = attachChildStderrDrain(transport.stderr);
    const client = new Client(
      { name: 'lnwjud-mcp-bridge', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(transport, signal === undefined ? undefined : { signal });
    } catch (error: unknown) {
      const failedSession = createSession();
      try {
        await failedSession.close();
      } catch (cleanupError: unknown) {
        requestPinRelease();
        throw new McpConnectionCleanupError(error, cleanupError, failedSession);
      }
      requestPinRelease();
      throw error;
    }
    return createSession();

    function createSession(): McpClientSession {
    const pid = cleanupPid;
    let closed = false;
    let closing: Promise<void> | undefined;
    return {
      async listTools(listSignal?: AbortSignal): Promise<readonly McpToolSummary[]> {
        const listed = await client.listTools(undefined, listSignal === undefined ? undefined : { signal: listSignal });
        return listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        }));
      },
      async listResources(listSignal?: AbortSignal): Promise<readonly McpResourceSummary[]> {
        const listed = await client.listResources(undefined, listSignal === undefined ? undefined : { signal: listSignal });
        return listed.resources.map((resource) => ({
          uri: resource.uri,
          ...(resource.name === undefined ? {} : { name: resource.name }),
          ...(resource.description === undefined ? {} : { description: resource.description }),
          ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
        }));
      },
      async callTool(name: string, args: Readonly<Record<string, unknown>>, callSignal?: AbortSignal): Promise<unknown> {
        return client.request(
          { method: 'tools/call', params: { name, arguments: { ...args } } },
          callSignal === undefined ? undefined : { signal: callSignal },
        );
      },
      async close(): Promise<void> {
        if (closed) return;
        if (closing !== undefined) return closing;
        if (transportCleanupFailure !== undefined) {
          treeStopAttempt = undefined;
          transportCloseAttempt = undefined;
          transportCleanupFailure = undefined;
        }
        const attempt = (async (): Promise<void> => {
          let firstError: unknown;
          // macOS SDK stdio children are direct processes, not session/group
          // leaders. Do not signal an unrelated process group with -pid.
          // Closing the transport proves only direct-child shutdown, never
          // escaped descendants; macOS managed workspace writers stay denied.
          try {
            await transport.close();
          } catch (error: unknown) {
            firstError = error;
          }
          try {
            await client.close();
            if (process.platform === 'darwin' && pid !== null) await waitForMacMcpDirectChildExit(pid);
          } catch (error: unknown) {
            firstError ??= error;
          }
          firstError ??= transportCleanupFailure;
          if (firstError !== undefined) throw firstError;
          closed = true;
          disposeStderrDrain();
        })();
        closing = attempt;
        try {
          await attempt;
        } finally {
          closing = undefined;
        }
      },
    };
    }
    },
  };
}

async function waitForMacMcpDirectChildExit(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('MCP_CHILD_IDENTITY_UNVERIFIED');
  const deadline = Date.now() + 3_000;
  do {
    try { process.kill(pid, 0); }
    catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw new Error('MCP_CHILD_IDENTITY_UNVERIFIED', { cause: error });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('MCP_CHILD_TERMINATION_UNVERIFIED');
}

export const defaultMcpClientFactory: McpClientFactory = createDefaultMcpClientFactory();

export function attachChildStderrDrain(stderr: unknown): () => void {
  if (!isDrainableStderr(stderr)) return () => undefined;
  const ignorePipeError = (): void => undefined;
  stderr.on('error', ignorePipeError);
  stderr.resume();
  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    stderr.removeListener('error', ignorePipeError);
  };
}

function isDrainableStderr(value: unknown): value is {
  on(event: 'error', listener: () => void): unknown;
  removeListener(event: 'error', listener: () => void): unknown;
  resume(): unknown;
} {
  return typeof value === 'object'
    && value !== null
    && 'on' in value && typeof value.on === 'function'
    && 'removeListener' in value && typeof value.removeListener === 'function'
    && 'resume' in value && typeof value.resume === 'function';
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    if (isAborted(parentSignal)) {
      controller.abort(parentSignal?.reason);
      reject(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error('Child MCP call was cancelled'));
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      controller.abort(parentSignal?.reason);
      rejectOnce(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error('Child MCP call was cancelled'));
    };

    parentSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(message));
      rejectOnce(new Error(message));
    }, timeoutMs);

    let pending: Promise<T>;
    try {
      pending = operation(controller.signal);
    } catch (error: unknown) {
      rejectOnce(error);
      return;
    }
    pending.then((value) => {
      if (settled) {
        if (onLateValue !== undefined) void Promise.resolve(onLateValue(value)).catch(() => undefined);
        return;
      }
      resolveOnce(value);
    }, rejectOnce);
  });
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Child MCP operation was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Child MCP operation was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, timeoutMs));
    timer.unref?.();
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledCall(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Child MCP operation was cancelled', true));
}

function normalizeExternalToolCatalog(tools: readonly McpToolSummary[]): readonly McpToolSummary[] {
  if (tools.length > 512) throw new Error(`Child MCP tool catalog exceeds 512 tools (${tools.length})`);
  const names = new Set<string>();
  return tools.map((tool) => {
    const name = tool.name.trim();
    if (name.length === 0 || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)) {
      throw new Error('Child MCP tool name is invalid or exceeds 128 characters');
    }
    if (names.has(name)) throw new Error(`Child MCP tool catalog contains duplicate tool: ${name}`);
    names.add(name);
    const description = tool.description.replace(/\s+/g, ' ').trim().slice(0, 4096);
    const normalized: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown } = { name, description };
    if (tool.inputSchema !== undefined) {
      validateExternalSchema(tool.inputSchema, name, 'input');
      normalized.inputSchema = tool.inputSchema;
    }
    if (tool.outputSchema !== undefined) {
      validateExternalSchema(tool.outputSchema, name, 'output');
      normalized.outputSchema = tool.outputSchema;
    }
    return normalized;
  });
}

function validateExternalSchema(schema: unknown, toolName: string, direction: 'input' | 'output'): asserts schema is Record<string, unknown> {
  if (!isPlainRecord(schema)) throw new Error(`Child MCP tool ${direction} schema must be an object: ${toolName}`);
  const schemaBytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (schemaBytes > 256 * 1024) throw new Error(`Child MCP tool ${direction} schema exceeds 256 KiB: ${toolName}`);
  const type = schema.type;
  if (type !== undefined && type !== 'object') throw new Error(`Child MCP tool ${direction} schema root must be object: ${toolName}`);
}

function validateCallToolResultEnvelope(result: unknown): string | undefined {
  if (!isPlainRecord(result)) return 'MCP tool result must be an object';
  if (result.content !== undefined && !Array.isArray(result.content)) return 'MCP tool result content must be an array';
  if (result.isError !== undefined && typeof result.isError !== 'boolean') return 'MCP tool result isError must be a boolean';
  return undefined;
}

function validateDeclaredOutput(tool: McpToolSummary, result: unknown): string | undefined {
  if (tool.outputSchema === undefined) return undefined;
  const resultRecord = isPlainRecord(result) ? result : undefined;
  if (resultRecord?.isError === true) return undefined;
  if (resultRecord === undefined || resultRecord.structuredContent === undefined) return 'declared outputSchema requires structuredContent';
  return validateJsonSchemaSubset(tool.outputSchema, resultRecord.structuredContent, '$');
}

function validateJsonSchemaSubset(schema: unknown, value: unknown, path: string): string | undefined {
  if (!isPlainRecord(schema)) return undefined;
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const error = validateJsonSchemaSubset(branch, value, path);
      if (error !== undefined) return error;
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => validateJsonSchemaSubset(branch, value, path) === undefined)) {
    return `${path} does not match anyOf`;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateJsonSchemaSubset(branch, value, path) === undefined).length;
    if (matches !== 1) return `${path} must match exactly one oneOf branch`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqualJson(candidate, value))) return `${path} is not in enum`;
  if (Object.hasOwn(schema, 'const') && !deepEqualJson(schema.const, value)) return `${path} does not match const`;

  const declaredTypes = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((entry): entry is string => typeof entry === 'string') : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesJsonType(type, value))) {
    return `${path} expected ${declaredTypes.join('|')}`;
  }

  if ((declaredTypes.includes('object') || schema.properties !== undefined || schema.required !== undefined) && isPlainRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateJsonSchemaSubset(childSchema, value[key], `${path}.${key}`);
      if (error !== undefined) return error;
    }
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) continue;
      if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
      if (isPlainRecord(schema.additionalProperties)) {
        const error = validateJsonSchemaSubset(schema.additionalProperties, childValue, `${path}.${key}`);
        if (error !== undefined) return error;
      }
    }
  }

  if ((declaredTypes.includes('array') || schema.items !== undefined) && Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchemaSubset(schema.items, value[index], `${path}[${index}]`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isPlainRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function fingerprintExternalMcpValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpCallTimeout(error: unknown, server: string): boolean {
  return error instanceof Error && error.message.startsWith(`Timed out calling ${server}/`);
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\s+/g, ' ').slice(0, 500);
  return 'Child MCP operation failed';
}

function definedEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
