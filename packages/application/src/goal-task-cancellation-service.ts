import {
  type GoalTaskCancellationObservation,
  type GoalTaskProvider,
  type GoalTrackedTask,
  type Result,
} from '@lnwjud/domain';

export type GoalTaskCancellationProviderName = 'process' | 'codex' | 'shell';

export interface GoalTaskCancellationProvider {
  readonly provider: GoalTaskCancellationProviderName;
  cancelForGoal(ownerClientId: string, workspaceId: string, taskId: string): Promise<Result<GoalTaskCancellationObservation>>;
}
export interface GoalTaskCancellationProviderResult extends GoalTaskCancellationObservation {
  readonly provider: GoalTaskCancellationProviderName;
  readonly error?: string;
}

export type GoalTaskCancellationResultStatus = 'cancelled' | 'already_terminal' | 'not_found' | 'skipped' | 'failed';

export interface GoalTaskCancellationResult {
  readonly taskId: string;
  readonly provider?: GoalTaskProvider;
  readonly status: GoalTaskCancellationResultStatus;
  readonly providers: readonly GoalTaskCancellationProviderResult[];
  readonly error?: string;
}

export interface GoalTaskCancellationPort {
  cancelForGoal(ownerClientId: string, workspaceId: string, tasks: readonly (GoalTrackedTask | string)[]): Promise<readonly GoalTaskCancellationResult[]>;
}

export class GoalTaskCancellationService implements GoalTaskCancellationPort {
  public constructor(private readonly providers: readonly GoalTaskCancellationProvider[]) {}

  public async cancelForGoal(
    ownerClientId: string,
    workspaceId: string,
    tasks: readonly (GoalTrackedTask | string)[],
  ): Promise<readonly GoalTaskCancellationResult[]> {
    return Promise.all(tasks.map((task) => typeof task === 'string'
      ? this.cancelTask(ownerClientId, workspaceId, task, 'legacy_auto')
      : task.cancelWithGoal
        ? this.cancelTask(ownerClientId, workspaceId, task.taskId, task.provider)
        : skippedGoalTaskCancellation(task)));
  }

  private async cancelTask(ownerClientId: string, workspaceId: string, taskId: string, bindingProvider: GoalTaskProvider): Promise<GoalTaskCancellationResult> {
    const selectedProviders = bindingProvider === 'legacy_auto'
      ? this.providers
      : this.providers.filter((provider) => provider.provider === bindingProvider);
    if (selectedProviders.length === 0) {
      return failedGoalTaskCancellation(taskId, `Task cancellation provider is unavailable: ${bindingProvider}`, bindingProvider);
    }
    const providers = await Promise.all(selectedProviders.map(async (provider): Promise<GoalTaskCancellationProviderResult> => {
      try {
        const result = await provider.cancelForGoal(ownerClientId, workspaceId, taskId);
        if (result.ok) return { provider: provider.provider, ...result.value };
        if (result.error.code === 'PROCESS_NOT_FOUND') {
          return { provider: provider.provider, matched: false, state: 'not_found' };
        }
        return {
          provider: provider.provider,
          matched: false,
          state: 'termination_unverified',
          error: `${result.error.code}: ${result.error.message}`,
        };
      } catch (error: unknown) {
        return {
          provider: provider.provider,
          matched: false,
          state: 'termination_unverified',
          error: error instanceof Error ? error.message : 'Task cancellation provider failed',
        };
      }
    }));

    const failed = providers.some((provider) => provider.error !== undefined || provider.state === 'termination_unverified');
    const matched = providers.filter((provider) => provider.matched);
    let status: GoalTaskCancellationResultStatus;
    if (failed) status = 'failed';
    else if (matched.some((provider) => provider.state === 'cancelled')) status = 'cancelled';
    else if (matched.some((provider) => provider.state === 'already_terminal')) status = 'already_terminal';
    else status = 'not_found';
    return { taskId, provider: bindingProvider, status, providers };
  }
}

export function failedGoalTaskCancellation(taskId: string, message: string, provider?: GoalTaskProvider): GoalTaskCancellationResult {
  return { taskId, ...(provider === undefined ? {} : { provider }), status: 'failed', providers: [], error: message };
}

export function skippedGoalTaskCancellation(task: GoalTrackedTask): GoalTaskCancellationResult {
  return {
    taskId: task.taskId,
    provider: task.provider,
    status: 'skipped',
    providers: [],
    error: 'Task remains running because cancelWithGoal=false',
  };
}

export function isGoalTaskStopped(status: GoalTaskCancellationResultStatus): boolean {
  return status === 'cancelled' || status === 'already_terminal' || status === 'not_found';
}
