export type ActivityTargetDetail =
  | { readonly kind: 'files'; readonly items: readonly string[] }
  | { readonly kind: 'tools'; readonly items: readonly string[] }
  | { readonly kind: 'details'; readonly items: readonly string[] };

export interface ActivityTargetReference {
  /** Immutable started-event/call identifier used for lazy detail resolution. */
  readonly detailRef: string | null;
  readonly itemCount: number;
  readonly preview: readonly string[];
  /** True when the retained detail adds useful information beyond the compact row summary. */
  readonly hasAdditionalDetail?: boolean;
  /** True when an older record contains only a summary and cannot be losslessly expanded. */
  readonly legacyIncomplete: boolean;
}

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

export interface AuditEventSummaryProjection {
  readonly id: string;
  readonly timestamp: string;
  readonly action: string;
  readonly resultCode: string;
}

/** Compact row projection for activity feeds. It never contains metadata_json. */
export interface ActivityAuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly targetSummary?: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly toolName: string;
  readonly callId?: string;
  readonly phase: 'started' | 'completed';
  readonly errorMessage?: string;
  readonly targetDetail: ActivityTargetReference;
}

export interface AuditEventRepository {
  insert(event: AuditEvent): Promise<void>;
  list(limit?: number): Promise<AuditEvent[]>;
  listByActionPrefix(prefix: string, limit?: number): Promise<AuditEvent[]>;
  listScoped(query: AuditEventQuery, limit?: number): Promise<AuditEvent[]>;
  listSummaries(limit?: number): Promise<AuditEventSummaryProjection[]>;
  listActivityScoped(query: AuditEventQuery, limit?: number): Promise<ActivityAuditEvent[]>;
  /** Resolves at most one started-event detail by exact event ID or call ID. */
  resolveActivityTargetDetail(idOrCallId: string): Promise<ActivityTargetDetail | null>;
}

export interface AutomationAuditInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly eventId: string;
  readonly runId: string;
  readonly goalId: string;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly transition: string;
  readonly reason: string;
  readonly taskProvider?: 'process' | 'codex' | 'shell';
  readonly taskId?: string;
  readonly childCallId?: string;
  readonly leaseGeneration?: number;
  readonly policyDecision?: string;
  readonly recoveryClassification?: string;
  readonly verificationOutcome?: 'passed' | 'failed' | 'pending';
  readonly elapsedDurationMs: number;
  readonly retryCount: number;
  readonly resultCode: string;
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
  readonly targetDetail: ActivityTargetReference;
  /** Full sanitized detail retained lazily for either input (started) or result (completed) diagnostics. */
  readonly activityTargetDetail?: ActivityTargetDetail;
  readonly resultCode: string;
  readonly resultMessage?: string;
  readonly durationMs: number;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}
