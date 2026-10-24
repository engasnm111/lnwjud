import { engineeringGoalMetadata, type EngineeringWorkflowPlan } from './engineering-workflow.js';
import type { EngineeringGoalMetadata, GoalCheckpointResumeContext, GoalEvidence } from '@lnwjud/domain';
const MAX_ENGINEERING_RESUME_CONTEXT_LENGTH = 64_000;
const ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM = 1_024;
const SCOPE_DEPENDENT_ENGINEERING_GATES = new Set(['diff', 'coverage', 'focused_validation', 'architecture', 'integration', 'restart_persistence', 'security_review', 'self_review', 'independent_review', 'docs_impact']);
export function reconcileEngineeringMetadata(
  current: EngineeringGoalMetadata,
  policyDigest: string,
  workflow: EngineeringWorkflowPlan,
  userIntentRevision: number,
  scopedPath?: string,
): EngineeringGoalMetadata {
  const next = engineeringGoalMetadata(policyDigest, workflow, scopedPath);
  const previousGates = new Map(current.gates.map((gate) => [gate.id, gate] as const));
  return {
    ...next,
    gates: next.gates.map((gate) => {
      if (gate.applicability === 'not_applicable') return { ...gate, basedOnUserIntentRevision: userIntentRevision };
      const previous = previousGates.get(gate.id);
      if (previous === undefined) return { ...gate, status: 'pending', basedOnUserIntentRevision: userIntentRevision };
      if (current.scopedPath !== scopedPath && SCOPE_DEPENDENT_ENGINEERING_GATES.has(gate.id)) {
        return {
          ...gate,
          status: 'stale',
          reason: `Engineering task scope changed; revalidate. ${gate.reason}`,
          basedOnUserIntentRevision: userIntentRevision,
        };
      }
      if (current.contract?.digest === next.contract?.digest && sameEngineeringGateContract(previous, gate)) return { ...previous, basedOnUserIntentRevision: userIntentRevision };
      return {
        ...gate,
        status: 'stale',
        reason: `Engineering gate contract changed; revalidate. ${gate.reason}`,
        basedOnUserIntentRevision: userIntentRevision,
      };
    }),
    ...(current.reviewFindings === undefined ? {} : { reviewFindings: current.reviewFindings }),
  };
}

export function sameEngineeringGateContract(current: EngineeringGoalMetadata['gates'][number], next: EngineeringGoalMetadata['gates'][number]): boolean {
  const currentPlatforms = [...new Set(current.requiredPlatforms ?? [])].sort();
  const nextPlatforms = [...new Set(next.requiredPlatforms ?? [])].sort();
  return current.title === next.title
    && current.applicability === next.applicability
    && current.checkCommand === next.checkCommand
    && current.decision?.contractDigest === next.decision?.contractDigest
    && currentPlatforms.length === nextPlatforms.length
    && currentPlatforms.every((platform, index) => platform === nextPlatforms[index]);
}

export function engineeringMetadataCheckpointDetails(
  previous: EngineeringGoalMetadata,
  next: EngineeringGoalMetadata,
  previousContext: GoalCheckpointResumeContext | undefined,
): { readonly evidence: readonly GoalEvidence[]; readonly resumeContext: GoalCheckpointResumeContext } {
  const previousGates = new Map(previous.gates.map((gate) => [gate.id, gate] as const));
  const nextGates = new Map(next.gates.map((gate) => [gate.id, gate] as const));
  const addedGateIds = next.gates.filter((gate) => !previousGates.has(gate.id)).map((gate) => gate.id);
  const removedGateIds = previous.gates.filter((gate) => !nextGates.has(gate.id)).map((gate) => gate.id);
  const changedGateIds = next.gates.filter((gate) => {
    const oldGate = previousGates.get(gate.id);
    return oldGate !== undefined && !sameEngineeringGateContract(oldGate, gate);
  }).map((gate) => gate.id);
  const staleGateIds = next.gates.filter((gate) => gate.status === 'stale').map((gate) => gate.id);
  const pendingGateIds = next.gates.filter((gate) => gate.applicability === 'required' && gate.status !== 'passed').map((gate) => gate.id);
  const previousClassification = engineeringClassification(previous);
  const nextClassification = engineeringClassification(next);
  const classificationDecision = previousClassification === nextClassification
    ? `Engineering classification remains ${previousClassification}.`
    : `Engineering classification changed from ${previousClassification} to ${nextClassification}.`;
  const gateDiff = `Gate contract diff: added [${formatGateIds(addedGateIds)}], changed [${formatGateIds(changedGateIds)}], removed [${formatGateIds(removedGateIds)}], stale [${formatGateIds(staleGateIds)}].`;
  const scopeFact = previous.scopedPath === next.scopedPath
    ? undefined
    : `Scoped path changed from ${previous.scopedPath?.slice(0, 256) ?? '(none)'} to ${next.scopedPath?.slice(0, 256) ?? '(none)'}.`;
  const stateFactAdditions: readonly GoalEvidence[] = [
    { kind: 'note', value: `Previous Engineering classification: ${previousClassification}.` },
    { kind: 'note', value: `Reconciled Engineering classification: ${nextClassification}.` },
    { kind: 'note', value: gateDiff },
    ...(scopeFact === undefined ? [] : [{ kind: 'note' as const, value: scopeFact }]),
  ];
  const evidenceValue = [classificationDecision, gateDiff, ...(scopeFact === undefined ? [] : [scopeFact])].join(' ');
  const previousEngineeringGateIds = new Set(previous.gates.map((gate) => gate.id));
  const preservedPendingValidation = (previousContext?.pendingValidation ?? []).filter((validation) => {
    const match = /^Engineering gate ([^ ]+) remains .+ and must be verified before completion\.$/.exec(validation);
    return match === null || !previousEngineeringGateIds.has(match[1]!);
  });
  const pendingValidation = pendingGateIds.map((gateId) => `Engineering gate ${gateId} remains ${nextGates.get(gateId)?.status ?? 'pending'} and must be verified before completion.`);

  const previousResumeContext: GoalCheckpointResumeContext = {
    changedFiles: previousContext?.changedFiles ?? [],
    commands: previousContext?.commands ?? [],
    decisions: previousContext?.decisions ?? [],
    failedAttempts: previousContext?.failedAttempts ?? [],
    pendingValidation: preservedPendingValidation,
    resumePrerequisites: previousContext?.resumePrerequisites ?? [],
    stateFacts: previousContext?.stateFacts ?? [],
    artifacts: previousContext?.artifacts ?? [],
  };
  let resumeContext = appendCheckpointStringsWithinLimit(previousResumeContext, 'decisions', [classificationDecision, gateDiff]);
  resumeContext = appendCheckpointStringsWithinLimit(resumeContext, 'pendingValidation', pendingValidation);
  resumeContext = appendCheckpointEvidenceWithinLimit(resumeContext, stateFactAdditions);

  return {
    evidence: [{ kind: 'note', value: evidenceValue }],
    resumeContext,
  };
}

function engineeringClassification(metadata: EngineeringGoalMetadata): string {
  return `${metadata.primaryTaskKind} / ${metadata.riskTier} / ${metadata.deliveryScope}`;
}

function formatGateIds(ids: readonly string[]): string {
  if (ids.length === 0) return 'none';
  const shown = ids.slice(0, 6).map((id) => id.slice(0, 64));
  return `${shown.join(', ')}${ids.length > shown.length ? `, +${ids.length - shown.length} more` : ''}`;
}

function appendCheckpointStringsWithinLimit(
  resumeContext: GoalCheckpointResumeContext,
  field: 'decisions' | 'pendingValidation',
  additions: readonly string[],
): GoalCheckpointResumeContext {
  let result = resumeContext;
  for (const addition of additions) {
    const existing = result[field];
    if (existing.includes(addition) || existing.length >= 100 || addition.length > 1_024) continue;
    const candidate: GoalCheckpointResumeContext = { ...result, [field]: [...existing, addition] };
    if (JSON.stringify(candidate).length > MAX_ENGINEERING_RESUME_CONTEXT_LENGTH - ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM) continue;
    result = candidate;
  }
  return result;
}

function appendCheckpointEvidenceWithinLimit(
  resumeContext: GoalCheckpointResumeContext,
  additions: readonly GoalEvidence[],
): GoalCheckpointResumeContext {
  let result = resumeContext;
  for (const addition of additions) {
    if (result.stateFacts.length >= 100 || addition.value.length > 1_024
      || result.stateFacts.some((entry) => entry.kind === addition.kind && entry.value === addition.value)) continue;
    const candidate: GoalCheckpointResumeContext = { ...result, stateFacts: [...result.stateFacts, addition] };
    if (JSON.stringify(candidate).length > MAX_ENGINEERING_RESUME_CONTEXT_LENGTH - ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM) continue;
    result = candidate;
  }
  return result;
}

export function sameEngineeringMetadataContract(current: EngineeringGoalMetadata, next: EngineeringGoalMetadata): boolean {
  if (current.contract?.digest !== next.contract?.digest || current.schemaVersion !== next.schemaVersion
    || current.primaryTaskKind !== next.primaryTaskKind
    || current.riskTier !== next.riskTier
    || current.deliveryScope !== next.deliveryScope
    || current.scopedPath !== next.scopedPath
    || current.gates.length !== next.gates.length) return false;
  const currentGates = new Map(current.gates.map((gate) => [gate.id, gate] as const));
  return next.gates.every((gate) => {
    const previous = currentGates.get(gate.id);
    return previous !== undefined && sameEngineeringGateContract(previous, gate);
  });
}
