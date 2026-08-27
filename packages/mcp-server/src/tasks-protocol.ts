import { ProtocolError, ProtocolErrorCode, RELATED_TASK_META_KEY, type McpServer } from '@modelcontextprotocol/server';
import type { AppError, Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { DEFAULT_MCP_POLL_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS } from '@lnwjud/shared';
import { z } from 'zod';
import type { McpApplicationServices } from './tool-registry.js';
import { withCapabilityOwnerMetadata } from './request-scope.js';

/**
 * Protocol-level exposure of durable background tasks per the MCP Tasks
 * utility (spec 2025-11-25, experimental). Tasks are still created through
 * the `shell` tool with execution=background; this surface only serves
 * tasks/get, tasks/result, tasks/list, and tasks/cancel so spec-aware
 * clients can poll and retrieve results without knowing lnwjud's tool names.
 */

export interface ProtocolTask {
  readonly taskId: string;
  readonly status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttl: number | null;
  readonly pollInterval?: number;
}

export interface TaskResultPayload {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError: boolean;
  readonly _meta: Record<string, unknown>;
}

export interface TasksProtocolOptions {
  readonly actor?: FileActor;
  readonly pageSize?: number;
  readonly maxResultWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly pollTickMs?: number;
}

type ShellSnapshot = Record<string, unknown>;
type TaskIdParams = { readonly taskId: string };
type ListParams = { readonly cursor?: string | undefined };

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_RESULT_WAIT_MS = DEFAULT_MCP_POLL_WAIT_SECONDS * 1_000;
const DEFAULT_POLL_INTERVAL_MS = DEFAULT_MCP_POLL_WAIT_SECONDS * 1_000;
const DEFAULT_POLL_TICK_MS = 200;
const CURSOR_PREFIX = 'lnwjud-tasks:';
const TERMINAL_STATUSES: ReadonlySet<ProtocolTask['status']> = new Set(['completed', 'failed', 'cancelled']);

/** Local task states come from shell-backend / durable-shell-task-store. */
function protocolStatus(state: string): ProtocolTask['status'] {
  switch (state) {
    case 'running': return 'working';
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'termination_unverified': return 'working';
    case 'failed':
    case 'timed_out':
    default:
      return 'failed';
  }
}

function toProtocolTask(snapshot: ShellSnapshot, pollIntervalMs: number): ProtocolTask | undefined {
  const taskId = typeof snapshot.task_id === 'string' ? snapshot.task_id.trim() : '';
  const startedAt = typeof snapshot.started_at === 'string' ? snapshot.started_at : '';
  if (taskId.length === 0 || startedAt.length === 0) return undefined;
  const status = protocolStatus(typeof snapshot.state === 'string' ? snapshot.state : '');
  const finishedAt = typeof snapshot.finished_at === 'string' ? snapshot.finished_at : startedAt;
  let ttl: number | null = null;
  if (typeof snapshot.deadline_at === 'string') {
    const lifetimeMs = Date.parse(snapshot.deadline_at) - Date.parse(startedAt);
    if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) ttl = Math.round(lifetimeMs);
  }
  const errorMessage = typeof snapshot.error === 'string' ? snapshot.error : undefined;
  const localState = typeof snapshot.state === 'string' ? snapshot.state : '';
  return {
    taskId,
    status,
    ...((status === 'failed' || localState === 'termination_unverified') && errorMessage !== undefined ? { statusMessage: errorMessage } : {}),
    createdAt: startedAt,
    lastUpdatedAt: finishedAt,
    ttl,
    pollInterval: pollIntervalMs,
  };
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function internalError(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InternalError, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) throw invalidParams('Invalid tasks/list cursor');
  const offset = Number.parseInt(decoded.slice(CURSOR_PREFIX.length), 10);
  if (!Number.isInteger(offset) || offset < 0) throw invalidParams('Invalid tasks/list cursor');
  return offset;
}

export class TasksProtocol {
  private readonly pageSize: number;
  private readonly maxResultWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollTickMs: number;
  private readonly actor: FileActor;

  constructor(private readonly services: McpApplicationServices, options: TasksProtocolOptions = {}) {
    this.actor = options.actor ?? { clientId: 'legacy', clientName: 'legacy' };
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxResultWaitMs = options.maxResultWaitMs ?? DEFAULT_MAX_RESULT_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTickMs = options.pollTickMs ?? DEFAULT_POLL_TICK_MS;
  }

  public async getTask(params: TaskIdParams): Promise<ProtocolTask> {
    return this.protocolTask(params.taskId);
  }

  public async listTasks(params: ListParams): Promise<{ tasks: ProtocolTask[]; nextCursor?: string }> {
    const offset = params.cursor === undefined ? 0 : decodeCursor(params.cursor);
    const snapshots = await this.listSnapshots();
    const pollIntervalMs = this.currentPollIntervalMs();
    const mapped = snapshots
      .map((snapshot) => toProtocolTask(snapshot, pollIntervalMs))
      .filter((task): task is ProtocolTask => task !== undefined);
    const tasks = mapped.slice(offset, offset + this.pageSize);
    const nextOffset = offset + tasks.length;
    return { tasks, ...(nextOffset < mapped.length ? { nextCursor: encodeCursor(nextOffset) } : {}) };
  }

  public async cancelTask(params: TaskIdParams): Promise<ProtocolTask> {
    const current = await this.protocolTask(params.taskId);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw invalidParams(`Cannot cancel task: already in terminal status '${current.status}'`);
    }
    const cancelled = await this.executeShell('cancel', params.taskId);
    if (!cancelled.ok) throw this.shellError(cancelled.error);
    const task = toProtocolTask(this.snapshot(cancelled.value), this.currentPollIntervalMs());
    if (task === undefined) throw invalidParams(`Task not found: ${params.taskId}`);
    return task;
  }

  /**
   * Returns the underlying shell task snapshot once the task reaches a
   * terminal status. The spec wants tasks/result to block until terminal,
   * but durable tasks are designed to outlive any reasonable request wait,
   * so this implementation blocks only for the configured MCP poll window
   * (5-60 seconds, 5 seconds by default) and then answers -32603 directing
   * the client back to tasks/get polling (documented deviation, see
   * docs/mcp/MCP_TASKS.md).
   */
  public async taskResult(params: TaskIdParams): Promise<TaskResultPayload> {
    const waitDeadline = Date.now() + this.currentMaxResultWaitMs();
    for (;;) {
      const result = await this.executeShell('status', params.taskId);
      if (!result.ok) throw this.shellError(result.error);
      const snapshot = this.snapshot(result.value);
      const task = toProtocolTask(snapshot, this.currentPollIntervalMs());
      if (task === undefined) throw invalidParams(`Task not found: ${params.taskId}`);
      if (TERMINAL_STATUSES.has(task.status)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
          isError: task.status === 'failed',
          _meta: { [RELATED_TASK_META_KEY]: { taskId: params.taskId } },
        };
      }
      if (Date.now() >= waitDeadline) {
        throw internalError(`Task ${params.taskId} is still ${task.status}; poll tasks/get later. Do not repeatedly poll in the same chat turn; preserve the taskId and return control while the durable task keeps running`);
      }
      await sleep(this.pollTickMs);
    }
  }

  private async protocolTask(taskId: string): Promise<ProtocolTask> {
    const result = await this.executeShell('status', taskId);
    if (!result.ok) throw this.shellError(result.error);
    const task = toProtocolTask(this.snapshot(result.value), this.currentPollIntervalMs());
    if (task === undefined) throw invalidParams(`Task not found: ${taskId}`);
    return task;
  }

  private currentConfiguredPollWaitMs(): number | undefined {
    const configured = this.services.runtimeTiming?.().mcpPollWaitSeconds;
    if (configured === undefined || !Number.isFinite(configured)) return undefined;
    const seconds = Math.max(MIN_CONFIGURABLE_WAIT_SECONDS, Math.min(MAX_CONFIGURABLE_WAIT_SECONDS, configured));
    return Math.round(seconds * 1_000);
  }

  private currentMaxResultWaitMs(): number {
    return this.currentConfiguredPollWaitMs() ?? this.maxResultWaitMs;
  }

  private currentPollIntervalMs(): number {
    return this.currentConfiguredPollWaitMs() ?? this.pollIntervalMs;
  }

  private async listSnapshots(): Promise<ShellSnapshot[]> {
    const result = await this.executeShell('list');
    if (!result.ok) throw this.shellError(result.error);
    const value = this.snapshot(result.value);
    if (!Array.isArray(value.tasks)) return [];
    return value.tasks.filter((task): task is ShellSnapshot => typeof task === 'object' && task !== null);
  }

  private async executeShell(operation: 'list'): Promise<Result<unknown>>;
  private async executeShell(operation: 'status' | 'cancel', taskId: string): Promise<Result<unknown>>;
  private async executeShell(operation: 'list' | 'status' | 'cancel', taskId?: string): Promise<Result<unknown>> {
    const capabilities = this.services.capabilities;
    if (capabilities === undefined) throw internalError('Capability service is unavailable');
    return capabilities.execute('shell', withCapabilityOwnerMetadata({
      operation,
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(operation === 'cancel' ? { userConfirmed: true } : {}),
      include_stdout: true,
      include_stderr: true,
    }, this.actor));
  }

  private shellError(error: AppError): ProtocolError {
    if (error.code === 'PROCESS_NOT_FOUND') return invalidParams(`Task not found: ${error.message}`);
    return internalError(error.message);
  }

  private snapshot(value: unknown): ShellSnapshot {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ShellSnapshot : {};
  }
}

/**
 * Wires tasks/get, tasks/result, tasks/list, and tasks/cancel onto an
 * McpServer's inner protocol. The server constructor must also advertise
 * `capabilities.tasks` for spec-aware clients to discover the surface.
 */
export function registerTasksProtocol(
  server: McpServer,
  services: McpApplicationServices,
  options: TasksProtocolOptions = {},
): TasksProtocol {
  const protocol = new TasksProtocol(services, options);
  const taskIdParams = z.object({ taskId: z.string() });
  const listParams = z.object({ cursor: z.string().optional() });
  const asWireResult = (result: Promise<unknown>): Promise<Record<string, unknown>> => result as Promise<Record<string, unknown>>;
  server.server.setRequestHandler('tasks/get', { params: taskIdParams }, async (params) => asWireResult(protocol.getTask(params)));
  server.server.setRequestHandler('tasks/result', { params: taskIdParams }, async (params) => asWireResult(protocol.taskResult(params)));
  server.server.setRequestHandler('tasks/list', { params: listParams }, async (params) => asWireResult(protocol.listTasks(params)));
  server.server.setRequestHandler('tasks/cancel', { params: taskIdParams }, async (params) => asWireResult(protocol.cancelTask(params)));
  return protocol;
}
