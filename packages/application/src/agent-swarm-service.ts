import { createHash, randomUUID } from 'node:crypto';
import { Redactor } from '@lnwjud/audit';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ProcessLogResult } from '@lnwjud/process';
import {
  SqliteAgentSwarmRepository,
  type StoredAgentSwarm,
  type StoredAgentSwarmState,
  type StoredAgentSwarmTask,
  type StoredAgentSwarmTaskState,
} from '@lnwjud/storage';
import type { FileActor } from './file-service.js';
import type {
  AgentSwarmListPage,
  AgentSwarmResultPage,
  AgentSwarmSnapshot,
  AgentSwarmStartRequest,
  AgentSwarmTaskRequest,
  AgentSwarmTaskSnapshot,
} from './agent-swarm-types.js';

const MAX_TASKS = 4;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 2_048;
const MONITOR_INTERVAL_MS = 250;
const REDACTOR = new Redactor();

export interface AgentSwarmCodexPort {
  run(actor: FileActor, workspaceId: string, instruction: string, signal?: AbortSignal, userConfirmed?: boolean, authorization?: InvocationAuthorization, sandboxMode?: 'read-only' | 'workspace-write'): Promise<Result<{ codexTaskId: string; processId: string }>>;
  taskStatus(actor: FileActor, workspaceId: string, codexTaskId: string): Promise<Result<ManagedProcess>>;
  taskLogs(actor: FileActor, workspaceId: string, codexTaskId: string, query: { tailLines?: number; sinceSequence?: number }): Promise<Result<ProcessLogResult>>;
  stop(actor: FileActor, workspaceId: string, codexTaskId: string, userConfirmed?: boolean, authorization?: InvocationAuthorization): Promise<Result<void>>;
}

interface LiveSwarm {
  readonly actor: FileActor;
  readonly workspaceId: string;
  readonly prompts: ReadonlyMap<string, string>;
  readonly authorization: InvocationAuthorization;
  readonly abortController: AbortController;
  monitor?: Promise<void>;
}

export class AgentSwarmService {
  private readonly live = new Map<string, LiveSwarm>();

  public constructor(
    private readonly repository: SqliteAgentSwarmRepository,
    private readonly codex: AgentSwarmCodexPort,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {
    // Never reattach by PID/task id after restart. Persisted active tasks are
    // explicitly downgraded to termination_unverified until a future verified
    // runtime-handle protocol exists.
    this.repository.markLiveTasksTerminationUnverified();
  }

  public async start(
    actor: FileActor,
    request: AgentSwarmStartRequest,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<AgentSwarmSnapshot>> {
    const validated = validateStart(request);
    if (!validated.ok) return validated;
    if (!isApplicationAuthorized(authorization, false)) {
      return err(appError('PERMISSION_REQUIRED', 'Starting an agent swarm requires trusted host approval'));
    }
    const ownerSessionId = actorSessionId(actor);
    const existing = this.repository.findByIdempotency(actor.clientId, ownerSessionId, request.workspaceId, request.idempotencyKey);
    if (existing !== undefined) return ok(toSnapshot(existing));

    const createdAt = this.now().toISOString();
    const maxConcurrency = request.maxConcurrency ?? Math.min(2, request.tasks.length);
    const stored = this.repository.create({
      id: this.idFactory(),
      ownerClientId: actor.clientId,
      ownerSessionId,
      workspaceId: request.workspaceId,
      idempotencyKey: request.idempotencyKey,
      maxConcurrency,
      createdAt,
      tasks: request.tasks.map((task) => ({
        id: task.id,
        promptDigest: sha256(task.prompt),
        promptLength: Buffer.byteLength(task.prompt, 'utf8'),
        dependsOn: task.dependsOn ?? [],
        state: (task.dependsOn?.length ?? 0) > 0 ? 'blocked' : 'queued',
      })),
    });
    const live: LiveSwarm = {
      actor,
      workspaceId: request.workspaceId,
      prompts: new Map(request.tasks.map((task) => [task.id, task.prompt])),
      authorization: authorization as InvocationAuthorization,
      abortController: new AbortController(),
    };
    this.live.set(stored.id, live);
    await this.tick(stored.id, live, signal);
    const afterInitialTick = this.requireOwned(actor, request.workspaceId, stored.id);
    if (!isTerminalSwarm(afterInitialTick.state) && !live.abortController.signal.aborted && signal?.aborted !== true) {
      live.monitor = this.monitor(stored.id, live, signal);
      void live.monitor.finally(() => this.live.delete(stored.id));
    } else {
      this.live.delete(stored.id);
    }
    return ok(toSnapshot(afterInitialTick));
  }

  public async status(actor: FileActor, workspaceId: string, swarmId: string): Promise<Result<AgentSwarmSnapshot>> {
    const swarm = this.repository.getOwned(swarmId, actor.clientId, actorSessionId(actor), workspaceId);
    return swarm === undefined ? err(appError('PROCESS_NOT_FOUND', 'Agent swarm was not found')) : ok(toSnapshot(swarm));
  }

  public async cancel(
    actor: FileActor,
    workspaceId: string,
    swarmId: string,
    authorization?: InvocationAuthorization,
  ): Promise<Result<AgentSwarmSnapshot>> {
    if (!isApplicationAuthorized(authorization, false)) {
      return err(appError('PERMISSION_REQUIRED', 'Cancelling an agent swarm requires trusted host approval'));
    }
    const swarm = this.repository.getOwned(swarmId, actor.clientId, actorSessionId(actor), workspaceId);
    if (swarm === undefined) return err(appError('PROCESS_NOT_FOUND', 'Agent swarm was not found'));
    if (isTerminalSwarm(swarm.state)) return ok(toSnapshot(swarm));
    const live = this.live.get(swarmId);
    live?.abortController.abort();
    for (const task of swarm.tasks) {
      if (task.state === 'queued' || task.state === 'blocked') {
        this.repository.updateTask(swarmId, task.id, { state: 'cancelled', finishedAt: this.now().toISOString() }, this.now().toISOString());
        continue;
      }
      if (task.state !== 'running' || task.codexTaskId === undefined) continue;
      const stopped = await this.codex.stop(actor, workspaceId, task.codexTaskId, false, authorization);
      this.repository.updateTask(swarmId, task.id, stopped.ok
        ? { state: 'cancelled', finishedAt: this.now().toISOString() }
        : { state: 'termination_unverified', error: boundedError(stopped.error.message), finishedAt: this.now().toISOString() }, this.now().toISOString());
    }
    const refreshed = this.requireOwned(actor, workspaceId, swarmId);
    const state = refreshed.tasks.some((task) => task.state === 'termination_unverified') ? 'termination_unverified' : 'cancelled';
    this.repository.updateSwarmState(swarmId, state, this.now().toISOString());
    return ok(toSnapshot(this.requireOwned(actor, workspaceId, swarmId)));
  }

  public async result(actor: FileActor, workspaceId: string, swarmId: string, taskId: string, cursor = '0', maxBytes = 8_192): Promise<Result<AgentSwarmResultPage>> {
    const swarm = this.repository.getOwned(swarmId, actor.clientId, actorSessionId(actor), workspaceId);
    if (swarm === undefined) return err(appError('PROCESS_NOT_FOUND', 'Agent swarm was not found'));
    const task = swarm.tasks.find((entry) => entry.id === taskId);
    if (task === undefined) return err(appError('PROCESS_NOT_FOUND', 'Agent swarm task was not found'));
    const offset = parseCursor(cursor);
    if (offset === undefined) return err(appError('INVALID_INPUT', 'Agent swarm result cursor is invalid'));
    const boundedMax = Math.max(1, Math.min(16_384, Math.trunc(maxBytes)));
    const page = utf8Page(task.resultText, offset, boundedMax);
    return ok({
      swarmId,
      taskId,
      state: task.state,
      text: page.text,
      ...(page.nextOffset === undefined ? {} : { nextCursor: String(page.nextOffset) }),
      eof: page.nextOffset === undefined,
      outputTruncated: task.outputTruncated,
    });
  }

  public async list(actor: FileActor, workspaceId: string, cursor = '0', limit = 20): Promise<Result<AgentSwarmListPage>> {
    const offset = parseCursor(cursor);
    if (offset === undefined) return err(appError('INVALID_INPUT', 'Agent swarm list cursor is invalid'));
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const items = this.repository.listOwned(actor.clientId, actorSessionId(actor), workspaceId, boundedLimit + 1, offset);
    const hasMore = items.length > boundedLimit;
    return ok({ items: items.slice(0, boundedLimit).map(toSnapshot), ...(hasMore ? { nextCursor: String(offset + boundedLimit) } : {}) });
  }

  private async monitor(swarmId: string, live: LiveSwarm, outerSignal?: AbortSignal): Promise<void> {
    while (!live.abortController.signal.aborted && outerSignal?.aborted !== true) {
      const swarm = this.repository.getOwned(swarmId, live.actor.clientId, actorSessionId(live.actor), live.workspaceId);
      if (swarm === undefined || isTerminalSwarm(swarm.state)) return;
      await this.tick(swarmId, live, outerSignal);
      const refreshed = this.repository.getOwned(swarmId, live.actor.clientId, actorSessionId(live.actor), swarm.workspaceId);
      if (refreshed === undefined || isTerminalSwarm(refreshed.state)) return;
      await delay(MONITOR_INTERVAL_MS);
    }
  }

  private async tick(swarmId: string, live: LiveSwarm, signal?: AbortSignal): Promise<void> {
    const swarm = this.repository.getOwned(swarmId, live.actor.clientId, actorSessionId(live.actor), live.workspaceId);
    if (swarm === undefined) return;
    for (const task of swarm.tasks.filter((entry) => entry.state === 'running' && entry.codexTaskId !== undefined)) {
      const status = await this.codex.taskStatus(live.actor, swarm.workspaceId, task.codexTaskId!);
      if (!status.ok) {
        if (status.error.code === 'PROCESS_NOT_FOUND') {
          this.repository.updateTask(swarmId, task.id, { state: 'termination_unverified', error: 'verified runtime handle is no longer available', finishedAt: this.now().toISOString() }, this.now().toISOString());
        }
        continue;
      }
      if (!isTerminalProcess(status.value.state)) continue;
      const logs = await this.codex.taskLogs(live.actor, swarm.workspaceId, task.codexTaskId!, { tailLines: 10_000 });
      const raw = logs.ok ? logs.value.entries.map((entry) => entry.text).join('') : '';
      const bounded = boundOutput(REDACTOR.redactText(raw));
      const completed = status.value.state === 'exited' && (status.value.exitCode ?? 0) === 0;
      this.repository.updateTask(swarmId, task.id, {
        state: completed ? 'completed' : 'failed',
        resultText: bounded.text,
        outputTruncated: bounded.truncated,
        ...(completed ? { error: null } : { error: boundedError(status.value.error ?? `Codex process ended in ${status.value.state}`) }),
        finishedAt: this.now().toISOString(),
      }, this.now().toISOString());
    }

    const dependencySwarm = this.requireOwned(live.actor, live.workspaceId, swarmId);
    const failedIds = new Set(dependencySwarm.tasks.filter((task) => ['failed', 'cancelled', 'termination_unverified'].includes(task.state)).map((task) => task.id));
    for (const task of dependencySwarm.tasks.filter((entry) => entry.state === 'blocked')) {
      if (task.dependsOn.some((id) => failedIds.has(id))) {
        this.repository.updateTask(swarmId, task.id, { state: 'failed', error: 'dependency did not complete successfully', finishedAt: this.now().toISOString() }, this.now().toISOString());
      } else if (task.dependsOn.every((id) => dependencySwarm.tasks.find((candidate) => candidate.id === id)?.state === 'completed')) {
        this.repository.updateTask(swarmId, task.id, { state: 'queued' }, this.now().toISOString());
      }
    }

    const launchSwarm = this.requireOwned(live.actor, live.workspaceId, swarmId);
    let running = launchSwarm.tasks.filter((task) => task.state === 'running').length;
    for (const task of launchSwarm.tasks.filter((entry) => entry.state === 'queued')) {
      if (running >= launchSwarm.maxConcurrency || signal?.aborted === true || live.abortController.signal.aborted) break;
      const prompt = live.prompts.get(task.id);
      if (prompt === undefined) {
        this.repository.updateTask(swarmId, task.id, { state: 'termination_unverified', error: 'ephemeral prompt unavailable after runtime restart', finishedAt: this.now().toISOString() }, this.now().toISOString());
        continue;
      }
      const started = await this.codex.run(live.actor, launchSwarm.workspaceId, prompt, signal, false, live.authorization, 'read-only');
      if (!started.ok) {
        this.repository.updateTask(swarmId, task.id, { state: 'failed', error: boundedError(started.error.message), finishedAt: this.now().toISOString() }, this.now().toISOString());
        await this.rollbackLaunchFailure(swarmId, live, task.id);
        return;
      }
      this.repository.updateTask(swarmId, task.id, { state: 'running', codexTaskId: started.value.codexTaskId, startedAt: this.now().toISOString() }, this.now().toISOString());
      running += 1;
    }
    this.refreshSwarmState(swarmId, live.actor, swarm.workspaceId);
  }

  private async rollbackLaunchFailure(swarmId: string, live: LiveSwarm, failedTaskId: string): Promise<void> {
    live.abortController.abort();
    const swarm = this.requireOwned(live.actor, live.workspaceId, swarmId);
    let terminationUnverified = false;
    for (const task of swarm.tasks) {
      if (task.id === failedTaskId) continue;
      if (task.state === 'running' && task.codexTaskId !== undefined) {
        const stopped = await this.codex.stop(live.actor, live.workspaceId, task.codexTaskId, false, live.authorization);
        if (stopped.ok) {
          this.repository.updateTask(swarmId, task.id, { state: 'cancelled', finishedAt: this.now().toISOString() }, this.now().toISOString());
        } else {
          terminationUnverified = true;
          this.repository.updateTask(swarmId, task.id, {
            state: 'termination_unverified',
            error: boundedError(stopped.error.message),
            finishedAt: this.now().toISOString(),
          }, this.now().toISOString());
        }
      } else if (task.state === 'queued' || task.state === 'blocked') {
        this.repository.updateTask(swarmId, task.id, {
          state: 'cancelled',
          error: 'launch batch aborted after another child failed to start',
          finishedAt: this.now().toISOString(),
        }, this.now().toISOString());
      }
    }
    this.repository.updateSwarmState(swarmId, terminationUnverified ? 'termination_unverified' : 'failed', this.now().toISOString());
  }

  private refreshSwarmState(swarmId: string, actor: FileActor, workspaceId: string): void {
    const swarm = this.requireOwned(actor, workspaceId, swarmId);
    let state: StoredAgentSwarmState = 'running';
    if (swarm.tasks.some((task) => task.state === 'termination_unverified')) state = 'termination_unverified';
    else if (swarm.tasks.every((task) => task.state === 'cancelled')) state = 'cancelled';
    else if (swarm.tasks.every((task) => isTerminalTask(task.state))) state = swarm.tasks.every((task) => task.state === 'completed') ? 'completed' : 'failed';
    else if (swarm.tasks.every((task) => task.state === 'queued' || task.state === 'blocked')) state = 'queued';
    this.repository.updateSwarmState(swarmId, state, this.now().toISOString());
  }

  private requireOwned(actor: FileActor, workspaceId: string, swarmId: string): StoredAgentSwarm {
    const swarm = this.repository.getOwned(swarmId, actor.clientId, actorSessionId(actor), workspaceId);
    if (swarm === undefined) throw new Error('Agent swarm ownership changed unexpectedly');
    return swarm;
  }
}

function validateStart(request: AgentSwarmStartRequest): Result<void> {
  if (request.accessMode !== 'read_only') return err(appError('PERMISSION_DENIED', 'Agent swarm v4.52.3 supports read_only access only'));
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > MAX_TASKS) return err(appError('INVALID_INPUT', 'Agent swarm requires 1 to 4 tasks'));
  const ids = new Set<string>();
  for (const task of request.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id) || ids.has(task.id)) return err(appError('INVALID_INPUT', 'Agent swarm task ids must be unique and bounded'));
    ids.add(task.id);
    if (task.prompt.trim().length === 0 || Buffer.byteLength(task.prompt, 'utf8') > MAX_PROMPT_BYTES) return err(appError('INVALID_INPUT', 'Agent swarm prompt is empty or too large'));
  }
  for (const task of request.tasks) {
    const deps: readonly string[] = task.dependsOn ?? [];
    if (deps.length > 3 || new Set(deps).size !== deps.length || deps.includes(task.id) || deps.some((id: string) => !ids.has(id))) return err(appError('INVALID_INPUT', 'Agent swarm dependency graph is invalid'));
  }
  if (hasCycle(request.tasks)) return err(appError('INVALID_INPUT', 'Agent swarm dependency graph must be acyclic'));
  const concurrency = request.maxConcurrency ?? Math.min(2, request.tasks.length);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_TASKS || concurrency > request.tasks.length) return err(appError('INVALID_INPUT', 'Agent swarm maxConcurrency is invalid'));
  return ok(undefined);
}

function hasCycle(tasks: readonly AgentSwarmTaskRequest[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (visit(dep)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function toSnapshot(swarm: StoredAgentSwarm): AgentSwarmSnapshot {
  return {
    swarmId: swarm.id,
    workspaceId: swarm.workspaceId,
    state: swarm.state,
    maxConcurrency: swarm.maxConcurrency,
    createdAt: swarm.createdAt,
    updatedAt: swarm.updatedAt,
    tasks: swarm.tasks.map(toTaskSnapshot),
  };
}

function toTaskSnapshot(task: StoredAgentSwarmTask): AgentSwarmTaskSnapshot {
  return {
    id: task.id,
    dependsOn: task.dependsOn,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    resultAvailable: task.resultText.length > 0,
    outputTruncated: task.outputTruncated,
    ...(task.error === undefined ? {} : { error: boundedError(task.error) }),
  };
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function actorSessionId(actor: FileActor): string { return actor.sessionId?.trim() || actor.clientId; }
function boundedError(value: string): string { return REDACTOR.redactText(value).slice(0, MAX_ERROR_CHARS); }
function isTerminalProcess(state: ManagedProcess['state']): boolean { return ['exited', 'failed', 'stopped', 'timed_out'].includes(state); }
function isTerminalTask(state: StoredAgentSwarmTaskState): boolean { return ['completed', 'failed', 'cancelled', 'termination_unverified'].includes(state); }
function isTerminalSwarm(state: StoredAgentSwarmState): boolean { return ['completed', 'failed', 'cancelled', 'termination_unverified'].includes(state); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function parseCursor(value: string): number | undefined { return /^\d{1,12}$/.test(value) ? Number.parseInt(value, 10) : undefined; }

function boundOutput(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= MAX_RESULT_BYTES) return { text: value, truncated: false };
  let text = bytes.subarray(0, MAX_RESULT_BYTES).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) text = text.slice(0, -1);
  return { text, truncated: true };
}

function utf8Page(value: string, offset: number, maxBytes: number): { text: string; nextOffset?: number } {
  if (offset >= value.length) return { text: '' };
  let end = offset;
  let bytes = 0;
  for (const char of value.slice(offset)) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  if (end === offset) return { text: '' };
  return end >= value.length ? { text: value.slice(offset) } : { text: value.slice(offset, end), nextOffset: end };
}
