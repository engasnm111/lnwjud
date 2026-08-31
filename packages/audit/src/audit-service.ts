import { randomUUID } from 'node:crypto';
import { codexInstructionSummary, Redactor } from './redactor.js';
import type {
  AuditEvent,
  AuditEventInput,
  AuditEventRepository,
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
      ...(input.targetSummary === undefined ? {} : { targetSummary: input.targetSummary }),
      ...(input.permissionDecision === undefined ? {} : { permissionDecision: input.permissionDecision }),
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: this.redactor.redactRecord(input.metadata ?? {}),
    };
    await this.repository.insert(event);
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
  CodexRunAuditInput,
  McpToolAuditInput,
} from './audit-types.js';
