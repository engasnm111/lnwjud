import { appError, err, ok, type GoalRepository, type ResourceSnapshot, type ResourceSnapshotRequest, type Result } from '@lnwjud/domain';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';

export interface ResourceMetricsSource {
  readonly contextScope?: 'workspace' | 'transport';
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
    private readonly hostGoalReader?: Pick<GoalRepository, 'getById'> & {
      listWorkspaceGoalFilters?: (workspaceId: string) => Promise<readonly { readonly id: string }[]>;
    },
  ) {}
  public async get(actor: FileActor, request: ResourceSnapshotRequest): Promise<Result<ResourceSnapshot>> {
    if (!request.workspaceId || !await this.workspaces.get(request.workspaceId)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace not registered'));
    }
    const now = this.now();
    let stale = false;
    const resources: ResourceSnapshot['resources'][number][] = [];
    const goalIds = request.goalId
      ? [request.goalId]
      : this.hostGoalReader?.listWorkspaceGoalFilters === undefined
        ? []
        : (await this.hostGoalReader.listWorkspaceGoalFilters(request.workspaceId)).map((goal) => goal.id);
    const tracked: Array<{ goalId: string; taskId: string; provider: string; role: string; cancelWithGoal: boolean }> = [];
    for (const goalId of goalIds) {
      let goal;
      if (this.hostGoalReader) goal = await this.hostGoalReader.getById(goalId);
      else {
        const goalResult = await this.goals.getGoal(actor, { goalId });
        if (!goalResult.ok) return goalResult;
        goal = goalResult.value;
      }
      if (!goal) {
        if (request.goalId) return err(appError('WORKSPACE_NOT_FOUND', 'Goal is unavailable'));
        continue;
      }
      if (goal.workspaceId !== request.workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Goal belongs to another workspace'));
      }
      const scopedGoalId = 'goalId' in goal ? goal.goalId : goal.id;
      for (const task of goal.trackedTasks ?? []) {
        tracked.push({ goalId: scopedGoalId, taskId: task.taskId,
          provider: task.provider, role: task.role, cancelWithGoal: task.cancelWithGoal });
      }
    }
    // Keep workspace-wide sampling bounded; a large archive cannot starve the
    // Diagnostics renderer or spawn unbounded native provider probes.
    const MAX_TASK_SAMPLES = 200;
    if (tracked.length > MAX_TASK_SAMPLES) stale = true;
    const batchSize = 6;
    const selected = tracked.slice(0, MAX_TASK_SAMPLES);
    for (let index = 0; index < selected.length; index += batchSize) {
      const rows = await Promise.all(selected.slice(index, index + batchSize).map(async (task) => {
        let observed: Awaited<ReturnType<NonNullable<ResourceMetricsSource['getOwnedTask']>>> = null;
        try {
          observed = this.source?.getOwnedTask
            ? await this.source.getOwnedTask(request.workspaceId, task.goalId, task.taskId, task.provider)
            : null;
        } catch {
          // A transient process-provider failure must not hide other measurable tasks.
          stale = true;
        }
        const observedAgeMs = observed ? this.now().getTime() - Date.parse(observed.observedAt) : NaN;
        const fresh = observed !== null && Number.isFinite(observedAgeMs)
          && observedAgeMs >= 0 && observedAgeMs <= MAX_AGE_MS;
        if (observed && !fresh) stale = true;
        const owned = fresh && observed !== null && observed.ownerVerified;
        return {
          taskId: task.taskId, provider: task.provider, goalId: task.goalId, role: task.role,
          ownership: task.role === 'supporting_service' ? 'shared' as const : owned ? 'owned' as const : 'unknown' as const,
          canCancel: Boolean(owned && task.role === 'blocking_job' && task.cancelWithGoal),
          ...(owned && observed?.workingSetBytes !== undefined && Number.isFinite(observed.workingSetBytes) && observed.workingSetBytes >= 0
            ? { workingSetBytes: observed.workingSetBytes } : {}),
          ...(owned && observed?.cpuPercent !== undefined && Number.isFinite(observed.cpuPercent) && observed.cpuPercent >= 0
            ? { cpuPercent: observed.cpuPercent } : {}),
        };
      }));
      resources.push(...rows);
    }
    const context = this.source?.getContextStats ? await this.source.getContextStats(request.workspaceId) : {};
    const valid = (value: number | null | undefined): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return ok({
      workspaceId: request.workspaceId, sampledAt: now.toISOString(), stale,
      coverage: this.source === undefined ? 'unknown' : 'partial',
      contextScope: this.source?.contextScope ?? 'unavailable',
      resources,
      context: {
        rawContextBytes: valid(context.rawContextBytes), contextSentBytes: valid(context.contextSentBytes),
        previouslySeenBytesAvoided: valid(context.previouslySeenBytesAvoided), ledgerHits: valid(context.ledgerHits),
      },
    });
  }
}
