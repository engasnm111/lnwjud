import { randomUUID } from 'node:crypto';
import {
  AutomationStateError,
  type AutomationDispatchReceiptRecord,
  type AutomationRepository,
  type AutomationRunSnapshot,
  type GoalLeaseProof,
  type GoalStatus,
} from '@lnwjud/domain';
import type { FileActor } from './file-service.js';
import {
  AutomationGoalIntegrationService,
} from './automation-goal-integration-service.js';
import {
  AutomationOrchestratorService,
  type AutomationAuthorityCursor,
} from './automation-orchestrator-service.js';
import { AutomationTaskSupervisorService } from './automation-task-supervisor-service.js';

export type AutomationScheduledClaimOutcome =
  | 'recurring_acquired'
  | 'worker_busy_noop'
  | 'orphan_probe_noop'
  | 'terminal_cleanup_required'
  | 'already_claimed'
  | 'terminal_noop'
  | 'receipt_required'
  | 'successor_required'
  | 'reschedule_required'
  | 'not_due'
  | 'acquired';

export type AutomationScheduledResumeAction =
  | 'no_automation_run'
  | 'scheduled_noop'
  | 'scheduler_cleanup_required'
  | 'execution_required'
  | 'observe_task'
  | 'verify_current_milestone'
  | 'finalize'
  | 'reconciliation_required'
  | 'paused'
  | 'terminal';

export interface AutomationScheduledResumeRequest {
  readonly claimOutcome: AutomationScheduledClaimOutcome;
  readonly goalId: string;
  readonly goalStatus: GoalStatus;
  readonly goalRevision: number;
  readonly userIntentRevision: number;
  readonly lease?: GoalLeaseProof;
  readonly acquisition?: 'normal' | 'expired_lease' | 'orphan_recovered';
  readonly runKey?: string;
}

export interface AutomationScheduledResumeResult {
  readonly outcome: 'no_automation_run' | 'scheduled_noop' | 'resumed' | 'terminal_reconciled';
  readonly action: AutomationScheduledResumeAction;
  readonly reason: string;
  readonly run?: AutomationRunSnapshot;
  readonly task?: {
    readonly provider: 'process' | 'codex' | 'shell';
    readonly taskId: string;
  };
  readonly operationKey?: string;
  readonly recoveryAttempted?: 'task_observation' | 'dispatch_reconciliation' | 'verification_checkpoint_recovery';
  readonly acquisition?: 'normal' | 'expired_lease' | 'orphan_recovered';
  readonly runKey?: string;
}

export interface AutomationScheduledResumeServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Resumes an existing AutomationRun only after the existing scheduled-continuation
 * subsystem has acquired the durable goal lease. It does not create, retime, or
 * replace scheduler tasks and never treats scheduler transport degradation as a
 * work failure.
 */
export class AutomationScheduledResumeService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AutomationRepository,
    private readonly orchestrator: AutomationOrchestratorService,
    private readonly supervisor: AutomationTaskSupervisorService,
    private readonly goalIntegration: Pick<
      AutomationGoalIntegrationService,
      'recoverCheckpointedVerification' | 'reconcileTerminalReadback'
    >,
    options: AutomationScheduledResumeServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async resumeAfterClaim(
    actor: FileActor,
    request: AutomationScheduledResumeRequest,
  ): Promise<AutomationScheduledResumeResult> {
    validateRequest(request);
    let run = await this.repository.getRunByGoalId(request.goalId);
    if (run === null) {
      return {
        outcome: 'no_automation_run',
        action: 'no_automation_run',
        reason: 'Durable goal has no native automation run; preserve the existing scheduled-goal workflow',
        ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
      };
    }

    if (run.goalId !== request.goalId) {
      throw new AutomationStateError('corrupt', 'Scheduled resume loaded an automation run for another durable goal');
    }

    if (request.claimOutcome === 'terminal_noop') {
      if (request.goalStatus !== 'completed') {
        return {
          outcome: 'scheduled_noop',
          action: 'reconciliation_required',
          reason: `Durable goal is terminal as ${request.goalStatus} while the automation run is not confirmed in the same terminal state; fail closed without automation mutation`,
          run,
          ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
        };
      }
      const reconciled = await this.goalIntegration.reconcileTerminalReadback(actor, {
        runId: run.id,
        expectedRevision: run.revision,
      });
      return {
        outcome: 'terminal_reconciled',
        action: 'terminal',
        reason: 'Recovered automation completion from authoritative durable-goal terminal readback',
        run: reconciled.run,
        ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
      };
    }

    if (request.claimOutcome === 'terminal_cleanup_required') {
      return {
        outcome: 'scheduled_noop',
        action: 'scheduler_cleanup_required',
        reason: 'Recurring watchdog cleanup must finish before durable goal finalization can continue',
        run,
        ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
      };
    }

    if (request.claimOutcome !== 'recurring_acquired') {
      return {
        outcome: 'scheduled_noop',
        action: 'scheduled_noop',
        reason: scheduledNoopReason(request.claimOutcome),
        run,
        ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
      };
    }

    if (request.goalStatus !== 'active') {
      throw new AutomationStateError(
        'conflict',
        `Recurring scheduled resume cannot mutate automation for a ${request.goalStatus} durable goal`,
      );
    }
    const lease = requireLease(request.lease, request.goalId);
    if (lease.leaseGeneration < 1) {
      throw new AutomationStateError('conflict', 'Scheduled resume received an invalid durable goal lease generation');
    }
    if (run.basedOnUserIntentRevision !== request.userIntentRevision) {
      throw new AutomationStateError(
        'conflict',
        'Durable goal user intent changed while the automation worker was away; reconcile or replan before resuming',
      );
    }

    const authority: AutomationAuthorityCursor = {
      goalRevision: request.goalRevision,
      userIntentRevision: request.userIntentRevision,
    };
    if (run.basedOnGoalRevision !== request.goalRevision) {
      run = await this.syncGoalAuthority(run, request);
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new AutomationStateError(
        'conflict',
        `Active durable goal cannot resume automation run already terminal as ${run.status}`,
      );
    }
    if (run.status === 'paused') {
      return this.result(run, 'paused', 'Automation is explicitly paused; scheduled wake acquired the goal but did not resume orchestration', request);
    }
    if (run.status === 'completing') {
      return this.result(run, 'finalize', 'All automation milestones are complete; resume final durable-goal acceptance', request);
    }

    const recoverableReceipt = currentRecoverableReceipt(run);
    if (recoverableReceipt !== undefined) {
      const recovered = await this.supervisor.recoverUnresolvedDispatch({
        runId: run.id,
        expectedRevision: run.revision,
        authority,
        operationKey: recoverableReceipt.operationKey,
      });
      return {
        ...this.classify(recovered, request),
        recoveryAttempted: 'dispatch_reconciliation',
        operationKey: recoverableReceipt.operationKey,
      };
    }

    if (run.status === 'waiting_task') {
      const observed = await this.supervisor.observeCurrentTask({
        runId: run.id,
        expectedRevision: run.revision,
        authority,
      });
      return {
        ...this.classify(observed, request),
        recoveryAttempted: 'task_observation',
      };
    }

    if (run.status === 'verifying') {
      const recovered = await this.goalIntegration.recoverCheckpointedVerification(actor, {
        runId: run.id,
        expectedRevision: run.revision,
        authority,
        lease,
      });
      if (recovered !== null) {
        return {
          ...this.classify(recovered.run, request),
          recoveryAttempted: 'verification_checkpoint_recovery',
        };
      }
      return this.result(
        run,
        'verify_current_milestone',
        'Task state is already reconciled; current milestone still requires deterministic verification evidence',
        request,
      );
    }

    if (run.status === 'planned' || run.status === 'running') {
      run = await this.advanceToDispatchBoundary(run, authority);
      return this.classify(run, request);
    }

    return this.result(
      run,
      'reconciliation_required',
      'Automation is blocked without a safely replayable scheduled-resume transition',
      request,
    );
  }

  private async syncGoalAuthority(
    run: AutomationRunSnapshot,
    request: AutomationScheduledResumeRequest,
  ): Promise<AutomationRunSnapshot> {
    return this.repository.commitTransition({
      runId: run.id,
      expectedRevision: run.revision,
      runPatch: {
        basedOnGoalRevision: request.goalRevision,
        basedOnUserIntentRevision: request.userIntentRevision,
      },
      event: {
        id: this.idFactory(),
        ...(run.currentMilestoneId === undefined ? {} : { milestoneId: run.currentMilestoneId }),
        ...(run.currentAttemptId === undefined ? {} : { attemptId: run.currentAttemptId }),
        type: 'recovery_reconciled',
        reason: 'scheduled_goal_authority_resynced',
        metadata: {
          priorGoalRevision: run.basedOnGoalRevision,
          goalRevision: request.goalRevision,
          leaseGeneration: request.lease?.leaseGeneration ?? null,
          acquisition: request.acquisition ?? null,
          runKey: request.runKey ?? null,
        },
      },
      now: this.now().toISOString(),
    });
  }

  private async advanceToDispatchBoundary(
    initial: AutomationRunSnapshot,
    authority: AutomationAuthorityCursor,
  ): Promise<AutomationRunSnapshot> {
    let run = initial;

    if (run.status === 'planned' || run.currentMilestoneId === undefined) {
      run = await this.orchestrator.advance({
        runId: run.id,
        expectedRevision: run.revision,
        authority,
      });
    }
    if (run.status !== 'running' || run.currentAttemptId !== undefined) return run;

    const milestone = run.currentMilestoneId === undefined
      ? undefined
      : run.milestones.find((candidate) => candidate.id === run.currentMilestoneId);
    if (milestone?.status === 'ready' || milestone?.status === 'retry_ready') {
      run = await this.orchestrator.startCurrentAttempt({
        runId: run.id,
        expectedRevision: run.revision,
        authority,
      });
    }
    return run;
  }

  private classify(
    run: AutomationRunSnapshot,
    request: AutomationScheduledResumeRequest,
  ): AutomationScheduledResumeResult {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return this.result(run, 'terminal', `Automation run is terminal as ${run.status}`, request);
    }
    if (run.status === 'paused') {
      return this.result(run, 'paused', 'Automation remains paused', request);
    }
    if (run.status === 'completing') {
      return this.result(run, 'finalize', 'Automation milestones are complete; final durable-goal acceptance is next', request);
    }
    if (run.status === 'verifying') {
      return this.result(run, 'verify_current_milestone', 'Current milestone is ready for deterministic verification', request);
    }
    if (run.status === 'waiting_task') {
      const binding = currentBlockingBinding(run);
      return {
        ...this.result(run, 'observe_task', 'Durable blocking task is still nonterminal; preserve its exact identity and observe later', request),
        task: { provider: binding.provider, taskId: binding.taskId },
      };
    }
    if (run.status === 'blocked') {
      return this.result(run, 'reconciliation_required', 'Automation recovery remains blocked; do not replay an ambiguous or unsafe side effect', request);
    }

    const attempt = currentAttempt(run);
    if (attempt?.status === 'dispatching') {
      return this.result(
        run,
        'execution_required',
        'Attempt is durably reserved but no external execution may be inferred; provide an explicit execution descriptor through automation_run',
        request,
      );
    }
    return this.result(run, 'execution_required', 'Automation is ready to continue useful deterministic work', request);
  }

  private result(
    run: AutomationRunSnapshot,
    action: AutomationScheduledResumeAction,
    reason: string,
    request: AutomationScheduledResumeRequest,
  ): AutomationScheduledResumeResult {
    return {
      outcome: 'resumed',
      action,
      reason,
      run,
      ...(request.acquisition === undefined ? {} : { acquisition: request.acquisition }),
      ...(request.runKey === undefined ? {} : { runKey: request.runKey }),
    };
  }
}

function currentRecoverableReceipt(
  run: AutomationRunSnapshot,
): AutomationDispatchReceiptRecord | undefined {
  if (run.currentAttemptId === undefined) return undefined;
  const recoverable = run.dispatchReceipts.filter((receipt) => (
    receipt.attemptId === run.currentAttemptId
    && (receipt.state === 'reserved' || receipt.state === 'dispatched_unresolved')
  ));
  if (recoverable.length > 1) {
    throw new AutomationStateError(
      'corrupt',
      'Automation current attempt has multiple unresolved dispatch receipts',
    );
  }
  return recoverable[0];
}

function currentAttempt(run: AutomationRunSnapshot): AutomationRunSnapshot['attempts'][number] | undefined {
  if (run.currentAttemptId === undefined) return undefined;
  const attempt = run.attempts.find((candidate) => candidate.id === run.currentAttemptId);
  if (attempt === undefined) {
    throw new AutomationStateError('corrupt', 'Automation current attempt is missing during scheduled recovery');
  }
  return attempt;
}

function currentBlockingBinding(run: AutomationRunSnapshot): AutomationRunSnapshot['taskBindings'][number] {
  const attempt = currentAttempt(run);
  if (attempt === undefined) {
    throw new AutomationStateError('corrupt', 'Waiting automation run has no current attempt');
  }
  const bindings = run.taskBindings.filter((binding) => (
    binding.attemptId === attempt.id && binding.role === 'blocking_job'
  ));
  if (bindings.length !== 1) {
    throw new AutomationStateError(
      'corrupt',
      'Waiting automation run must have exactly one blocking task binding',
    );
  }
  return bindings[0]!;
}

function requireLease(lease: GoalLeaseProof | undefined, goalId: string): GoalLeaseProof {
  if (lease === undefined) {
    throw new AutomationStateError(
      'conflict',
      'Scheduled automation resume requires the lease returned by claim_scheduled_continuation',
    );
  }
  if (lease.goalId !== goalId) {
    throw new AutomationStateError('conflict', 'Scheduled resume lease belongs to another durable goal');
  }
  return lease;
}

function scheduledNoopReason(outcome: AutomationScheduledClaimOutcome): string {
  switch (outcome) {
    case 'worker_busy_noop':
      return 'Existing worker or task ownership is still live or uncertain; duplicate scheduled wake performs no automation mutation';
    case 'orphan_probe_noop':
      return 'Legacy orphan probe did not acquire mutation authority';
    case 'already_claimed':
      return 'This scheduled occurrence was already claimed; duplicate delivery performs no automation mutation';
    case 'receipt_required':
      return 'Native scheduler receipt must be reconciled before automation mutation';
    case 'successor_required':
    case 'reschedule_required':
    case 'not_due':
    case 'acquired':
      return 'Legacy one-time continuation compatibility path must complete scheduler handoff before automation resumes';
    case 'terminal_cleanup_required':
      return 'Recurring scheduler cleanup is required';
    case 'terminal_noop':
      return 'Durable goal is terminal; no automation work may resume';
    case 'recurring_acquired':
      return 'Recurring lease acquired';
  }
}

function validateRequest(request: AutomationScheduledResumeRequest): void {
  if (request.goalId.trim().length === 0 || request.goalId.length > 128) {
    throw new AutomationStateError('conflict', 'Scheduled resume goalId is invalid');
  }
  if (!Number.isInteger(request.goalRevision) || request.goalRevision < 0) {
    throw new AutomationStateError('conflict', 'Scheduled resume goal revision is invalid');
  }
  if (!Number.isInteger(request.userIntentRevision) || request.userIntentRevision < 0) {
    throw new AutomationStateError('conflict', 'Scheduled resume user intent revision is invalid');
  }
}
