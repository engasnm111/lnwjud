export type EngineeringTaskKind =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'review'
  | 'incident'
  | 'release'
  | 'maintenance'
  | 'docs'
  | 'unknown';

export type EngineeringRiskTier = 'low' | 'medium' | 'high' | 'critical';

export type EngineeringDeliveryScope =
  | 'local'
  | 'commit'
  | 'push'
  | 'pull_request'
  | 'merge'
  | 'release'
  | 'deploy';

export type EngineeringGateStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_applicable'
  | 'stale';

export type EngineeringGateEvidenceSource = 'host_observed' | 'user_attested';

export interface EngineeringGateEvidence {
  readonly source: EngineeringGateEvidenceSource;
  readonly observedAt: string;
  readonly workspaceId: string;
  readonly commit?: string;
  readonly command?: string;
  readonly runId?: string;
  readonly exitCode?: number;
  readonly conclusion?: string;
  readonly artifact?: string;
  readonly sourceDigest?: string;
  readonly artifactDigest?: string;
  readonly contractDigest?: string;
  readonly observationId?: string;
}

export interface EngineeringGateDefinition {
  readonly id: string;
  readonly title: string;
  readonly applicability: 'required' | 'optional' | 'not_applicable' | 'unresolved';
  readonly status: EngineeringGateStatus;
  readonly reason: string;
  readonly basedOnUserIntentRevision: number;
  readonly checkCommand?: string;
  readonly requiredPlatforms?: readonly ('win32' | 'darwin' | 'linux')[];
  readonly evidence?: EngineeringGateEvidence;
  readonly decision?: EngineeringGateDecision;
}

/** Required proof gates cannot be dismissed by a free-form reason. */
export function mayMarkEngineeringGateNotApplicable(gate: EngineeringGateDefinition): boolean {
  if (gate.decision !== undefined) return gate.applicability === 'not_applicable' && gate.decision.authority === 'host_policy';
  return gate.applicability === 'optional' || gate.applicability === 'not_applicable' || gate.id === 'docs_impact' || gate.id === 'independent_review';
}

const HOST_OBSERVED_GATE_IDS = new Set(['diff', 'focused_validation', 'integration', 'restart_persistence', 'architecture', 'cross_platform', 'exact_sha_ci', 'package', 'source_identity', 'deployment']);

export function requiresHostObservedEngineeringEvidence(gateId: string): boolean {
  return HOST_OBSERVED_GATE_IDS.has(gateId);
}

/**
 * Minimal Engineering Harness projection stored on the existing durable goal.
 * Goal plan, acceptance criteria, evidence, checkpoints, leases, and intent
 * revision remain authoritative in their existing fields.
 */
export type EngineeringReviewFindingSeverity = 'blocking' | 'non_blocking';
export type EngineeringReviewFindingState = 'open' | 'validated' | 'rejected' | 'resolved';

export interface EngineeringReviewFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: EngineeringReviewFindingSeverity;
  readonly state: EngineeringReviewFindingState;
  readonly reason: string;
  readonly source?: string;
}

export interface EngineeringGoalMetadata {
  readonly schemaVersion: 1 | 2;
  readonly primaryTaskKind: EngineeringTaskKind;
  readonly riskTier: EngineeringRiskTier;
  readonly policyDigest: string;
  readonly deliveryScope: EngineeringDeliveryScope;
  readonly scopedPath?: string;
  readonly gates: readonly EngineeringGateDefinition[];
  readonly reviewFindings?: readonly EngineeringReviewFinding[];
  readonly contract?: EngineeringDeliveryContract;
}

export type EngineeringFact<T> =
  | { readonly state: 'present'; readonly value: T }
  | { readonly state: 'absent' | 'unreadable' | 'unsupported' | 'unknown'; readonly reasonCode: string };

export type EngineeringArtifactRole = 'worker_bundle' | 'static_manifest' | 'container_digest' | 'library_archive' | 'desktop_installer' | 'none';

export interface EngineeringCapabilityFacts {
  readonly git: EngineeringFact<{ readonly head: string }>;
  readonly remote: EngineeringFact<{ readonly provider: 'github' | 'other' }>;
  readonly ci: EngineeringFact<{ readonly provider: 'github' | 'other' }>;
  readonly artifact: EngineeringFact<EngineeringArtifactRole>;
  readonly deployment: EngineeringFact<'cloudflare_worker' | 'other'>;
  readonly source: EngineeringFact<{ readonly digest: string; readonly fileCount: number }>;
  readonly digest: string;
  readonly workerTarget?: EngineeringWorkerTarget;
}

export interface EngineeringWorkerTarget {
  readonly accountId: string;
  readonly worker: string;
  readonly environment: string;
  readonly trafficPercent: number;
}

export interface EngineeringGateDecision {
  readonly authority: 'host_policy';
  readonly reasonCode: string;
  readonly policyDigest: string;
  readonly capabilityDigest: string;
  readonly contractDigest: string;
}

export interface EngineeringDeliveryContract {
  readonly schemaVersion: 2;
  readonly digest: string;
  readonly facts: EngineeringCapabilityFacts;
  readonly hostedCi: 'required' | 'local_only';
  readonly artifactRole: EngineeringArtifactRole | 'unresolved';
  readonly sourceDigest?: string;
  readonly workerTarget?: EngineeringWorkerTarget;
}
