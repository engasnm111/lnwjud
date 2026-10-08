export type ObservedCallTransport = 'local_stdio' | 'loopback_http' | 'secure_tunnel' | 'external_mcp' | 'unknown';
export type ObservedCallOutcome = 'success' | 'failure' | 'cancelled' | 'incomplete' | 'unknown';
export interface CallTimingObservation {
  readonly correlationKey: string;
  readonly toolName: string;
  readonly workspaceId: string | null;
  readonly goalId: string | null;
  readonly transport: ObservedCallTransport;
  readonly outcome: ObservedCallOutcome;
  readonly serverMs: number | null;
  readonly tunnelObservedMs: number | null;
  readonly completedAt: string | null;
}
export interface CallHistoryQuery {
  readonly workspaceId: string;
  readonly goalId?: string;
  readonly toolName?: string;
  readonly transport?: CallTimingObservation['transport'];
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface CallHistoryPage {
  readonly items: readonly CallTimingObservation[];
  readonly nextCursor: string | null;
  readonly sampledAt: string;
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly truncated: boolean;
  readonly totals: CallTimingAggregate;
}

export interface ResourceSnapshotRequest { readonly workspaceId: string; readonly goalId?: string }
export interface ResourceSnapshot {
  readonly workspaceId: string; readonly sampledAt: string; readonly stale: boolean;
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly resources: readonly { readonly taskId?: string; readonly provider: string;
    readonly goalId?: string; readonly role: string;
    readonly ownership: 'owned' | 'shared' | 'foreign' | 'unknown';
    readonly workingSetBytes?: number; readonly cpuPercent?: number;
    readonly canCancel: boolean }[];
  readonly context: {
    readonly rawContextBytes: number | null; readonly contextSentBytes: number | null;
    readonly previouslySeenBytesAvoided: number | null; readonly ledgerHits: number | null;
  };
}

export interface TaskResultSummary {
  readonly workspaceId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  /** Verified workspace-scoped durable Goal progress; not a substitute for artifact/check evidence. */
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
  readonly blockers: readonly string[];
  readonly lastCheckpointId: string | null;
  readonly evidenceCoverage: 'complete' | 'partial' | 'unknown';
}
export interface CallTimingAggregate {
  readonly completedCount: number;
  readonly incompleteCount: number;
  readonly serverSampleCount: number;
  readonly serverP50Ms: number | null;
  readonly serverP95Ms: number | null;
  readonly tunnelSampleCount: number;
  readonly tunnelP50Ms: number | null;
  readonly tunnelP95Ms: number | null;
}
