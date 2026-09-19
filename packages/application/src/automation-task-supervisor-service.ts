import { randomUUID } from 'node:crypto';
import {
  AutomationStateError,
  type AutomationDispatchReceiptRecord,
  type AutomationMilestoneRecord,
  type AutomationRecoveryClass,
  type AutomationRecoveryDecision,
  type AutomationRepository,
  type AutomationRetryClass,
  type AutomationRunSnapshot,
  type AutomationTaskBindingRecord,
  type AutomationTaskObservedState,
  type AutomationTaskProvider,
} from '@lnwjud/domain';
import type { AutomationTaskExecution } from './automation-execution-policy.js';
import {
  AutomationOrchestratorService,
  type AutomationAuthorityCursor,
  type AutomationMutationRequest,
} from './automation-orchestrator-service.js';

export type AutomationRuntimeTaskState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'termination_unverified';

export interface AutomationTaskLaunchPortRequest {
  readonly workspaceId: string;
  readonly runId: string;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly provider: AutomationTaskProvider;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly executionIntent: string;
  readonly execution?: AutomationTaskExecution;
  readonly deadlineAt?: string;
}

export type AutomationTaskLaunchOutcome =
  | { readonly kind: 'started'; readonly taskId: string; readonly detail?: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly detail?: string; readonly retryable: boolean }
  | { readonly kind: 'uncertain'; readonly detail?: string };

export interface AutomationTaskObservePortRequest {
  readonly workspaceId: string;
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
}

export type AutomationTaskObservationOutcome =
  | { readonly kind: 'observed'; readonly state: AutomationRuntimeTaskState; readonly detail?: string; readonly terminalAt?: string }
  | { readonly kind: 'not_found'; readonly detail?: string }
  | { readonly kind: 'timeout'; readonly detail?: string }
  | { readonly kind: 'unreachable'; readonly detail?: string };

export interface AutomationResolveDispatchPortRequest {
  readonly workspaceId: string;
  readonly provider: AutomationTaskProvider;
  readonly operationKey: string;
  readonly idempotencyKey: string;
}

export type AutomationResolveDispatchOutcome =
  | { readonly kind: 'found'; readonly taskId: string; readonly detail?: string }
  | { readonly kind: 'absent'; readonly detail?: string }
  | { readonly kind: 'unknown'; readonly detail?: string };

export interface AutomationCancelTaskPortRequest {
  readonly workspaceId: string;
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
}
export type AutomationCancelTaskOutcome =
  | { readonly kind: 'requested'; readonly detail?: string }
  | {
      readonly kind: 'already_terminal';
      readonly state: Exclude<AutomationRuntimeTaskState, 'starting' | 'running' | 'termination_unverified'>;
      readonly detail?: string;
      readonly terminalAt?: string;
    }
  | { readonly kind: 'unknown'; readonly detail?: string };

export interface AutomationTaskRuntimePort {
  launch(request: AutomationTaskLaunchPortRequest): Promise<AutomationTaskLaunchOutcome>;
  observe(request: AutomationTaskObservePortRequest): Promise<AutomationTaskObservationOutcome>;
  resolveDispatch(request: AutomationResolveDispatchPortRequest): Promise<AutomationResolveDispatchOutcome>;
  cancel(request: AutomationCancelTaskPortRequest): Promise<AutomationCancelTaskOutcome>;
}

export interface AutomationDispatchTaskRequest extends AutomationMutationRequest {
  readonly provider: AutomationTaskProvider;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly execution?: AutomationTaskExecution;
  readonly deadlineMs?: number;
}

export type AutomationObserveTaskRequest = AutomationMutationRequest;

export interface AutomationRecoverDispatchRequest extends AutomationMutationRequest {
  readonly operationKey: string;
}

export interface AutomationTaskSupervisorServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

const MAX_OPERATION_KEY = 256;
const MAX_IDEMPOTENCY_KEY = 2_048;
const MAX_DETAIL = 2_048;
const MAX_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;

export class AutomationTaskSupervisorService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AutomationRepository,
    private readonly orchestrator: AutomationOrchestratorService,
    private readonly runtime: AutomationTaskRuntimePort,
    options: AutomationTaskSupervisorServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async dispatchCurrentAttempt(
    request: AutomationDispatchTaskRequest,
  ): Promise<AutomationRunSnapshot> {
    validateDispatchRequest(request);
    const initial = await this.loadExpected(request);
    const attemptId = requireCurrentAttemptId(initial);
    const milestone = requireCurrentMilestone(initial);
    const existing = receiptFor(initial, attemptId, request.operationKey);
    if (existing !== undefined) {
      assertReceiptIdentity(existing, request);
      if (existing.state === 'confirmed') return assertConfirmedBinding(initial, existing);
      if (existing.state === 'reserved' || existing.state === 'dispatched_unresolved') {
        return this.recoverExistingDispatch(initial, milestone, existing, request);
      }
      throw new AutomationStateError(
        'conflict',
        'Automation dispatch receipt is terminal and cannot be dispatched again',
      );
    }
    const dispatch = currentDispatchAttempt(initial);
    if (dispatch.attemptId !== attemptId || dispatch.milestone.id !== milestone.id) {
      throw new AutomationStateError('corrupt', 'Automation dispatch selection changed unexpectedly');
    }

    const reservedAt = this.now().toISOString();
    const deadlineAt = deadlineFrom(reservedAt, request.deadlineMs);
    const reserved = await this.repository.commitTransition({
      runId: initial.id,
      expectedRevision: initial.revision,
      runPatch: authorityPatch(request.authority),
      dispatchReceipts: [{
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId,
        operationKey: request.operationKey,
        state: 'reserved',
        provider: request.provider,
        idempotencyKey: request.idempotencyKey,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId,
        type: 'dispatch_recorded',
        reason: 'dispatch_reserved_before_external_launch',
        metadata: {
          provider: request.provider,
          operationKey: request.operationKey,
        },
      },
      now: reservedAt,
    });
    const receipt = requireReceipt(reserved, attemptId, request.operationKey);
    let outcome: AutomationTaskLaunchOutcome;
    try {
      outcome = await this.runtime.launch({
        workspaceId: reserved.workspaceId,
        runId: reserved.id,
        milestoneId: milestone.id,
        attemptId,
        provider: request.provider,
        operationKey: request.operationKey,
        idempotencyKey: request.idempotencyKey,
        executionIntent: milestone.executionIntent,
        ...(request.execution === undefined ? {} : { execution: request.execution }),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      });
    } catch (error) {
      outcome = {
        kind: 'uncertain',
        detail: boundedDetail(error instanceof Error ? error.message : 'Task launch transport failed'),
      };
    }

    if (outcome.kind === 'started') {
      return this.confirmLaunch(reserved, milestone, receipt, request, outcome.taskId, deadlineAt, outcome.detail);
    }
    if (outcome.kind === 'rejected') {
      const failedReceipt = await this.markDispatchRejected(
        reserved,
        milestone,
        receipt,
        request,
        outcome,
      );
      return this.orchestrator.failCurrentAttempt({
        runId: failedReceipt.id,
        expectedRevision: failedReceipt.revision,
        authority: request.authority,
        failureCode: boundedCode(outcome.code),
        ...(outcome.detail === undefined ? {} : { failureDetail: boundedDetail(outcome.detail) }),
        retryable: outcome.retryable,
      });
    }
    return this.markDispatchUnresolved(
      reserved,
      milestone,
      receipt,
      request,
      outcome.detail ?? 'Task launch outcome is uncertain',
    );
  }

  public async recoverUnresolvedDispatch(
    request: AutomationRecoverDispatchRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationBase(request);
    assertBoundedText(request.operationKey, 'operationKey', MAX_OPERATION_KEY);
    const snapshot = await this.loadExpected(request);
    assertTaskSupervisionNotPaused(snapshot);
    const attemptId = requireCurrentAttemptId(snapshot);
    const milestone = requireCurrentMilestone(snapshot);
    const receipt = requireReceipt(snapshot, attemptId, request.operationKey);
    if (receipt.state === 'confirmed') return assertConfirmedBinding(snapshot, receipt);
    if (receipt.state !== 'reserved' && receipt.state !== 'dispatched_unresolved') {
      throw new AutomationStateError('conflict', 'Automation dispatch receipt is not recoverable');
    }
    if (receipt.idempotencyKey === undefined) {
      throw new AutomationStateError('corrupt', 'Recoverable dispatch receipt has no idempotency key');
    }
    if (receipt.provider === undefined) {
      throw new AutomationStateError('corrupt', 'Recoverable dispatch receipt has no task provider');
    }
    return this.resolveExistingDispatch(snapshot, milestone, receipt, {
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      authority: request.authority,
      provider: receipt.provider,
      operationKey: receipt.operationKey,
      idempotencyKey: receipt.idempotencyKey,
    });
  }

  public async observeCurrentTask(
    request: AutomationObserveTaskRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationBase(request);
    const snapshot = await this.loadExpected(request);
    assertTaskSupervisionNotPaused(snapshot);
    const milestone = requireCurrentMilestone(snapshot);
    const attemptId = requireCurrentAttemptId(snapshot);
    const binding = currentBlockingBinding(snapshot, attemptId);

    let outcome: AutomationTaskObservationOutcome;
    try {
      outcome = await this.runtime.observe({
        workspaceId: snapshot.workspaceId,
        provider: binding.provider,
        taskId: binding.taskId,
      });
    } catch (error) {
      outcome = {
        kind: 'unreachable',
        detail: boundedDetail(error instanceof Error ? error.message : 'Task observation transport failed'),
      };
    }

    if (outcome.kind === 'timeout') {
      return this.recordObservationRecovery(
        snapshot,
        milestone,
        binding,
        request.authority,
        classifyAutomationRecovery('observation_timeout', milestone.retryPolicy.classification),
        outcome.detail ?? 'Task observation timed out without changing task state',
        false,
      );
    }
    if (outcome.kind === 'unreachable') {
      return this.recordObservedStateRecovery(
        snapshot,
        milestone,
        binding,
        request.authority,
        'unreachable',
        classifyAutomationRecovery('transport_interrupted', milestone.retryPolicy.classification),
        outcome.detail ?? 'Task provider is unreachable',
      );
    }
    if (outcome.kind === 'not_found') {
      return this.recordObservedStateRecovery(
        snapshot,
        milestone,
        binding,
        request.authority,
        'not_found',
        classifyAutomationRecovery('task_missing', milestone.retryPolicy.classification),
        outcome.detail ?? 'Durable task handle is not resolvable',
      );
    }

    const state = outcome.state;
    if ((state === 'starting' || state === 'running') && deadlineExceeded(binding, this.now())) {
      return this.handleDeadlineExceeded(snapshot, milestone, binding, request.authority, outcome);
    }
    if (state === 'starting' || state === 'running') {
      return this.recordHealthyObservation(snapshot, milestone, binding, request.authority, outcome);
    }
    if (state === 'termination_unverified') {
      return this.recordObservedStateRecovery(
        snapshot,
        milestone,
        binding,
        request.authority,
        state,
        classifyAutomationRecovery('termination_unverified', milestone.retryPolicy.classification),
        outcome.detail ?? 'Task termination cannot be verified',
      );
    }
    if (state === 'completed') {
      const observed = await this.recordTerminalObservation(
        snapshot,
        milestone,
        binding,
        request.authority,
        state,
        outcome.detail,
        outcome.terminalAt,
        'task_completed',
      );
      return this.orchestrator.beginVerification({
        runId: observed.id,
        expectedRevision: observed.revision,
        authority: request.authority,
      });
    }

    const recoveryClass = taskFailureRecoveryClass(state);
    const decision = classifyAutomationRecovery(recoveryClass, milestone.retryPolicy.classification);
    const observed = await this.recordTerminalObservation(
      snapshot,
      milestone,
      binding,
      request.authority,
      state,
      outcome.detail,
      outcome.terminalAt,
      decision.reason,
      decision,
    );
    if (decision.action === 'retry_attempt' || decision.action === 'fail_attempt') {
      return this.orchestrator.failCurrentAttempt({
        runId: observed.id,
        expectedRevision: observed.revision,
        authority: request.authority,
        failureCode: recoveryClass,
        ...(outcome.detail === undefined ? {} : { failureDetail: boundedDetail(outcome.detail) }),
        retryable: decision.retryable,
      });
    }
    return observed;
  }
  private async recoverExistingDispatch(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    receipt: AutomationDispatchReceiptRecord,
    request: AutomationDispatchTaskRequest,
  ): Promise<AutomationRunSnapshot> {
    if (receipt.idempotencyKey !== request.idempotencyKey) {
      throw new AutomationStateError('conflict', 'Automation dispatch replay changed idempotency identity');
    }
    return this.resolveExistingDispatch(snapshot, milestone, receipt, request);
  }

  private async resolveExistingDispatch(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    receipt: AutomationDispatchReceiptRecord,
    request: AutomationDispatchTaskRequest,
  ): Promise<AutomationRunSnapshot> {
    let resolution: AutomationResolveDispatchOutcome;
    try {
      resolution = await this.runtime.resolveDispatch({
        workspaceId: snapshot.workspaceId,
        provider: request.provider,
        operationKey: receipt.operationKey,
        idempotencyKey: request.idempotencyKey,
      });
    } catch (error) {
      resolution = {
        kind: 'unknown',
        detail: boundedDetail(error instanceof Error ? error.message : 'Dispatch resolution transport failed'),
      };
    }

    if (resolution.kind === 'found') {
      return this.confirmLaunch(
        snapshot,
        milestone,
        receipt,
        request,
        resolution.taskId,
        receipt.deadlineAt,
        resolution.detail,
      );
    }
    if (resolution.kind === 'absent') {
      const decision = classifyAutomationRecovery('dispatch_absent', milestone.retryPolicy.classification);
      const normalized = await this.repository.commitTransition({
        runId: snapshot.id,
        expectedRevision: snapshot.revision,
        runPatch: {
          status: 'running',
          ...authorityPatch(request.authority),
          currentMilestoneId: milestone.id,
          currentAttemptId: receipt.attemptId,
          lastRecoveryDecision: recoveryDecisionText(decision),
        },
        attemptUpdates: [{
          attemptId: receipt.attemptId,
          status: 'dispatching',
        }],
        dispatchReceipts: [{
          id: receipt.id,
          milestoneId: receipt.milestoneId,
          attemptId: receipt.attemptId,
          operationKey: receipt.operationKey,
          state: 'failed',
          provider: receipt.provider ?? request.provider,
          idempotencyKey: receipt.idempotencyKey ?? request.idempotencyKey,
          ...(receipt.deadlineAt === undefined ? {} : { deadlineAt: receipt.deadlineAt }),
          detail: resolution.detail ?? 'Provider confirmed no task exists for the reserved dispatch',
        }],
        event: recoveryEvent(
          this.idFactory(),
          milestone.id,
          receipt.attemptId,
          decision,
          'dispatch_absence_confirmed',
        ),
        now: this.now().toISOString(),
      });
      return this.orchestrator.failCurrentAttempt({
        runId: normalized.id,
        expectedRevision: normalized.revision,
        authority: request.authority,
        failureCode: 'dispatch_absent',
        ...(resolution.detail === undefined ? {} : { failureDetail: resolution.detail }),
        retryable: true,
      });
    }

    const decision = classifyAutomationRecovery('dispatch_uncertain', milestone.retryPolicy.classification);
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'blocked',
        ...authorityPatch(request.authority),
        lastRecoveryDecision: recoveryDecisionText(decision),
      },
      attemptUpdates: [{
        attemptId: receipt.attemptId,
        status: 'dispatch_unresolved',
      }],
      dispatchReceipts: [{
        id: receipt.id,
        milestoneId: receipt.milestoneId,
        attemptId: receipt.attemptId,
        operationKey: receipt.operationKey,
        state: 'dispatched_unresolved',
        provider: receipt.provider ?? request.provider,
        idempotencyKey: receipt.idempotencyKey ?? request.idempotencyKey,
        ...(receipt.deadlineAt === undefined ? {} : { deadlineAt: receipt.deadlineAt }),
        detail: resolution.detail ?? 'Provider cannot prove whether dispatch happened',
      }],
      event: recoveryEvent(
        this.idFactory(),
        milestone.id,
        receipt.attemptId,
        decision,
        'dispatch_resolution_unknown',
      ),
      now: this.now().toISOString(),
    });
  }

  private async confirmLaunch(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    receipt: AutomationDispatchReceiptRecord,
    request: AutomationDispatchTaskRequest,
    taskId: string,
    deadlineAt: string | undefined,
    detail: string | undefined,
  ): Promise<AutomationRunSnapshot> {
    assertBoundedText(taskId, 'taskId', 256);
    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'waiting_task',
        ...authorityPatch(request.authority),
        currentMilestoneId: milestone.id,
        currentAttemptId: receipt.attemptId,
        lastRecoveryDecision: null,
      },
      milestoneUpdates: [{
        milestoneId: milestone.id,
        status: 'waiting_task',
        currentAttemptId: receipt.attemptId,
      }],
      attemptUpdates: [{
        attemptId: receipt.attemptId,
        status: 'waiting_task',
      }],
      taskBindings: [{
        attemptId: receipt.attemptId,
        provider: request.provider,
        taskId,
        role: 'blocking_job',
        cancelWithGoal: true,
        boundAt: now,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      }],
      dispatchReceipts: [{
        id: receipt.id,
        milestoneId: receipt.milestoneId,
        attemptId: receipt.attemptId,
        operationKey: receipt.operationKey,
        state: 'confirmed',
        provider: receipt.provider ?? request.provider,
        idempotencyKey: receipt.idempotencyKey ?? request.idempotencyKey,
        externalId: taskId,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(detail === undefined ? {} : { detail }),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: receipt.attemptId,
        type: 'task_bound',
        reason: 'durable_task_launch_confirmed',
        metadata: {
          provider: request.provider,
          taskId,
          deadlineAt: deadlineAt ?? null,
        },
      },
      now,
    });
  }
  private async markDispatchRejected(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    receipt: AutomationDispatchReceiptRecord,
    request: AutomationDispatchTaskRequest,
    outcome: Extract<AutomationTaskLaunchOutcome, { readonly kind: 'rejected' }>,
  ): Promise<AutomationRunSnapshot> {
    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        ...authorityPatch(request.authority),
        lastRecoveryDecision: `launch_rejected:${boundedCode(outcome.code)}`,
      },
      dispatchReceipts: [{
        id: receipt.id,
        milestoneId: receipt.milestoneId,
        attemptId: receipt.attemptId,
        operationKey: receipt.operationKey,
        state: 'failed',
        provider: receipt.provider ?? request.provider,
        idempotencyKey: receipt.idempotencyKey ?? request.idempotencyKey,
        ...(receipt.deadlineAt === undefined ? {} : { deadlineAt: receipt.deadlineAt }),
        detail: boundedDetail(outcome.detail ?? outcome.code),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: receipt.attemptId,
        type: 'task_recovery_decision',
        reason: 'launch_rejected_before_task_handle',
        metadata: {
          code: boundedCode(outcome.code),
          retryable: outcome.retryable,
        },
      },
      now,
    });
  }

  private async markDispatchUnresolved(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    receipt: AutomationDispatchReceiptRecord,
    request: AutomationDispatchTaskRequest,
    detail: string,
  ): Promise<AutomationRunSnapshot> {
    const decision = classifyAutomationRecovery(
      'dispatch_uncertain',
      milestone.retryPolicy.classification,
    );
    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'blocked',
        ...authorityPatch(request.authority),
        lastRecoveryDecision: recoveryDecisionText(decision),
      },
      attemptUpdates: [{
        attemptId: receipt.attemptId,
        status: 'dispatch_unresolved',
      }],
      dispatchReceipts: [{
        id: receipt.id,
        milestoneId: receipt.milestoneId,
        attemptId: receipt.attemptId,
        operationKey: receipt.operationKey,
        state: 'dispatched_unresolved',
        provider: receipt.provider ?? request.provider,
        idempotencyKey: receipt.idempotencyKey ?? request.idempotencyKey,
        ...(receipt.deadlineAt === undefined ? {} : { deadlineAt: receipt.deadlineAt }),
        detail: boundedDetail(detail),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: receipt.attemptId,
        type: 'dispatch_unresolved',
        reason: 'external_launch_outcome_uncertain',
        metadata: {
          provider: request.provider,
          operationKey: request.operationKey,
        },
      },
      additionalEvents: [
        recoveryEvent(
          this.idFactory(),
          milestone.id,
          receipt.attemptId,
          decision,
          'dispatch_requires_resolution_before_retry',
        ),
      ],
      now,
    });
  }

  private async recordHealthyObservation(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    outcome: Extract<AutomationTaskObservationOutcome, { readonly kind: 'observed' }>,
  ): Promise<AutomationRunSnapshot> {
    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'waiting_task',
        ...authorityPatch(authority),
        lastRecoveryDecision: null,
      },
      taskObservationUpdates: [{
        attemptId: binding.attemptId,
        provider: binding.provider,
        taskId: binding.taskId,
        state: outcome.state,
        observedAt: now,
        ...(outcome.detail === undefined ? {} : { detail: boundedDetail(outcome.detail) }),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: binding.attemptId,
        type: 'task_observed',
        reason: 'task_still_running',
        metadata: {
          provider: binding.provider,
          taskId: binding.taskId,
          state: outcome.state,
        },
      },
      now,
    });
  }
  private async recordTerminalObservation(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    state: Extract<AutomationTaskObservedState, 'completed' | 'failed' | 'cancelled' | 'timed_out'>,
    detail: string | undefined,
    terminalAt: string | undefined,
    reason: string,
    decision?: AutomationRecoveryDecision,
  ): Promise<AutomationRunSnapshot> {
    const observedAt = this.now().toISOString();
    const resolvedTerminalAt = validTerminalAt(terminalAt, observedAt);
    const block = decision?.action === 'block_reconciliation';
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: block ? 'blocked' : 'waiting_task',
        ...authorityPatch(authority),
        lastRecoveryDecision: decision === undefined ? null : recoveryDecisionText(decision),
      },
      ...(block ? {
        attemptUpdates: [{
          attemptId: binding.attemptId,
          status: 'failed',
          failureCode: decision.classification,
          failureDetail: detail ?? decision.reason,
          finishedAt: resolvedTerminalAt,
        }],
      } : {}),
      taskObservationUpdates: [{
        attemptId: binding.attemptId,
        provider: binding.provider,
        taskId: binding.taskId,
        state,
        observedAt,
        ...(detail === undefined ? {} : { detail: boundedDetail(detail) }),
        terminalAt: resolvedTerminalAt,
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: binding.attemptId,
        type: 'task_observed',
        reason,
        metadata: {
          provider: binding.provider,
          taskId: binding.taskId,
          state,
        },
      },
      ...(decision === undefined ? {} : {
        additionalEvents: [
          recoveryEvent(
            this.idFactory(),
            milestone.id,
            binding.attemptId,
            decision,
            'terminal_task_recovery_classified',
          ),
        ],
      }),
      now: observedAt,
    });
  }

  private async recordObservedStateRecovery(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    state: Extract<AutomationTaskObservedState, 'not_found' | 'unreachable' | 'termination_unverified'>,
    decision: AutomationRecoveryDecision,
    detail: string,
  ): Promise<AutomationRunSnapshot> {
    return this.recordObservationRecovery(
      snapshot,
      milestone,
      binding,
      authority,
      decision,
      detail,
      true,
      state,
    );
  }

  private async recordObservationRecovery(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    decision: AutomationRecoveryDecision,
    detail: string,
    persistState: boolean,
    state: AutomationTaskObservedState = 'unreachable',
  ): Promise<AutomationRunSnapshot> {
    const now = this.now().toISOString();
    const block = decision.action === 'block_reconciliation';
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: block ? 'blocked' : 'waiting_task',
        ...authorityPatch(authority),
        lastRecoveryDecision: recoveryDecisionText(decision),
      },
      ...(persistState ? {
        taskObservationUpdates: [{
          attemptId: binding.attemptId,
          provider: binding.provider,
          taskId: binding.taskId,
          state,
          observedAt: now,
          detail: boundedDetail(detail),
        }],
      } : {}),
      event: recoveryEvent(
        this.idFactory(),
        milestone.id,
        binding.attemptId,
        decision,
        boundedDetail(detail),
      ),
      now,
    });
  }
  private async handleDeadlineExceeded(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    outcome: Extract<AutomationTaskObservationOutcome, { readonly kind: 'observed' }>,
  ): Promise<AutomationRunSnapshot> {
    const decision = classifyAutomationRecovery(
      'task_deadline_exceeded',
      milestone.retryPolicy.classification,
    );
    let cancellation: AutomationCancelTaskOutcome;
    try {
      cancellation = await this.runtime.cancel({
        workspaceId: snapshot.workspaceId,
        provider: binding.provider,
        taskId: binding.taskId,
      });
    } catch (error) {
      cancellation = {
        kind: 'unknown',
        detail: boundedDetail(error instanceof Error ? error.message : 'Task cancellation transport failed'),
      };
    }

    if (cancellation.kind === 'already_terminal') {
      const synthetic: AutomationTaskObservationOutcome = {
        kind: 'observed',
        state: cancellation.state,
        ...(cancellation.detail === undefined ? {} : { detail: cancellation.detail }),
        ...(cancellation.terminalAt === undefined ? {} : { terminalAt: cancellation.terminalAt }),
      };
      return this.handleSyntheticTerminal(
        snapshot,
        milestone,
        binding,
        authority,
        synthetic,
      );
    }

    const observedAt = this.now().toISOString();
    const cancellationUnknown = cancellation.kind === 'unknown';
    const finalDecision: AutomationRecoveryDecision = cancellationUnknown
      ? {
          classification: 'transport_interrupted',
          action: 'block_reconciliation',
          retryable: false,
          reason: 'Task exceeded its deadline and cancellation could not be verified',
        }
      : decision;
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: cancellationUnknown ? 'blocked' : 'waiting_task',
        ...authorityPatch(authority),
        lastRecoveryDecision: recoveryDecisionText(finalDecision),
      },
      taskObservationUpdates: [{
        attemptId: binding.attemptId,
        provider: binding.provider,
        taskId: binding.taskId,
        state: outcome.state,
        observedAt,
        ...(outcome.detail === undefined ? {} : { detail: boundedDetail(outcome.detail) }),
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: binding.attemptId,
        type: 'task_deadline_exceeded',
        reason: cancellationUnknown
          ? 'deadline_cancel_outcome_unknown'
          : 'deadline_cancel_requested',
        metadata: {
          provider: binding.provider,
          taskId: binding.taskId,
          deadlineAt: binding.deadlineAt ?? null,
        },
      },
      additionalEvents: [
        recoveryEvent(
          this.idFactory(),
          milestone.id,
          binding.attemptId,
          finalDecision,
          cancellation.detail ?? finalDecision.reason,
        ),
      ],
      now: observedAt,
    });
  }

  private async handleSyntheticTerminal(
    snapshot: AutomationRunSnapshot,
    milestone: AutomationMilestoneRecord,
    binding: AutomationTaskBindingRecord,
    authority: AutomationAuthorityCursor,
    outcome: Extract<AutomationTaskObservationOutcome, { readonly kind: 'observed' }>,
  ): Promise<AutomationRunSnapshot> {
    if (outcome.state === 'completed') {
      const observed = await this.recordTerminalObservation(
        snapshot,
        milestone,
        binding,
        authority,
        'completed',
        outcome.detail,
        outcome.terminalAt,
        'task_completed_during_deadline_reconciliation',
      );
      return this.orchestrator.beginVerification({
        runId: observed.id,
        expectedRevision: observed.revision,
        authority,
      });
    }
    if (
      outcome.state !== 'failed'
      && outcome.state !== 'cancelled'
      && outcome.state !== 'timed_out'
    ) {
      throw new AutomationStateError('corrupt', 'Cancellation returned a non-terminal task state');
    }
    const recoveryClass = taskFailureRecoveryClass(outcome.state);
    const decision = classifyAutomationRecovery(
      recoveryClass,
      milestone.retryPolicy.classification,
    );
    const observed = await this.recordTerminalObservation(
      snapshot,
      milestone,
      binding,
      authority,
      outcome.state,
      outcome.detail,
      outcome.terminalAt,
      decision.reason,
      decision,
    );
    if (decision.action !== 'retry_attempt' && decision.action !== 'fail_attempt') return observed;
    return this.orchestrator.failCurrentAttempt({
      runId: observed.id,
      expectedRevision: observed.revision,
      authority,
      failureCode: recoveryClass,
      ...(outcome.detail === undefined ? {} : { failureDetail: outcome.detail }),
      retryable: decision.retryable,
    });
  }

  private async loadExpected(
    request: AutomationMutationRequest,
  ): Promise<AutomationRunSnapshot> {
    const snapshot = await this.repository.getRunById(request.runId);
    if (snapshot === null) throw new AutomationStateError('not_found', 'Automation run was not found');
    if (snapshot.revision !== request.expectedRevision) {
      throw new AutomationStateError('conflict', 'Automation run revision changed concurrently');
    }
    if (snapshot.basedOnUserIntentRevision !== request.authority.userIntentRevision) {
      throw new AutomationStateError(
        'conflict',
        'Durable goal user intent changed; reconcile or replan task supervision before continuing',
      );
    }
    return snapshot;
  }
}
export function classifyAutomationRecovery(
  classification: AutomationRecoveryClass,
  retryClass: AutomationRetryClass,
): AutomationRecoveryDecision {
  switch (classification) {
    case 'observation_timeout':
      return decision(classification, 'continue_observing', false, 'Observation timeout is not task failure');
    case 'transport_interrupted':
      return decision(classification, 'continue_observing', false, 'Transport interruption must not trigger task replay');
    case 'dispatch_uncertain':
      return decision(classification, 'block_reconciliation', false, 'Uncertain dispatch must be resolved before any retry');
    case 'dispatch_absent':
      return decision(classification, 'retry_attempt', true, 'Provider proved that the reserved dispatch created no task');
    case 'task_deadline_exceeded':
      return decision(classification, 'cancel_and_reobserve', false, 'Deadline requires verified cancellation before retry');
    case 'task_missing':
      return decision(classification, 'block_reconciliation', false, 'A durable task handle disappeared and requires reconciliation');
    case 'termination_unverified':
      return decision(classification, 'block_reconciliation', false, 'Task termination is not trustworthy enough for replay');
    case 'task_failed':
    case 'task_cancelled':
    case 'task_timed_out':
      if (isAutoRetrySafe(retryClass)) {
        return decision(classification, 'retry_attempt', true, 'Terminal task outcome is safe to retry under the milestone retry class');
      }
      return decision(classification, 'block_reconciliation', false, 'Terminal task may have produced partial side effects; automatic replay is unsafe');
  }
}

function decision(
  classification: AutomationRecoveryClass,
  action: AutomationRecoveryDecision['action'],
  retryable: boolean,
  reason: string,
): AutomationRecoveryDecision {
  return { classification, action, retryable, reason };
}

function isAutoRetrySafe(retryClass: AutomationRetryClass): boolean {
  return retryClass === 'safe_read'
    || retryClass === 'idempotent_local_state'
    || retryClass === 'durable_task_observation';
}

function taskFailureRecoveryClass(
  state: Extract<AutomationTaskObservedState, 'failed' | 'cancelled' | 'timed_out'>,
): AutomationRecoveryClass {
  if (state === 'failed') return 'task_failed';
  if (state === 'cancelled') return 'task_cancelled';
  return 'task_timed_out';
}

function assertTaskSupervisionNotPaused(snapshot: AutomationRunSnapshot): void {
  if (snapshot.status === 'paused') {
    throw new AutomationStateError(
      'conflict',
      'Automation task supervision is paused; resume the automation before observing or recovering work',
    );
  }
}

function currentDispatchAttempt(snapshot: AutomationRunSnapshot): {
  readonly milestone: AutomationMilestoneRecord;
  readonly attemptId: string;
} {
  if (snapshot.status !== 'running') {
    throw new AutomationStateError('conflict', 'Automation run is not ready for task dispatch');
  }
  const milestone = requireCurrentMilestone(snapshot);
  const attemptId = requireCurrentAttemptId(snapshot);
  const attempt = snapshot.attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined) throw new AutomationStateError('corrupt', 'Automation current attempt is missing');
  if (milestone.status !== 'running' || attempt.status !== 'dispatching') {
    throw new AutomationStateError('conflict', 'Automation attempt is not in dispatching state');
  }
  return { milestone, attemptId };
}

function requireCurrentMilestone(snapshot: AutomationRunSnapshot): AutomationMilestoneRecord {
  const id = snapshot.currentMilestoneId;
  if (id === undefined) throw new AutomationStateError('conflict', 'Automation has no current milestone');
  const milestone = snapshot.milestones.find((candidate) => candidate.id === id);
  if (milestone === undefined) throw new AutomationStateError('corrupt', 'Automation current milestone is missing');
  return milestone;
}

function requireCurrentAttemptId(snapshot: AutomationRunSnapshot): string {
  if (snapshot.currentAttemptId === undefined) {
    throw new AutomationStateError('conflict', 'Automation has no current attempt');
  }
  return snapshot.currentAttemptId;
}

function receiptFor(
  snapshot: AutomationRunSnapshot,
  attemptId: string,
  operationKey: string,
): AutomationDispatchReceiptRecord | undefined {
  return snapshot.dispatchReceipts.find(
    (receipt) => receipt.attemptId === attemptId && receipt.operationKey === operationKey,
  );
}
function requireReceipt(
  snapshot: AutomationRunSnapshot,
  attemptId: string,
  operationKey: string,
): AutomationDispatchReceiptRecord {
  const receipt = receiptFor(snapshot, attemptId, operationKey);
  if (receipt === undefined) {
    throw new AutomationStateError('not_found', 'Automation dispatch receipt was not found');
  }
  return receipt;
}

function assertReceiptIdentity(
  receipt: AutomationDispatchReceiptRecord,
  request: AutomationDispatchTaskRequest,
): void {
  const requestedDeadline = deadlineFrom(receipt.createdAt, request.deadlineMs);
  if (
    receipt.idempotencyKey !== request.idempotencyKey
    || receipt.provider !== request.provider
    || receipt.deadlineAt !== requestedDeadline
  ) {
    throw new AutomationStateError('conflict', 'Automation dispatch replay changed durable dispatch identity');
  }
}

function assertConfirmedBinding(
  snapshot: AutomationRunSnapshot,
  receipt: AutomationDispatchReceiptRecord,
): AutomationRunSnapshot {
  if (receipt.externalId === undefined) {
    throw new AutomationStateError('corrupt', 'Confirmed automation dispatch has no external task id');
  }
  const exists = snapshot.taskBindings.some(
    (binding) => binding.attemptId === receipt.attemptId && binding.taskId === receipt.externalId,
  );
  if (!exists) throw new AutomationStateError('corrupt', 'Confirmed automation dispatch has no durable task binding');
  return snapshot;
}

function currentBlockingBinding(
  snapshot: AutomationRunSnapshot,
  attemptId: string,
): AutomationTaskBindingRecord {
  const bindings = snapshot.taskBindings.filter(
    (binding) => binding.attemptId === attemptId && binding.role === 'blocking_job',
  );
  if (bindings.length !== 1) {
    throw new AutomationStateError(
      bindings.length === 0 ? 'not_found' : 'conflict',
      'M3 task supervision requires exactly one blocking task binding for the current attempt',
    );
  }
  const binding = bindings[0];
  if (binding === undefined) throw new AutomationStateError('corrupt', 'Automation task binding disappeared');
  return binding;
}

function authorityPatch(authority: AutomationAuthorityCursor): {
  readonly basedOnGoalRevision: number;
  readonly basedOnUserIntentRevision: number;
} {
  return {
    basedOnGoalRevision: authority.goalRevision,
    basedOnUserIntentRevision: authority.userIntentRevision,
  };
}

function deadlineFrom(boundAt: string, deadlineMs: number | undefined): string | undefined {
  if (deadlineMs === undefined) return undefined;
  return new Date(Date.parse(boundAt) + deadlineMs).toISOString();
}

function deadlineExceeded(binding: AutomationTaskBindingRecord, now: Date): boolean {
  return binding.deadlineAt !== undefined && now.getTime() >= Date.parse(binding.deadlineAt);
}

function recoveryDecisionText(decision: AutomationRecoveryDecision): string {
  return `${decision.classification}:${decision.action}:${decision.reason}`.slice(0, MAX_DETAIL);
}

function recoveryEvent(
  id: string,
  milestoneId: string,
  attemptId: string,
  recovery: AutomationRecoveryDecision,
  reason: string,
): {
  readonly id: string;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly type: 'task_recovery_decision';
  readonly reason: string;
  readonly metadata: {
    readonly classification: string;
    readonly action: string;
    readonly retryable: boolean;
  };
} {
  return {
    id,
    milestoneId,
    attemptId,
    type: 'task_recovery_decision',
    reason: boundedDetail(reason),
    metadata: {
      classification: recovery.classification,
      action: recovery.action,
      retryable: recovery.retryable,
    },
  };
}
function validTerminalAt(value: string | undefined, observedAt: string): string {
  if (value === undefined) return observedAt;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.parse(observedAt)) return observedAt;
  return new Date(parsed).toISOString();
}

function validateDispatchRequest(request: AutomationDispatchTaskRequest): void {
  validateMutationBase(request);
  if (request.provider !== 'process' && request.provider !== 'codex' && request.provider !== 'shell') {
    throw new AutomationStateError('conflict', 'Automation task provider is invalid');
  }
  if (request.execution !== undefined && request.execution.provider !== request.provider) {
    throw new AutomationStateError('conflict', 'Automation execution provider does not match the dispatch provider');
  }
  assertBoundedText(request.operationKey, 'operationKey', MAX_OPERATION_KEY);
  assertBoundedText(request.idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY);
  if (
    request.deadlineMs !== undefined
    && (!Number.isInteger(request.deadlineMs) || request.deadlineMs < 1_000 || request.deadlineMs > MAX_DEADLINE_MS)
  ) {
    throw new AutomationStateError('conflict', 'Automation task deadlineMs must be between 1000 and 604800000');
  }
}

function validateMutationBase(request: AutomationMutationRequest): void {
  assertBoundedText(request.runId, 'runId', 256);
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new AutomationStateError('conflict', 'Automation expected revision is invalid');
  }
  if (!Number.isInteger(request.authority.goalRevision) || request.authority.goalRevision < 0) {
    throw new AutomationStateError('conflict', 'Automation durable goal revision is invalid');
  }
  if (
    !Number.isInteger(request.authority.userIntentRevision)
    || request.authority.userIntentRevision < 0
  ) {
    throw new AutomationStateError('conflict', 'Automation durable user intent revision is invalid');
  }
}

function assertBoundedText(value: string, label: string, maxLength: number): void {
  if (value.trim().length === 0 || value.length > maxLength || containsControl(value)) {
    throw new AutomationStateError('conflict', `Automation ${label} is invalid`);
  }
}

function boundedDetail(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const point = character.codePointAt(0);
    cleaned += point !== undefined && (point <= 0x1f || point === 0x7f) ? ' ' : character;
  }
  const normalized = cleaned.trim();
  return (normalized.length === 0 ? 'unspecified' : normalized).slice(0, MAX_DETAIL);
}

function boundedCode(value: string): string {
  return boundedDetail(value).slice(0, 256);
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
  }
  return false;
}
