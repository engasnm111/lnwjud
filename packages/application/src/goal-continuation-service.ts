import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GoalStateError,
  appError,
  err,
  ok,
  type GoalCheckpointRecord,
  type GoalEvidence,
  type GoalPlan,
  type GoalPlanStep,
  type GoalRecord,
  type GoalRepository,
  type GoalStatus,
  type GoalStepStatus,
  type GoalStepUpdate,
  type GoalTerminalStatus,
  type Result,
} from '@lnwjud/domain';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';

export const DEFAULT_GOAL_LEASE_SECONDS = 600;
export const MIN_GOAL_LEASE_SECONDS = 30;
export const MAX_GOAL_LEASE_SECONDS = 3_600;

const MAX_OWNER_CLIENT_ID = 128;
const MAX_GOAL_KEY = 128;
const MAX_OBJECTIVE = 4_096;
const MAX_PHASE = 256;
const MAX_SUMMARY = 2_048;
const MAX_NEXT_ACTION = 1_024;
const MAX_STEP_ID = 128;
const MAX_STEP_TITLE = 512;
const MAX_STEP_SUMMARY = 1_024;
const MAX_STEPS = 100;
const MAX_BLOCKERS = 20;
const MAX_BLOCKER = 512;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_VALUE = 1_024;
const MAX_ACTIVE_TASKS = 50;
const MAX_TASK_ID = 256;

export interface GoalPlanInputStep {
  readonly id: string;
  readonly title: string;
}

export interface GoalPlanInput {
  readonly steps: readonly GoalPlanInputStep[];
}

export interface RunGoalRequest {
  readonly workspaceId: string;
  readonly goalKey: string;
  readonly objective?: string;
  readonly plan?: GoalPlanInput;
  readonly leaseSeconds?: number;
}

export interface GetGoalRequest {
  readonly goalId?: string;
  readonly workspaceId?: string;
  readonly goalKey?: string;
}

export interface CheckpointGoalRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds: readonly string[];
  readonly releaseLease?: boolean;
}

export interface FinishGoalRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly status: GoalTerminalStatus;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
}

export interface ListGoalsRequest {
  readonly workspaceId?: string;
  readonly status?: GoalStatus;
  readonly limit?: number;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly goalKey: string;
  readonly workspaceId: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly currentPhase: string;
  readonly plan: GoalPlan;
  readonly completedSteps: readonly GoalPlanStep[];
  readonly pendingSteps: readonly GoalPlanStep[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly lastCheckpoint: GoalCheckpointRecord | null;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalSummary?: string;
  readonly terminalEvidence?: readonly GoalEvidence[];
  readonly terminalAt?: string;
}

export interface RunGoalResult extends Omit<GoalSnapshot, 'workspaceId' | 'objective' | 'createdAt' | 'updatedAt' | 'terminalSummary' | 'terminalEvidence' | 'terminalAt'> {
  readonly acquired: boolean;
  readonly leaseToken?: string;
  readonly retryAfterSeconds?: number;
}

export interface ListGoalsResult {
  readonly goals: readonly GoalSnapshot[];
}

export interface GoalContinuationServiceOptions {
  readonly now?: () => Date;
}

export class GoalContinuationService {
  private readonly now: () => Date;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly goals: GoalRepository,
    options: GoalContinuationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async runGoal(actor: FileActor, request: RunGoalRequest): Promise<Result<RunGoalResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const workspaceId = requiredBounded(request.workspaceId, 'workspaceId', 128);
      if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const goalKey = normalizeGoalKey(request.goalKey);
      const existing = await this.goals.getByKey(workspaceId, goalKey);
      if (existing !== null && existing.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (existing === null && request.objective === undefined) return err(appError('INVALID_INPUT', 'objective is required when creating a goal'));

      const objective = request.objective === undefined ? undefined : safeText(request.objective, MAX_OBJECTIVE, 'objective');
      const plan = request.plan === undefined
        ? (existing === null ? { steps: [] } : undefined)
        : normalizePlan(request.plan);
      const leaseSeconds = normalizeLeaseSeconds(request.leaseSeconds);
      const leaseToken = createLeaseToken();
      const acquired = await this.goals.acquire({
        goalId: randomUUID(),
        workspaceId,
        goalKey,
        ownerClientId,
        ...(objective === undefined ? {} : { objective }),
        ...(plan === undefined ? {} : { plan }),
        leaseTokenHash: hashLeaseToken(leaseToken),
        leaseSeconds,
        now: this.now().toISOString(),
      });
      const base = toRunSnapshot(acquired.goal);
      return ok({
        ...base,
        acquired: acquired.acquired,
        ...(acquired.acquired ? { leaseToken } : {}),
        ...(acquired.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: acquired.retryAfterSeconds }),
      });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async getGoal(actor: FileActor, request: GetGoalRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const byId = request.goalId !== undefined;
      const byKey = request.workspaceId !== undefined || request.goalKey !== undefined;
      if (byId === byKey) return err(appError('INVALID_INPUT', 'Use goalId or workspaceId + goalKey, but not both'));
      if (!byId) {
        const workspaceId = requiredBounded(request.workspaceId!, 'workspaceId', 128);
        if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      }
      const goal = byId
        ? await this.goals.getById(requiredBounded(request.goalId!, 'goalId', 128))
        : await this.goals.getByKey(
          requiredBounded(request.workspaceId!, 'workspaceId', 128),
          normalizeGoalKey(request.goalKey!),
        );
      if (goal === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (goal.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async checkpointGoal(actor: FileActor, request: CheckpointGoalRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const stepUpdates = normalizeStepUpdates(request.stepUpdates, current.plan);
      const updatedPlan = applyStepUpdates(current.plan, stepUpdates);
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        plan: updatedPlan,
        currentPhase: safeText(request.currentPhase, MAX_PHASE, 'currentPhase'),
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        stepUpdates,
        nextAction: safeText(request.nextAction, MAX_NEXT_ACTION, 'nextAction', true),
        blockers: normalizeStrings(request.blockers, MAX_BLOCKERS, MAX_BLOCKER, 'blockers'),
        evidence: normalizeEvidence(request.evidence),
        activeTaskIds: normalizeTaskIds(request.activeTaskIds),
        releaseLease: request.releaseLease === true,
        now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async finishGoal(actor: FileActor, request: FinishGoalRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const goal = await this.goals.finish({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        status: request.status,
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        evidence: normalizeEvidence(request.evidence),
        now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async listGoals(actor: FileActor, request: ListGoalsRequest): Promise<Result<ListGoalsResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const limit = request.limit === undefined ? 50 : request.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(appError('INVALID_INPUT', 'limit must be between 1 and 100'));
      let workspaceId: string | undefined;
      if (request.workspaceId !== undefined) {
        workspaceId = requiredBounded(request.workspaceId, 'workspaceId', 128);
        if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      }
      const goals = await this.goals.list({
        ownerClientId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(request.status === undefined ? {} : { status: request.status }),
        limit,
      });
      return ok({ goals: goals.map(toSnapshot) });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  private mapError(error: unknown): Result<never> {
    if (error instanceof GoalStateError) {
      switch (error.reason) {
        case 'owner_mismatch': return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
        case 'lease_invalid': return err(appError('PERMISSION_DENIED', 'Goal lease is invalid or expired', true));
        case 'conflict': return err(appError('CONFLICT', 'Goal state changed concurrently; read the latest revision and retry', true));
        case 'terminal': return err(appError('CONFLICT', 'Goal is already terminal'));
        case 'not_found': return err(appError('INVALID_INPUT', 'Goal was not found'));
        case 'corrupt': return err(appError('INTERNAL_ERROR', 'Durable goal state is corrupt and was rejected'));
      }
    }
    if (error instanceof Error) return err(appError('INVALID_INPUT', 'Durable goal input is invalid'));
    return err(appError('INTERNAL_ERROR', 'Durable goal operation failed'));
  }
}

function toRunSnapshot(goal: GoalRecord): Omit<RunGoalResult, 'acquired' | 'leaseToken' | 'retryAfterSeconds'> {
  const snapshot = toSnapshot(goal);
  return {
    goalId: snapshot.goalId,
    goalKey: snapshot.goalKey,
    status: snapshot.status,
    revision: snapshot.revision,
    currentPhase: snapshot.currentPhase,
    plan: snapshot.plan,
    completedSteps: snapshot.completedSteps,
    pendingSteps: snapshot.pendingSteps,
    nextAction: snapshot.nextAction,
    blockers: snapshot.blockers,
    activeTaskIds: snapshot.activeTaskIds,
    lastCheckpoint: snapshot.lastCheckpoint,
    ...(snapshot.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: snapshot.leaseExpiresAt }),
  };
}

function toSnapshot(goal: GoalRecord): GoalSnapshot {
  return {
    goalId: goal.id,
    goalKey: goal.goalKey,
    workspaceId: goal.workspaceId,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    currentPhase: goal.currentPhase,
    plan: goal.plan,
    completedSteps: goal.plan.steps.filter((step) => step.status === 'completed'),
    pendingSteps: goal.plan.steps.filter((step) => step.status !== 'completed'),
    nextAction: goal.nextAction || nextActionFromPlan(goal.plan),
    blockers: goal.blockers,
    activeTaskIds: goal.activeTaskIds,
    lastCheckpoint: goal.checkpoints.at(-1) ?? null,
    ...(goal.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: goal.leaseExpiresAt }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.terminalSummary === undefined ? {} : { terminalSummary: goal.terminalSummary }),
    ...(goal.terminalEvidence === undefined ? {} : { terminalEvidence: goal.terminalEvidence }),
    ...(goal.terminalAt === undefined ? {} : { terminalAt: goal.terminalAt }),
  };
}

function normalizePlan(input: GoalPlanInput): GoalPlan {
  if (!Array.isArray(input.steps) || input.steps.length > MAX_STEPS) throw new Error('plan steps are invalid');
  const ids = new Set<string>();
  const steps = input.steps.map((step): GoalPlanStep => {
    const id = requiredBounded(step.id, 'step id', MAX_STEP_ID);
    if (ids.has(id)) throw new Error('plan step ids must be unique');
    ids.add(id);
    return { id, title: safeText(step.title, MAX_STEP_TITLE, 'step title'), status: 'pending' };
  });
  return { steps };
}

function normalizeStepUpdates(updates: readonly GoalStepUpdate[], plan: GoalPlan): readonly GoalStepUpdate[] {
  if (!Array.isArray(updates) || updates.length > MAX_STEPS) throw new Error('stepUpdates are invalid');
  const known = new Set(plan.steps.map((step) => step.id));
  const seen = new Set<string>();
  return updates.map((update) => {
    const stepId = requiredBounded(update.stepId, 'stepId', MAX_STEP_ID);
    if (!known.has(stepId)) throw new Error(`Unknown goal step: ${stepId}`);
    if (seen.has(stepId)) throw new Error(`Duplicate goal step update: ${stepId}`);
    seen.add(stepId);
    if (!isStepStatus(update.status)) throw new Error('Goal step status is invalid');
    return {
      stepId,
      status: update.status,
      ...(update.summary === undefined ? {} : { summary: safeText(update.summary, MAX_STEP_SUMMARY, 'step summary', true) }),
    };
  });
}

function applyStepUpdates(plan: GoalPlan, updates: readonly GoalStepUpdate[]): GoalPlan {
  const byId = new Map(updates.map((update) => [update.stepId, update]));
  return {
    steps: plan.steps.map((step) => {
      const update = byId.get(step.id);
      if (update === undefined) return step;
      return { ...step, status: update.status, ...(update.summary === undefined ? {} : { summary: update.summary }) };
    }),
  };
}

function normalizeEvidence(evidence: readonly GoalEvidence[]): readonly GoalEvidence[] {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) throw new Error('evidence is invalid');
  return evidence.map((entry) => {
    if (entry.kind !== 'path' && entry.kind !== 'hash' && entry.kind !== 'task' && entry.kind !== 'note') throw new Error('evidence kind is invalid');
    return { kind: entry.kind, value: safeText(entry.value, MAX_EVIDENCE_VALUE, 'evidence value') };
  });
}

function normalizeTaskIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_ACTIVE_TASKS) throw new Error('activeTaskIds are invalid');
  return [...new Set(values.map((value) => requiredBounded(value, 'task id', MAX_TASK_ID)))];
}

function normalizeStrings(values: readonly string[], maxItems: number, maxLength: number, label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} are invalid`);
  return values.map((value) => safeText(value, maxLength, label));
}

function normalizeGoalKey(value: string): string {
  const key = requiredBounded(value, 'goalKey', MAX_GOAL_KEY);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw new Error('goalKey must be a stable ASCII key');
  return key;
}

function normalizeLeaseSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GOAL_LEASE_SECONDS;
  if (!Number.isInteger(value) || value < MIN_GOAL_LEASE_SECONDS || value > MAX_GOAL_LEASE_SECONDS) throw new Error('leaseSeconds is out of range');
  return value;
}

function nextActionFromPlan(plan: GoalPlan): string {
  const next = plan.steps.find((step) => step.status !== 'completed');
  return next === undefined ? '' : `Continue step ${next.id}: ${next.title}`;
}

function safeText(value: string, maxLength: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new Error(`${label} is required`);
  if (trimmed.length > maxLength) throw new Error(`${label} exceeds the allowed length`);
  return redactSensitiveText(trimmed);
}

function requiredBounded(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw new Error(`${label} is invalid`);
  return trimmed;
}

function stableOwnerClientId(actor: FileActor): string {
  return requiredBounded(actor.clientId, 'client identity', MAX_OWNER_CLIENT_ID);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key|credential)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

function createLeaseToken(): string { return randomBytes(32).toString('base64url'); }
function hashLeaseToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function isStepStatus(value: unknown): value is GoalStepStatus { return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked'; }
