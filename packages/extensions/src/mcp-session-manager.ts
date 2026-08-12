import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { McpServerLaunchConfig, McpToolSummary } from './types.js';

export interface McpClientSession {
  listTools(): Promise<readonly McpToolSummary[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(config: McpServerLaunchConfig): Promise<McpClientSession>;
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

  public async describe(server: string, config: McpServerLaunchConfig): Promise<Result<{
    readonly connected: boolean;
    readonly tools: readonly McpToolSummary[];
  }>> {
    try {
      const managed = await this.ensure(server, config);
      return ok({ connected: true, tools: managed.tools });
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async call(
    server: string,
    config: McpServerLaunchConfig,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result<unknown>> {
    try {
      const managed = await this.ensure(server, config);
      const result = await this.enqueue(managed, () => withTimeout(
        managed.session.callTool(tool, args),
        this.callTimeoutMs,
        `Timed out calling ${server}/${tool}`,
      ));
      managed.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok(result);
    } catch (error: unknown) {
      await this.drop(server);
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

  private async ensure(server: string, config: McpServerLaunchConfig): Promise<ManagedSession> {
    const existing = this.sessions.get(server);
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const session = await this.factory.connect(config);
    const tools = await session.listTools();
    const managed: ManagedSession = {
      session,
      tools,
      lastUsedAt: Date.now(),
      queue: Promise.resolve(),
    };
    this.sessions.set(server, managed);
    this.scheduleIdleSweep();
    return managed;
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
  async connect(config: McpServerLaunchConfig): Promise<McpClientSession> {
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
      { name: 'lnwjud-mcp-bridge', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    return {
      async listTools(): Promise<readonly McpToolSummary[]> {
        const listed = await client.listTools();
        return listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }));
      },
      async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
        return client.callTool({ name, arguments: { ...args } });
      },
      async close(): Promise<void> {
        await client.close();
      },
    };
  },
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
