import { randomUUID } from 'node:crypto';
import { activityTargetReference, codexInstructionSummary, decodeActivityTargetReference, redactActivityTargetDetail, Redactor } from './redactor.js';
import type {
  AuditEvent,
  AuditEventInput,
  AuditEventRepository,
  AutomationAuditInput,
  CodexRunAuditInput,
  McpToolAuditInput,
} from './audit-types.js';

export class AuditService {
  public constructor(
    private readonly repository: AuditEventRepository,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  public async record(input: AuditEventInput): Promise<void> {
    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      action: input.action,
      ...(input.targetSummary === undefined ? {} : { targetSummary: this.redactor.redactText(input.targetSummary) }),
      ...(input.permissionDecision === undefined ? {} : { permissionDecision: input.permissionDecision }),
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: this.redactor.redactRecord(input.metadata ?? {}),
    };
    await this.repository.insert(event);
  }

  public recordAutomationEvent(input: AutomationAuditInput): Promise<void> {
    const detailItems = [
      `runId=${input.runId}`,
      `goalId=${input.goalId}`,
      `workspaceId=${input.workspaceId}`,
      `transition=${input.transition}`,
      `reason=${input.reason}`,
      ...(input.milestoneId === undefined ? [] : [`milestoneId=${input.milestoneId}`]),
      ...(input.attemptId === undefined ? [] : [`attemptId=${input.attemptId}`]),
      ...(input.taskProvider === undefined ? [] : [`taskProvider=${input.taskProvider}`]),
      ...(input.taskId === undefined ? [] : [`taskId=${input.taskId}`]),
      ...(input.taskProvider === undefined || input.taskId === undefined
        ? []
        : [`task=${input.taskProvider}:${input.taskId}`]),
      ...(input.childCallId === undefined ? [] : [`childCallId=${input.childCallId}`]),
      ...(input.leaseGeneration === undefined ? [] : [`leaseGeneration=${input.leaseGeneration}`]),
      ...(input.policyDecision === undefined ? [] : [`policyDecision=${input.policyDecision}`]),
      ...(input.recoveryClassification === undefined ? [] : [`recoveryClassification=${input.recoveryClassification}`]),
      ...(input.verificationOutcome === undefined ? [] : [`verificationOutcome=${input.verificationOutcome}`]),
      `elapsedDurationMs=${input.elapsedDurationMs}`,
      `retryCount=${input.retryCount}`,
    ];
    const activityDetail = redactActivityTargetDetail({ kind: 'details', items: detailItems }, this.redactor);
    const targetSummary = this.redactor.redactText(
      `run ${input.runId} · ${input.transition} · ${input.reason}`,
    ).slice(0, 512);
    const callId = `automation:${input.eventId}`;
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      action: `mcp_tool:automation:${input.transition}`,
      targetSummary,
      resultCode: input.resultCode,
      durationMs: input.elapsedDurationMs,
      metadata: {
        toolName: `automation:${input.transition}`,
        callId,
        phase: 'completed',
        targetDetail: activityTargetReference(callId, activityDetail, targetSummary),
        activityTargetDetail: activityDetail,
        automation: {
          eventId: input.eventId,
          runId: input.runId,
          goalId: input.goalId,
          milestoneId: input.milestoneId ?? null,
          attemptId: input.attemptId ?? null,
          transition: input.transition,
          reason: input.reason,
          taskProvider: input.taskProvider ?? null,
          taskId: input.taskId ?? null,
          childCallId: input.childCallId ?? null,
          leaseGeneration: input.leaseGeneration ?? null,
          policyDecision: input.policyDecision ?? null,
          recoveryClassification: input.recoveryClassification ?? null,
          verificationOutcome: input.verificationOutcome ?? null,
          elapsedDurationMs: input.elapsedDurationMs,
          retryCount: input.retryCount,
        },
      },
    });
  }

  public recordCodexRun(input: CodexRunAuditInput): Promise<void> {
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      action: 'codex_run',
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: { ...codexInstructionSummary(input.codexTaskId, input.instruction) },
    });
  }

  public recordMcpTool(input: McpToolAuditInput): Promise<void> {
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      action: `mcp_tool:${input.toolName}`,
      ...(input.targetSummary === undefined ? {} : { targetSummary: input.targetSummary }),
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: {
        toolName: input.toolName,
        callId: input.callId,
        phase: input.phase,
        targetDetail: decodeActivityTargetReference(input.targetDetail, input.targetSummary),
        ...(input.activityTargetDetail === undefined
          ? {}
          : { activityTargetDetail: redactActivityTargetDetail(input.activityTargetDetail, this.redactor) }),
        ...(input.resultMessage === undefined ? {} : { errorMessage: input.resultMessage }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        ...(input.traceParent === undefined ? {} : { traceParent: input.traceParent }),
        ...(input.authorizationMode === undefined ? {} : { authorizationMode: input.authorizationMode }),
      },
    });
  }
}

export type {
  AuditEvent,
  AuditEventInput,
  AuditEventQuery,
  AuditEventRepository,
  AutomationAuditInput,
  CodexRunAuditInput,
  McpToolAuditInput,
} from './audit-types.js';
