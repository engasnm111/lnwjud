import { createHash } from 'node:crypto';
import { appError, err, ok, type Result, type WorkflowStartRequest, type WorkflowStartResult, type WorkflowGoalMetadata } from '@lnwjud/domain';
import type { FileActor } from '../file-service.js';
import { GoalContinuationService } from '../goal-continuation-service.js';
import { WorkflowTemplateService } from './workflow-template-service.js';

/** Explicit AI handoff only: a prepared Desktop draft never starts a worker. */
export class WorkflowStartService {
  public constructor(
    private readonly templates: WorkflowTemplateService,
    private readonly goals: GoalContinuationService,
  ) {}

  public async start(actor: FileActor, request: WorkflowStartRequest): Promise<Result<WorkflowStartResult>> {
    if (!request || !request.draft || typeof request.idempotencyKey !== 'string'
      || request.idempotencyKey.length === 0 || request.idempotencyKey.length > 256) {
      return err(appError('INVALID_INPUT', 'Workflow start requires a bounded idempotency key and draft'));
    }
    const draft = request.draft;
    const prepared = await this.templates.prepare(actor, {
      workspaceId: draft.workspaceId, templateId: draft.templateId, inputs: draft.inputs,
    });
    if (!prepared.ok) return prepared;
    const current = prepared.value;
    if (draft.schemaVersion !== 1 || draft.digest !== current.digest ||
      draft.templateRevision !== current.templateRevision || draft.objective !== current.objective ||
      JSON.stringify(draft.steps) !== JSON.stringify(current.steps) ||
      JSON.stringify(draft.acceptance) !== JSON.stringify(current.acceptance)) {
      return err(appError('CONFLICT', 'Workflow draft changed; prepare again'));
    }
    if (current.readiness !== 'ready') {
      return err(appError('INVALID_INPUT', `Workflow is not ready: ${current.blockers.join('; ')}`));
    }
    const requestKeyHash = createHash('sha256').update(request.idempotencyKey).digest('hex');
    const goalKey = `workflow:${current.templateId}:${requestKeyHash.slice(0, 32)}`;
    const workflow: WorkflowGoalMetadata = {
      schemaVersion: 1, templateId: current.templateId, templateRevision: current.templateRevision,
      inputDigest: current.digest, requestKeyHash, inputs: current.inputs,
    };
    const before = await this.goals.getGoal(actor, { workspaceId: current.workspaceId, goalKey });
    const result = await this.goals.runGoal(actor, {
      workspaceId: current.workspaceId, goalKey, objective: current.objective,
      workflow, plan: { steps: current.steps }, acceptanceCriteria: current.acceptance,
    });
    if (!result.ok) return result;
    const state = result.value;
    const proof = state.acquired && state.leaseToken
      ? { goalId: state.goalId, leaseToken: state.leaseToken, leaseGeneration: state.leaseGeneration }
      : undefined;
    return ok({
      goalId: state.goalId,
      reused: before.ok || !state.acquired,
      workerState: proof ? 'attached' : 'awaiting_worker',
      scheduledContinuation: 'off',
      ...(proof ? { goalLease: proof } : {}),
    });
  }
}
