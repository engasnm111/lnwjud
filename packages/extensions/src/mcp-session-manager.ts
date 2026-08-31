import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { McpResourceSummary, McpServerLaunchConfig, McpToolSummary } from './types.js';

export interface McpClientSession {
  listTools(signal?: AbortSignal): Promise<readonly McpToolSummary[]>;
  listResources(signal?: AbortSignal): Promise<readonly McpResourceSummary[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(config: McpServerLaunchConfig, signal?: AbortSignal): Promise<McpClientSession>;
}

export interface McpSessionManagerOptions {
  readonly clientFactory?: McpClientFactory;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

interface ManagedSession {
  readonly session: McpClientSession;
  readonly tools: readonly McpToolSummary[];
  lastUsedAt: number;
  queue: Promise<unknown>;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly factory: McpClientFactory;
  private readonly callTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;

  public constructor(options: McpSessionManagerOptions = {}) {
    this.factory = options.clientFactory ?? defaultMcpClientFactory;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  public isConnected(server: string): boolean {
    return this.sessions.has(server);
  }

  public async describe(server: string, config: McpServerLaunchConfig, signal?: AbortSignal): Promise<Result<{
    readonly connected: boolean;
    readonly tools: readonly McpToolSummary[];
  }>> {
    try {
      if (isAborted(signal)) return cancelledCall();
      const managed = await this.ensure(server, config, signal);
      if (isAborted(signal)) return cancelledCall();
      return ok({ connected: true, tools: managed.tools });
    } catch (error: unknown) {
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async listResources(
    server: string,
    config: McpServerLaunchConfig,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly connected: boolean; readonly resources: readonly McpResourceSummary[] }>> {
    try {
      if (isAborted(signal)) return cancelledCall();
      const managed = await this.ensure(server, config, signal);
      if (isAborted(signal)) return cancelledCall();
      const resources = await this.enqueue(managed, () => withTimeout(
        (callSignal) => managed.session.listResources(callSignal),
        this.callTimeoutMs,
        `Timed out listing resources for ${server}`,
        signal,
      ));
      managed.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok({ connected: true, resources });
    } catch (error: unknown) {
      await this.drop(server);
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
    try {
      if (isAborted(signal)) return cancelledCall();
      const managed = await this.ensure(server, config, signal);
      if (isAborted(signal)) return cancelledCall();
      const result = await this.enqueue(managed, () => withTimeout(
        (callSignal) => managed.session.callTool(tool, args, callSignal),
        this.callTimeoutMs,
        `Timed out calling ${server}/${tool}`,
        signal,
      ));
      managed.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok(result);
    } catch (error: unknown) {
      await this.drop(server);
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async close(): Promise<void> {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const closers = [...this.sessions.entries()].map(async ([name, managed]) => {
      this.sessions.delete(name);
      await managed.session.close().catch(() => undefined);
    });
    await Promise.all(closers);
  }

  private async ensure(server: string, config: McpServerLaunchConfig, signal?: AbortSignal): Promise<ManagedSession> {
    if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
    const existing = this.sessions.get(server);
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const session = await this.factory.connect(config, signal);
    try {
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      const tools = await session.listTools(signal);
      if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
      const managed: ManagedSession = {
        session,
        tools,
        lastUsedAt: Date.now(),
        queue: Promise.resolve(),
      };
      this.sessions.set(server, managed);
      this.scheduleIdleSweep();
      return managed;
    } catch (error: unknown) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(managed: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const next = managed.queue.then(operation, operation);
    managed.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async drop(server: string): Promise<void> {
    const managed = this.sessions.get(server);
    if (managed === undefined) return;
    this.sessions.delete(server);
    await managed.session.close().catch(() => undefined);
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer !== undefined) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, Math.min(30_000, this.idleTimeoutMs));
    this.idleTimer.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [name, managed] of this.sessions) {
      if (now - managed.lastUsedAt >= this.idleTimeoutMs) await this.drop(name);
    }
  }
}

export const defaultMcpClientFactory: McpClientFactory = {
  async connect(config: McpServerLaunchConfig, signal?: AbortSignal): Promise<McpClientSession> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env: {
        ...definedEnv(process.env),
        ...(config.env ?? {}),
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'lnwjud-mcp-bridge', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport, signal === undefined ? undefined : { signal });
    return {
      async listTools(listSignal?: AbortSignal): Promise<readonly McpToolSummary[]> {
        const listed = await client.listTools(undefined, listSignal === undefined ? undefined : { signal: listSignal });
        return listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
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
        return client.callTool({ name, arguments: { ...args } }, callSignal === undefined ? undefined : { signal: callSignal });
      },
      async close(): Promise<void> {
        await client.close();
      },
    };
  },
};

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string, parentSignal?: AbortSignal): Promise<T> {
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
    pending.then(resolveOnce, rejectOnce);
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledCall(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Child MCP operation was cancelled', true));
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
