import { appError, err, ok, type GoalRepository, type ResourceSnapshot, type ResourceSnapshotRequest, type Result } from '@lnwjud/domain';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';

export interface ResourceMetricsSource {
  getContextStats?(workspaceId: string): Promise<Partial<ResourceSnapshot['context']>>;
  getOwnedTask?(workspaceId: string, goalId: string, taskId: string, provider: string, ownerClientId?: string | null): Promise<{
    readonly ownerVerified: boolean; readonly workingSetBytes?: number; readonly cpuPercent?: number;
    readonly observedAt: string;
  } | null>;
}
const MAX_AGE_MS = 120_000;

export class ResourceSnapshotService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly goals: Pick<GoalContinuationService, 'getGoal'>,
    private readonly source?: ResourceMetricsSource,
    private readonly now: () => Date = () => new Date(),
    /** Trusted Desktop-only read permission; MCP calls use strict actor-owned Goal service. */
    private readonly hostGoalReader?: Pick<GoalRepository,'getById'>,
  ) {}
  public async get(actor: FileActor, request: ResourceSnapshotRequest): Promise<Result<ResourceSnapshot>> {
    if (!request.workspaceId || !await this.workspaces.get(request.workspaceId)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace not registered'));
    }
    const now = this.now();
    let stale = false;
    const resources: ResourceSnapshot['resources'][number][] = [];
    if (request.goalId) {
      let goal;
      if (this.hostGoalReader) goal = await this.hostGoalReader.getById(request.goalId);
      else {
        const goalResult = await this.goals.getGoal(actor, { goalId: request.goalId });
        if (!goalResult.ok) return goalResult;
        goal = goalResult.value;
      }
      if (!goal) return err(appError('WORKSPACE_NOT_FOUND','Goal is unavailable'));
      if (goal.workspaceId !== request.workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Goal belongs to another workspace'));
      }
      const scopedGoalId = 'goalId' in goal ? goal.goalId : goal.id;
      for (const task of goal.trackedTasks ?? []) {
        const observed = this.source?.getOwnedTask
          ? await this.source.getOwnedTask(request.workspaceId, scopedGoalId, task.taskId, task.provider)
          : null;
        const fresh = observed && Number.isFinite(Date.parse(observed.observedAt))
          && now.getTime() - Date.parse(observed.observedAt) >= 0
          && now.getTime() - Date.parse(observed.observedAt) <= MAX_AGE_MS;
        if (observed && !fresh) stale = true;
        const owned = fresh && observed.ownerVerified;
        // A Goal listing alone does NOT prove the OS process or task provider's current ownership.
        resources.push({
          taskId: task.taskId, provider: task.provider, goalId: scopedGoalId, role: task.role,
          ownership: task.role === 'supporting_service' ? 'shared' : owned ? 'owned' : 'unknown',
          canCancel: Boolean(owned && task.role === 'blocking_job' && task.cancelWithGoal),
          ...(fresh && observed?.workingSetBytes !== undefined && Number.isFinite(observed.workingSetBytes) && observed.workingSetBytes >= 0
            ? { workingSetBytes: observed.workingSetBytes } : {}),
          ...(fresh && observed?.cpuPercent !== undefined && Number.isFinite(observed.cpuPercent) && observed.cpuPercent >= 0
            ? { cpuPercent: observed.cpuPercent } : {}),
        });
      }
    }
    const context = this.source?.getContextStats ? await this.source.getContextStats(request.workspaceId) : {};
    const valid = (value: number | null | undefined): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return ok({
      workspaceId: request.workspaceId, sampledAt: now.toISOString(), stale,
      coverage: this.source === undefined ? 'unknown' : 'partial',
      resources,
      context: {
        rawContextBytes: valid(context.rawContextBytes), contextSentBytes: valid(context.contextSentBytes),
        previouslySeenBytesAvoided: valid(context.previouslySeenBytesAvoided), ledgerHits: valid(context.ledgerHits),
      },
    });
  }
}
