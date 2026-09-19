import type { AutomationAuditInput } from '@lnwjud/audit';
import {
  AutomationStateError,
  type AutomationEventMetadataValue,
  type AutomationEventRecord,
  type AutomationEventType,
  type AutomationRepository,
  type AutomationRunSnapshot,
  type AutomationTaskProvider,
  type CommitAutomationTransitionRequest,
  type CreateAutomationRunRecordRequest,
} from '@lnwjud/domain';

const MAX_OBSERVABILITY_RUNS = 50;
const MAX_OBSERVABILITY_EVENTS = 200;

export interface AutomationObservabilityActor {
  readonly actorId: string;
  readonly actorName: string;
  readonly sessionId?: string;
}

export interface AutomationObservabilitySink {
  recordAutomationEvent(input: AutomationAuditInput): Promise<void>;
}

export interface AutomationObservabilityOptions {
  readonly onAuditError?: (error: unknown, input: AutomationAuditInput) => void;
}

export interface AutomationTaskReadModel {
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
  readonly role: 'blocking_job' | 'supporting_service';
  readonly state: string | null;
  readonly deadlineAt: string | null;
  readonly lastObservedAt: string | null;
  readonly terminalAt: string | null;
}

export interface AutomationMilestoneReadModel {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly currentAttemptId: string | null;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly verificationOutcome: 'passed' | 'failed' | 'pending' | null;
  readonly tasks: readonly AutomationTaskReadModel[];
}

export interface AutomationEventReadModel {
  readonly id: string;
  readonly timestamp: string;
  readonly transition: AutomationEventType;
  readonly reason: string;
  readonly milestoneId: string | null;
  readonly attemptId: string | null;
  readonly taskProvider: AutomationTaskProvider | null;
  readonly taskId: string | null;
  readonly childCallId: string | null;
  readonly leaseGeneration: number | null;
  readonly policyDecision: string | null;
  readonly recoveryClassification: string | null;
  readonly verificationOutcome: 'passed' | 'failed' | 'pending' | null;
  readonly elapsedDurationMs: number;
  readonly retryCount: number;
}

export interface AutomationRunReadModel {
  readonly runId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly policyProfile: string;
  readonly revision: number;
  readonly goalRevision: number;
  readonly userIntentRevision: number;
  readonly currentMilestoneId: string | null;
  readonly currentAttemptId: string | null;
  readonly lastRecoveryDecision: string | null;
  readonly latestTransition: string | null;
  readonly latestReason: string | null;
  readonly latestPolicyDecision: string | null;
  readonly latestRecoveryClassification: string | null;
  readonly verificationOutcome: 'passed' | 'failed' | 'pending' | null;
  readonly elapsedDurationMs: number;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly milestones: readonly AutomationMilestoneReadModel[];
  readonly recentEvents: readonly AutomationEventReadModel[];
}

export interface AutomationDashboardReadModel {
  readonly generatedAt: string;
  readonly activeCount: number;
  readonly blockedCount: number;
  readonly waitingTaskCount: number;
  readonly completingCount: number;
  readonly recentRuns: readonly AutomationRunReadModel[];
}

/**
 * Read-only projection over authoritative automation state. This service never
 * mutates a run and intentionally exposes no raw lease token, idempotency key,
 * execution payload, or private model reasoning.
 */
export class AutomationObservabilityService {
  public constructor(
    private readonly repository: AutomationRepository,
    private readonly now: () => Date = (): Date => new Date(),
  ) {}

  public async readRun(runId: string, eventLimit = 100): Promise<AutomationRunReadModel> {
    const run = await this.repository.getRunById(runId);
    if (run === null) throw new AutomationStateError('not_found', 'Automation run was not found');
    const events = await this.repository.listEvents(run.id, boundedEventLimit(eventLimit));
    return projectRun(run, events, this.now());
  }

  public async readByGoal(goalId: string, eventLimit = 100): Promise<AutomationRunReadModel | null> {
    const run = await this.repository.getRunByGoalId(goalId);
    if (run === null) return null;
    const events = await this.repository.listEvents(run.id, boundedEventLimit(eventLimit));
    return projectRun(run, events, this.now());
  }

  public async dashboard(runLimit = 20, eventLimit = 20): Promise<AutomationDashboardReadModel> {
    const runs = await this.repository.listRuns(boundedRunLimit(runLimit));
    const recentRuns = await Promise.all(runs.map(async (run) => {
      const events = await this.repository.listEvents(run.id, boundedEventLimit(eventLimit));
      return projectRun(run, events, this.now());
    }));
    return {
      generatedAt: this.now().toISOString(),
      activeCount: recentRuns.filter((run) => !isTerminalStatus(run.status)).length,
      blockedCount: recentRuns.filter((run) => run.status === 'blocked').length,
      waitingTaskCount: recentRuns.filter((run) => run.status === 'waiting_task').length,
      completingCount: recentRuns.filter((run) => run.status === 'completing').length,
      recentRuns,
    };
  }
}

/**
 * Repository decorator that projects every committed automation transition into
 * the existing audit/activity stream. Audit failures are fail-open: the
 * authoritative SQLite transition has already committed and observability must
 * never roll back real work.
 */
export class ObservableAutomationRepository implements AutomationRepository {
  private readonly onAuditError: (error: unknown, input: AutomationAuditInput) => void;

  public constructor(
    private readonly delegate: AutomationRepository,
    private readonly sink: AutomationObservabilitySink,
    private readonly actor: AutomationObservabilityActor,
    options: AutomationObservabilityOptions = {},
  ) {
    this.onAuditError = options.onAuditError ?? ((): void => undefined);
  }

  public async createRun(request: CreateAutomationRunRecordRequest): Promise<AutomationRunSnapshot> {
    const existing = await this.delegate.getRunByGoalId(request.goalId);
    const run = await this.delegate.createRun(request);
    if (
      existing === null
      && run.id === request.runId
      && run.createdAt === request.createdAt
    ) {
      await this.emit(run, {
        id: request.eventId,
        runId: run.id,
        revisionBefore: 0,
        revisionAfter: 0,
        type: 'run_created',
        reason: 'automation_run_created',
        metadata: {
          milestoneCount: request.milestones.length,
          policyProfile: request.policyProfile,
        },
        createdAt: request.createdAt,
      });
    }
    return run;
  }

  public getRunById(runId: string): Promise<AutomationRunSnapshot | null> {
    return this.delegate.getRunById(runId);
  }

  public getRunByGoalId(goalId: string): Promise<AutomationRunSnapshot | null> {
    return this.delegate.getRunByGoalId(goalId);
  }

  public listRuns(limit: number): Promise<readonly AutomationRunSnapshot[]> {
    return this.delegate.listRuns(limit);
  }

  public listEvents(runId: string, limit: number): Promise<readonly AutomationEventRecord[]> {
    return this.delegate.listEvents(runId, limit);
  }

  public async commitTransition(
    request: CommitAutomationTransitionRequest,
  ): Promise<AutomationRunSnapshot> {
    const run = await this.delegate.commitTransition(request);
    const events = [request.event, ...(request.additionalEvents ?? [])];
    for (const event of events) {
      await this.emit(run, {
        id: event.id,
        runId: run.id,
        ...(event.milestoneId === undefined ? {} : { milestoneId: event.milestoneId }),
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
        revisionBefore: request.expectedRevision,
        revisionAfter: run.revision,
        type: event.type,
        reason: event.reason,
        metadata: event.metadata ?? {},
        createdAt: request.now,
      });
    }
    return run;
  }

  private async emit(run: AutomationRunSnapshot, event: AutomationEventRecord): Promise<void> {
    const input = toAutomationAuditInput(run, event, this.actor);
    try {
      await this.sink.recordAutomationEvent(input);
    } catch (error) {
      try {
        this.onAuditError(error, input);
      } catch {
        // Diagnostics are observability-only and must never fail committed automation work.
      }
    }
  }
}

export function projectAutomationEvent(
  run: AutomationRunSnapshot,
  event: AutomationEventRecord,
): AutomationEventReadModel {
  const task = taskIdentity(run, event);
  const metadataProvider = metadataTaskProvider(event);
  return {
    id: event.id,
    timestamp: event.createdAt,
    transition: event.type,
    reason: event.reason,
    milestoneId: event.milestoneId ?? null,
    attemptId: event.attemptId ?? null,
    taskProvider: task?.provider ?? metadataProvider,
    taskId: task?.taskId ?? null,
    childCallId: metadataString(event, 'childCallId') ?? null,
    leaseGeneration: metadataInteger(event, 'leaseGeneration'),
    policyDecision: policyDecision(event),
    recoveryClassification: recoveryClassification(event),
    verificationOutcome: verificationOutcome(event),
    elapsedDurationMs: elapsedMs(run.createdAt, event.createdAt),
    retryCount: retryCount(run, event.milestoneId),
  };
}

function projectRun(
  run: AutomationRunSnapshot,
  events: readonly AutomationEventRecord[],
  now: Date,
): AutomationRunReadModel {
  const projectedEvents = events.map((event) => projectAutomationEvent(run, event));
  const latest = projectedEvents[0] ?? null;
  const latestPolicy = projectedEvents.find((event) => event.policyDecision !== null)?.policyDecision ?? null;
  const latestRecovery = projectedEvents.find((event) => event.recoveryClassification !== null)?.recoveryClassification
    ?? run.lastRecoveryDecision
    ?? null;
  const latestVerification = projectedEvents.find((event) => event.verificationOutcome !== null)?.verificationOutcome ?? null;
  const endAt = run.terminalAt ?? now.toISOString();

  return {
    runId: run.id,
    goalId: run.goalId,
    workspaceId: run.workspaceId,
    status: run.status,
    policyProfile: run.policyProfile,
    revision: run.revision,
    goalRevision: run.basedOnGoalRevision,
    userIntentRevision: run.basedOnUserIntentRevision,
    currentMilestoneId: run.currentMilestoneId ?? null,
    currentAttemptId: run.currentAttemptId ?? null,
    lastRecoveryDecision: run.lastRecoveryDecision ?? null,
    latestTransition: latest?.transition ?? null,
    latestReason: latest?.reason ?? null,
    latestPolicyDecision: latestPolicy,
    latestRecoveryClassification: latestRecovery,
    verificationOutcome: latestVerification,
    elapsedDurationMs: elapsedMs(run.createdAt, endAt),
    retryCount: totalRetryCount(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    terminalAt: run.terminalAt ?? null,
    milestones: run.milestones.map((milestone) => {
      const attempts = run.attempts.filter((attempt) => attempt.milestoneId === milestone.id);
      const tasks = run.taskBindings
        .filter((binding) => attempts.some((attempt) => attempt.id === binding.attemptId))
        .map((binding): AutomationTaskReadModel => ({
          provider: binding.provider,
          taskId: binding.taskId,
          role: binding.role,
          state: binding.lastState ?? null,
          deadlineAt: binding.deadlineAt ?? null,
          lastObservedAt: binding.lastObservedAt ?? null,
          terminalAt: binding.terminalAt ?? null,
        }));
      return {
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        currentAttemptId: milestone.currentAttemptId ?? null,
        attemptCount: attempts.length,
        retryCount: Math.max(0, attempts.length - 1),
        verificationOutcome: milestoneVerificationOutcome(attempts),
        tasks,
      };
    }),
    recentEvents: projectedEvents,
  };
}

function toAutomationAuditInput(
  run: AutomationRunSnapshot,
  event: AutomationEventRecord,
  actor: AutomationObservabilityActor,
): AutomationAuditInput {
  const projected = projectAutomationEvent(run, event);
  return {
    timestamp: event.createdAt,
    actorId: actor.actorId,
    actorName: actor.actorName,
    workspaceId: run.workspaceId,
    ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
    eventId: event.id,
    runId: run.id,
    goalId: run.goalId,
    ...(event.milestoneId === undefined ? {} : { milestoneId: event.milestoneId }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    transition: event.type,
    reason: event.reason,
    ...(projected.taskProvider === null ? {} : { taskProvider: projected.taskProvider }),
    ...(projected.taskId === null ? {} : { taskId: projected.taskId }),
    ...(projected.childCallId === null ? {} : { childCallId: projected.childCallId }),
    ...(projected.leaseGeneration === null ? {} : { leaseGeneration: projected.leaseGeneration }),
    ...(projected.policyDecision === null ? {} : { policyDecision: projected.policyDecision }),
    ...(projected.recoveryClassification === null ? {} : { recoveryClassification: projected.recoveryClassification }),
    ...(projected.verificationOutcome === null ? {} : { verificationOutcome: projected.verificationOutcome }),
    elapsedDurationMs: projected.elapsedDurationMs,
    retryCount: projected.retryCount,
    resultCode: eventResultCode(event),
  };
}

function metadataTaskProvider(event: AutomationEventRecord): AutomationTaskProvider | null {
  const provider = metadataString(event, 'provider');
  return provider === 'process' || provider === 'codex' || provider === 'shell' ? provider : null;
}

function taskIdentity(
  run: AutomationRunSnapshot,
  event: AutomationEventRecord,
): { readonly provider: AutomationTaskProvider; readonly taskId: string } | null {
  const metadataProvider = metadataString(event, 'provider');
  const metadataTaskId = metadataString(event, 'taskId');
  if (
    (metadataProvider === 'process' || metadataProvider === 'codex' || metadataProvider === 'shell')
    && metadataTaskId !== undefined
  ) {
    return { provider: metadataProvider, taskId: metadataTaskId };
  }

  if (event.attemptId !== undefined) {
    const bindings = run.taskBindings.filter((binding) => binding.attemptId === event.attemptId);
    const binding = bindings.at(-1);
    if (binding !== undefined) return { provider: binding.provider, taskId: binding.taskId };
    const receipts = run.dispatchReceipts
      .filter((candidate) => candidate.attemptId === event.attemptId);
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const receipt = receipts[index];
      if (receipt?.provider !== undefined && receipt.externalId !== undefined) {
        return { provider: receipt.provider, taskId: receipt.externalId };
      }
    }
  }
  return null;
}

function policyDecision(event: AutomationEventRecord): string | null {
  if (event.type === 'policy_denied') return event.reason;
  return metadataString(event, 'policyDecision') ?? null;
}

function recoveryClassification(event: AutomationEventRecord): string | null {
  if (event.type === 'task_recovery_decision') {
    return metadataString(event, 'classification') ?? event.reason;
  }
  if (event.type === 'recovery_reconciled' || event.type === 'dispatch_unresolved') {
    return metadataString(event, 'classification') ?? event.reason;
  }
  return null;
}

function verificationOutcome(
  event: AutomationEventRecord,
): 'passed' | 'failed' | 'pending' | null {
  if (event.type === 'verification_passed' || event.type === 'milestone_completed') return 'passed';
  if (event.type === 'verification_failed') return 'failed';
  if (event.type === 'verification_started') return 'pending';
  return null;
}

function milestoneVerificationOutcome(
  attempts: readonly AutomationRunSnapshot['attempts'][number][],
): 'passed' | 'failed' | 'pending' | null {
  const latest = attempts.at(-1);
  if (latest === undefined) return null;
  if (latest.status === 'completed' && latest.verificationEvidence.length > 0) return 'passed';
  if (latest.status === 'failed') return 'failed';
  if (latest.status === 'verifying') return 'pending';
  return null;
}

function eventResultCode(event: AutomationEventRecord): string {
  if (
    event.type === 'policy_denied'
    || event.type === 'verification_failed'
    || event.type === 'attempt_failed'
    || event.type === 'milestone_blocked'
  ) return 'FAILED';
  if (
    event.type === 'dispatch_unresolved'
    || event.type === 'task_deadline_exceeded'
    || event.type === 'task_recovery_decision'
  ) return 'UNKNOWN';
  return 'SUCCESS';
}

function retryCount(run: AutomationRunSnapshot, milestoneId: string | undefined): number {
  if (milestoneId === undefined) return totalRetryCount(run);
  const attempts = run.attempts.filter((attempt) => attempt.milestoneId === milestoneId);
  return Math.max(0, attempts.length - 1);
}

function totalRetryCount(run: AutomationRunSnapshot): number {
  return run.milestones.reduce((sum, milestone) => (
    sum + Math.max(0, run.attempts.filter((attempt) => attempt.milestoneId === milestone.id).length - 1)
  ), 0);
}

function metadataString(event: AutomationEventRecord, key: string): string | undefined {
  const value: AutomationEventMetadataValue | undefined = event.metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataInteger(event: AutomationEventRecord, key: string): number | null {
  const value: AutomationEventMetadataValue | undefined = event.metadata[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function elapsedMs(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(endMs - startMs));
}

function boundedRunLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OBSERVABILITY_RUNS) {
    throw new AutomationStateError(
      'conflict',
      `Automation observability run limit must be between 1 and ${MAX_OBSERVABILITY_RUNS}`,
    );
  }
  return limit;
}

function boundedEventLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OBSERVABILITY_EVENTS) {
    throw new AutomationStateError(
      'conflict',
      `Automation observability event limit must be between 1 and ${MAX_OBSERVABILITY_EVENTS}`,
    );
  }
  return limit;
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
