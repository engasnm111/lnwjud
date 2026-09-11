import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { ExternalMcpContractDrift, McpResourceSummary, McpServerLaunchConfig, McpToolSummary } from './types.js';

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
  tools: readonly McpToolSummary[];
  readonly launchFingerprint: string;
  catalogFingerprint: string;
  readonly launchDriftDetected: boolean;
  lastUsedAt: number;
  queue: Promise<unknown>;
}

interface PendingConnection {
  readonly launchFingerprint: string;
  readonly promise: Promise<ManagedSession>;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly lastLaunchFingerprints = new Map<string, string>();
  private readonly lastCatalogFingerprints = new Map<string, string>();
  private readonly factory: McpClientFactory;
  private readonly callTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

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
    try {
      if (isAborted(signal)) return cancelledCall();
      managed = await this.ensure(server, config, signal);
      const activeManaged = managed;
      if (isAborted(signal)) return cancelledCall();
      await this.refreshCatalog(server, activeManaged, signal);
      const declaredTool = activeManaged.tools.find((entry) => entry.name === tool);
      if (declaredTool === undefined) {
        return err(appError('INVALID_INPUT', `Child MCP tool is not declared by ${server}: ${tool}`));
      }
      const result = await withTimeout(
        (callSignal) => this.enqueue(activeManaged, () => activeManaged.session.callTool(tool, args, callSignal)),
        this.callTimeoutMs,
        `Timed out calling ${server}/${tool}`,
        signal,
      );
      const outputError = validateDeclaredOutput(declaredTool, result);
      if (outputError !== undefined) return err(appError('INVALID_INPUT', `Child MCP output schema mismatch for ${server}/${tool}: ${outputError}`));
      activeManaged.lastUsedAt = Date.now();
      this.scheduleIdleSweep();
      return ok(result);
    } catch (error: unknown) {
      if (managed !== undefined) await this.drop(server, managed);
      if (isAborted(signal)) return cancelledCall();
      return err(appError('INTERNAL_ERROR', sanitizeError(error), true));
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    this.pendingConnections.clear();
    const closers = [...this.sessions.entries()].map(async ([name, managed]) => {
      this.sessions.delete(name);
      await managed.session.close().catch(() => undefined);
    });
    await Promise.all(closers);
  }

  private async ensure(server: string, config: McpServerLaunchConfig, signal?: AbortSignal): Promise<ManagedSession> {
    if (this.closed) throw new Error('Child MCP session manager is closed');
    if (isAborted(signal)) throw new Error('Child MCP connection was cancelled');
    const launchFingerprint = fingerprintExternalMcpValue(config);
    const existing = this.sessions.get(server);
    if (existing !== undefined && existing.launchFingerprint === launchFingerprint) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing !== undefined) await this.drop(server, existing);

    const pending = this.pendingConnections.get(server);
    if (pending !== undefined) {
      if (pending.launchFingerprint === launchFingerprint) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.ensure(server, config, signal);
    }

    const promise = this.connectManaged(server, config, launchFingerprint, signal);
    this.pendingConnections.set(server, { launchFingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.pendingConnections.get(server)?.promise === promise) this.pendingConnections.delete(server);
    }
  }

  private async connectManaged(
    server: string,
    config: McpServerLaunchConfig,
    launchFingerprint: string,
    signal?: AbortSignal,
  ): Promise<ManagedSession> {
    const session = await withTimeout(
      (connectSignal) => this.factory.connect(config, connectSignal),
      this.callTimeoutMs,
      `Timed out connecting to ${server}`,
      signal,
    );
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
      };
      this.lastLaunchFingerprints.set(server, launchFingerprint);
      this.lastCatalogFingerprints.set(server, catalogFingerprint);
      const replaced = this.sessions.get(server);
      if (replaced !== undefined) await replaced.session.close().catch(() => undefined);
      if (this.closed) throw new Error('Child MCP session manager is closed');
      this.sessions.set(server, managed);
      this.scheduleIdleSweep();
      return managed;
    } catch (error: unknown) {
      await session.close().catch(() => undefined);
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
    const next = managed.queue.then(operation, operation);
    managed.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async drop(server: string, expected?: ManagedSession): Promise<void> {
    const managed = this.sessions.get(server);
    if (managed === undefined || (expected !== undefined && managed !== expected)) return;
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
    const disposeStderrDrain = attachChildStderrDrain(transport.stderr);
    const client = new Client(
      { name: 'lnwjud-mcp-bridge', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(transport, signal === undefined ? undefined : { signal });
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      disposeStderrDrain();
      throw error;
    }
    let closed = false;
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
        return client.callTool({ name, arguments: { ...args } }, callSignal === undefined ? undefined : { signal: callSignal });
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await client.close();
        } finally {
          disposeStderrDrain();
        }
      },
    };
  },
};

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

function validateDeclaredOutput(tool: McpToolSummary, result: unknown): string | undefined {
  if (tool.outputSchema === undefined) return undefined;
  const resultRecord = isPlainRecord(result) ? result : undefined;
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

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\s+/g, ' ').slice(0, 500);
  return 'Child MCP operation failed';
}

function definedEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
