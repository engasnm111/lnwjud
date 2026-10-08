export type WorkflowTemplateId = 'project-check' | 'code-review' | 'release-readiness' | 'connection-check' | 'data-audit' | 'template-report';
export type WorkflowReadiness = 'ready' | 'needs_setup' | 'unsupported' | 'unknown';

export interface WorkflowTemplate {
  readonly id: WorkflowTemplateId;
  readonly revision: number;
  readonly titleTh: string;
  readonly titleEn: string;
  readonly descriptionTh: string;
  readonly descriptionEn: string;
  readonly category: 'coding' | 'diagnostics' | 'office';
  readonly inputFields: readonly { readonly key: string; readonly labelTh: string; readonly labelEn: string; readonly type: 'path' | 'text' | 'enum' | 'mapping_file'; readonly required: boolean; readonly options?: readonly string[] }[];
  readonly outputKinds: readonly ('report' | 'file' | 'diagnostics')[];
  readonly requiredCapabilities: readonly string[];
  readonly readOnly: boolean;
  readonly estimatedEffort: 'small' | 'medium' | 'large';
}

export interface WorkflowGoalMetadata {
  readonly schemaVersion: 1;
  readonly templateId: WorkflowTemplateId;
  readonly templateRevision: number;
  readonly inputDigest: string;
  readonly requestKeyHash: string;
  readonly inputs: Readonly<Record<string, string>>;
}
/** Preserve future workflow metadata without attempting to interpret it. */
export type StoredWorkflowMetadata = WorkflowGoalMetadata | { readonly schemaVersion: number; readonly [key: string]: unknown };
export interface WorkflowPrepareRequest {
  readonly workspaceId: string;
  readonly templateId: WorkflowTemplateId;
  readonly inputs: Readonly<Record<string, string>>;
}
export interface WorkflowDraft {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly templateId: WorkflowTemplateId;
  readonly templateRevision: number;
  readonly inputs: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly objective: string;
  readonly steps: readonly { readonly id: string; readonly title: string }[];
  readonly acceptance: readonly { readonly id: string; readonly title: string }[];
  readonly readiness: WorkflowReadiness;
  readonly blockers: readonly string[];
  readonly preparedAt: string;
}
export interface WorkflowStartRequest {
  readonly draft: WorkflowDraft;
  readonly idempotencyKey: string;
}
export interface WorkflowStartResult {
  readonly goalId: string;
  readonly reused: boolean;
  readonly workerState: 'attached' | 'awaiting_worker';
  readonly scheduledContinuation: 'off';
  readonly goalLease?: import('./goal-continuation.js').GoalLeaseProof;
}
