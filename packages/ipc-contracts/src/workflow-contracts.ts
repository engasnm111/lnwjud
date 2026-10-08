/** Serializable renderer-safe DTOs: must not import server-side @lnwjud/domain. */
export type WorkflowTemplateId = 'project-check' | 'code-review' | 'release-readiness' | 'connection-check' | 'data-audit' | 'template-report';
export interface WorkflowTemplate {
  readonly id: WorkflowTemplateId; readonly revision: number; readonly titleTh: string; readonly titleEn: string;
  readonly descriptionTh: string; readonly descriptionEn: string;
  readonly category: 'coding' | 'diagnostics' | 'office';
  readonly inputFields: readonly { readonly key: string; readonly labelTh: string; readonly labelEn: string; readonly type: 'path' | 'text' | 'enum' | 'mapping_file'; readonly required: boolean; readonly options?: readonly string[] }[];
  readonly outputKinds: readonly ('report' | 'file' | 'diagnostics')[];
  readonly requiredCapabilities: readonly string[]; readonly readOnly: boolean;
  readonly estimatedEffort: 'small' | 'medium' | 'large';
}
export interface WorkflowPrepareRequest { readonly workspaceId: string; readonly templateId: WorkflowTemplateId; readonly inputs: Readonly<Record<string, string>> }
export interface WorkflowDraft {
  readonly schemaVersion: 1; readonly workspaceId: string; readonly templateId: WorkflowTemplateId;
  readonly templateRevision: number; readonly inputs: Readonly<Record<string, string>>; readonly digest: string;
  readonly objective: string; readonly steps: readonly { readonly id: string; readonly title: string }[];
  readonly acceptance: readonly { readonly id: string; readonly title: string }[];
  readonly readiness: 'ready' | 'needs_setup' | 'unsupported' | 'unknown';
  readonly blockers: readonly string[]; readonly preparedAt: string;
}
export interface WorkflowStartRequest { readonly draft: WorkflowDraft; readonly idempotencyKey: string }
export interface WorkflowStartResult {
  readonly goalId: string; readonly reused: boolean; readonly workerState: 'attached' | 'awaiting_worker';
  readonly scheduledContinuation: 'off'; readonly goalLease?: { readonly goalId: string; readonly leaseToken: string; readonly leaseGeneration: number };
}
export interface CallTimingObservation {
  readonly correlationKey: string; readonly toolName: string; readonly workspaceId: string | null;
  readonly goalId: string | null;
  readonly transport: 'local_stdio' | 'loopback_http' | 'secure_tunnel' | 'external_mcp' | 'unknown';
  readonly outcome: 'success' | 'failure' | 'cancelled' | 'incomplete' | 'unknown';
  readonly serverMs: number | null; readonly tunnelObservedMs: number | null; readonly completedAt: string | null;
}
export interface CallTimingAggregate {
  readonly completedCount: number; readonly incompleteCount: number; readonly serverSampleCount: number;
  readonly serverP50Ms: number | null; readonly serverP95Ms: number | null; readonly tunnelSampleCount: number;
  readonly tunnelP50Ms: number | null; readonly tunnelP95Ms: number | null;
}
export interface WorkflowTemplateListResponse { readonly items: readonly WorkflowTemplate[]; readonly sampledAt: string }
export interface CallHistoryRequest {
  readonly workspaceId: string; readonly goalId?: string; readonly toolName?: string;
  readonly transport?: CallTimingObservation['transport']; readonly since?: string;
  readonly until?: string; readonly limit?: number; readonly cursor?: string;
}
export interface CallHistoryPage {
  readonly items: readonly CallTimingObservation[]; readonly nextCursor: string | null;
  readonly sampledAt: string; readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly truncated: boolean; readonly totals: CallTimingAggregate;
}
export interface TaskResultSummary {
  readonly workspaceId: string; readonly goalId: string; readonly goalRevision: number;
  readonly progress?: { readonly currentPhase: string; readonly nextAction: string;
    readonly updatedAt: string; readonly lastCheckpointSummary: string | null;
    readonly terminalSummary?: string; readonly steps: readonly {
      readonly id: string; readonly title: string; readonly status: 'pending' | 'in_progress' | 'completed' | 'blocked';
      readonly summary?: string;
    }[]; };
  readonly status: 'active' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  readonly observedChanges: readonly { readonly operationId: string; readonly path: string; readonly action: string; readonly observedAt: string }[];
  readonly artifacts: readonly { readonly path: string; readonly kind: string; readonly sha256?: string; readonly sizeBytes?: number; readonly verification: 'verified' | 'unverified' | 'failed' }[];
  readonly checks: readonly { readonly name: string; readonly status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'stale' | 'unknown' }[];
  readonly blockers: readonly string[]; readonly lastCheckpointId: string | null; readonly evidenceCoverage: 'complete' | 'partial' | 'unknown';
}

export interface RestoreTaskCheckpointRequest {
  readonly workspaceId: string; readonly goalId: string; readonly goalRevision: number;
  readonly checkpointId: string; readonly expectedCurrentHashes: Readonly<Record<string,string>>;
  readonly userConfirmed: boolean;
}
export interface RestoreTaskCheckpointResult {
  readonly restored: boolean; readonly paths: readonly string[];
  readonly rollbackCheckpointId: string | null;
}
export interface CancelOwnedGoalTaskRequest {
  readonly workspaceId: string; readonly goalId: string; readonly taskId: string;
  readonly provider: 'process' | 'codex' | 'shell'; readonly userConfirmed: boolean;
}
export interface CancelOwnedGoalTaskResult {
  readonly taskId: string;
  readonly status: 'cancelled' | 'already_terminal' | 'not_found' | 'skipped' | 'failed';
  readonly error?: string;
}
export interface ResourceSnapshotRequest { readonly workspaceId: string; readonly goalId?: string }
export interface ResourceSnapshot {
  readonly workspaceId: string; readonly sampledAt: string; readonly stale: boolean;
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly resources: readonly { readonly taskId?: string; readonly provider: string; readonly goalId?: string; readonly role: string; readonly ownership: 'owned' | 'shared' | 'foreign' | 'unknown'; readonly workingSetBytes?: number; readonly cpuPercent?: number; readonly canCancel: boolean }[];
  readonly context: { readonly rawContextBytes: number | null; readonly contextSentBytes: number | null; readonly previouslySeenBytesAvoided: number | null; readonly ledgerHits: number | null };
}
