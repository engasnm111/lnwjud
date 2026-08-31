export interface AuditEventInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly targetSummary?: string;
  readonly permissionDecision?: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly targetSummary?: string;
  readonly permissionDecision?: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventQuery {
  readonly actionPrefix?: string;
  /** undefined = all workspaces; null = global/unscoped events only. */
  readonly workspaceId?: string | null;
  /** undefined = all sessions; null = legacy/unscoped events only. */
  readonly sessionId?: string | null;
}

export interface AuditEventRepository {
  insert(event: AuditEvent): Promise<void>;
  list(limit?: number): Promise<AuditEvent[]>;
  listByActionPrefix(prefix: string, limit?: number): Promise<AuditEvent[]>;
  listScoped(query: AuditEventQuery, limit?: number): Promise<AuditEvent[]>;
}

export interface CodexRunAuditInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly codexTaskId: string;
  readonly instruction: string;
  readonly resultCode: string;
  readonly durationMs: number;
}

export interface McpToolAuditInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly toolName: string;
  readonly callId: string;
  readonly phase: 'started' | 'completed';
  readonly targetSummary?: string;
  readonly resultCode: string;
  readonly resultMessage?: string;
  readonly durationMs: number;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}
