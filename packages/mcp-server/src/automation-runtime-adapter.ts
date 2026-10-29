import {
  appError,
  err,
  ok,
  type AppErrorCode,
  type Result,
} from '@lnwjud/domain';
import type {
  AutomationDispatchObservation,
  AutomationDispatchPort,
  AutomationDispatchRequest,
  AutomationTaskEvidenceSnapshot,
  AutomationVerificationRuntimePort,
  FileActor,
} from '@lnwjud/application';
import type { McpToolResponse } from './result-mapper.js';

export interface AutomationToolRegistryPort {
  invokeAutomationShell(request: AutomationDispatchRequest, traceContext?: unknown, parentSignal?: AbortSignal): Promise<McpToolResponse>;
  observeAutomationShell(context: AutomationDispatchRequest['context']): Promise<Result<unknown>>;
}

export class AutomationRuntimeAdapter implements AutomationDispatchPort, AutomationVerificationRuntimePort {
  public constructor(
    private readonly registry: AutomationToolRegistryPort,
    private readonly owner: FileActor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async launch(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>> {
    const ownership = this.assertActor(actor);
    if (!ownership.ok) return ownership;
    const response = await this.registry.invokeAutomationShell(request);
    if (response.isError === true) return err(responseError(response));
    return observationFromSnapshot(response.structuredContent, request, this.now);
  }

  public async observe(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>> {
    const ownership = this.assertActor(actor);
    if (!ownership.ok) return ownership;
    const observed = await this.registry.observeAutomationShell(request.context);
    if (!observed.ok) {
      if (observed.error.code === 'PROCESS_NOT_FOUND') {
        return ok({ presence: 'absent', observedAt: this.now().toISOString() });
      }
      return observed;
    }
    return observationFromSnapshot(observed.value, request, this.now);
  }

  public async readTask(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationTaskEvidenceSnapshot>> {
    const ownership = this.assertActor(actor);
    if (!ownership.ok) return ownership;
    const observed = await this.registry.observeAutomationShell(request.context);
    if (!observed.ok) {
      if (observed.error.code === 'PROCESS_NOT_FOUND') {
        return ok(expectedUnknownEvidence(request, this.owner.clientId, this.now));
      }
      return observed;
    }
    return taskEvidenceFromSnapshot(observed.value, request, this.owner.clientId, this.now);
  }

  public async ensureTask(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationTaskEvidenceSnapshot>> {
    const ownership = this.assertActor(actor);
    if (!ownership.ok) return ownership;
    const response = await this.registry.invokeAutomationShell(request);
    if (response.isError === true) return err(responseError(response));
    return taskEvidenceFromSnapshot(response.structuredContent, request, this.owner.clientId, this.now);
  }

  private assertActor(actor: FileActor): Result<void> {
    if (actor.clientId !== this.owner.clientId || stableSession(actor) !== stableSession(this.owner)) {
      return err(appError('PERMISSION_DENIED', 'Automation runtime actor does not own this ToolRegistry'));
    }
    return ok(undefined);
  }
}

function taskEvidenceFromSnapshot(
  value: unknown,
  request: AutomationDispatchRequest,
  ownerClientId: string,
  now: () => Date,
): Result<AutomationTaskEvidenceSnapshot> {
  if (!isRecord(value)) return err(appError('INTERNAL_ERROR', 'Automation shell returned an invalid evidence snapshot', true));
  if (value.task_id !== request.context.taskId) {
    return err(appError('CONFLICT', 'Automation shell returned a different durable task identity', true));
  }
  const rawState = typeof value.state === 'string' ? value.state : 'unknown';
  const state = rawState === 'starting'
    ? 'running'
    : rawState === 'running'
    || rawState === 'completed'
    || rawState === 'failed'
    || rawState === 'cancelled'
    || rawState === 'timed_out'
    || rawState === 'termination_unverified'
      ? rawState
      : 'unknown';
  const exitCode = typeof value.exit_code === 'number' && Number.isInteger(value.exit_code)
    ? value.exit_code
    : undefined;
  return ok({
    taskId: request.context.taskId,
    ownerClientId,
    workspaceId: request.context.workspaceId,
    requestDigest: request.context.requestDigest,
    state,
    observedAt: timestamp(value.finished_at) ?? timestamp(value.started_at) ?? now().toISOString(),
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

function expectedUnknownEvidence(
  request: AutomationDispatchRequest,
  ownerClientId: string,
  now: () => Date,
): AutomationTaskEvidenceSnapshot {
  return {
    taskId: request.context.taskId,
    ownerClientId,
    workspaceId: request.context.workspaceId,
    requestDigest: request.context.requestDigest,
    state: 'unknown',
    observedAt: now().toISOString(),
  };
}

function observationFromSnapshot(
  value: unknown,
  request: AutomationDispatchRequest,
  now: () => Date,
): Result<AutomationDispatchObservation> {
  if (!isRecord(value)) return err(appError('INTERNAL_ERROR', 'Automation shell returned an invalid task snapshot', true));
  if (value.task_id !== request.context.taskId) {
    return err(appError('CONFLICT', 'Automation shell returned a different durable task identity', true));
  }
  const observedAt = timestamp(value.finished_at) ?? timestamp(value.started_at) ?? now().toISOString();
  const state = typeof value.state === 'string' ? value.state : undefined;
  if (state === 'starting' || state === 'running') return ok({ presence: 'found', state: 'running', observedAt });
  if (state === 'completed') {
    return ok({ presence: 'found', state: 'completed', observedAt, terminalState: terminalState(value, state) });
  }
  if (state === 'failed' || state === 'timed_out') {
    return ok({ presence: 'found', state: 'failed', observedAt, terminalState: terminalState(value, state) });
  }
  if (state === 'cancelled') {
    return ok({ presence: 'found', state: 'cancelled', observedAt, terminalState: terminalState(value, state) });
  }
  if (state === 'termination_unverified') {
    return ok({ presence: 'unknown', observedAt, detail: 'Durable task termination is unverified' });
  }
  return ok({ presence: 'unknown', observedAt, detail: 'Durable task state is unknown' });
}

function responseError(response: McpToolResponse): ReturnType<typeof appError> {
  const raw = isRecord(response.structuredContent?.error) ? response.structuredContent.error : undefined;
  const code = isAppErrorCode(raw?.code) ? raw.code : 'INTERNAL_ERROR';
  const message = typeof raw?.message === 'string' && raw.message.length > 0
    ? raw.message
    : 'Automation shell invocation failed';
  return appError(code, message, raw?.recoverable === true);
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && new Set<AppErrorCode>([
    'INVALID_INPUT', 'CONFLICT', 'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED',
    'PERMISSION_DENIED', 'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE',
    'PROCESS_NOT_FOUND', 'PROCESS_TIMEOUT', 'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY',
    'CODEX_NOT_AVAILABLE', 'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
  ]).has(value as AppErrorCode);
}

function stableSession(actor: FileActor): string {
  return actor.sessionId?.trim() || actor.clientId;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function terminalState(value: Readonly<Record<string, unknown>>, state: string): string {
  return typeof value.exit_code === 'number' ? `${state}:${value.exit_code}` : state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
