import { mayMarkEngineeringGateNotApplicable, requiresHostObservedEngineeringEvidence, type EngineeringGoalMetadata } from './engineering.js';

export interface GoalReadinessInput {
  readonly plan: { readonly steps: readonly { readonly id: string; readonly status?: string }[] };
  readonly acceptanceCriteria: readonly { readonly id: string; readonly status: string }[];
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly { readonly taskId: string; readonly role: string; readonly provider?: string; readonly cancelWithGoal?: boolean }[];
  readonly engineering?: EngineeringGoalMetadata;
}

export interface GoalReadiness {
  readonly ready: boolean;
  readonly incompleteStepIds: readonly string[];
  readonly incompleteAcceptanceIds: readonly string[];
  readonly unresolvedGateIds: readonly string[];
  readonly blockingFindingIds: readonly string[];
  readonly blockingTaskIds: readonly string[];
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
}

export function evaluateGoalReadiness(goal: GoalReadinessInput): GoalReadiness {
  const incompleteStepIds = goal.plan.steps.filter((step) => step.status !== 'completed').map((step) => step.id);
  const incompleteAcceptanceIds = goal.acceptanceCriteria.filter((entry) => entry.status !== 'completed').map((entry) => entry.id);
  const unresolvedGateIds = (goal.engineering?.gates ?? []).filter((gate) => {
    if (gate.applicability === 'unresolved') return true;
    const contract = goal.engineering?.contract;
    if (contract !== undefined && (gate.decision?.contractDigest !== contract.digest || gate.decision.capabilityDigest !== contract.facts.digest || gate.decision.policyDigest !== goal.engineering?.policyDigest)) return true;
    if (contract !== undefined && gate.status === 'passed' && (gate.evidence?.contractDigest !== contract.digest || gate.evidence.sourceDigest !== contract.sourceDigest)) return true;
    if (gate.status === 'passed') return gate.evidence === undefined || (requiresHostObservedEngineeringEvidence(gate.id) && gate.evidence.source !== 'host_observed');
    if (gate.status === 'not_applicable') return gate.reason.trim().length === 0 || !mayMarkEngineeringGateNotApplicable(gate);
    return gate.applicability === 'required';
  }).map((gate) => gate.id);
  const blockingFindingIds = (goal.engineering?.reviewFindings ?? []).filter((finding) =>
    (finding.severity === 'blocking' && (finding.state === 'open' || finding.state === 'validated'))
    || (finding.state === 'rejected' && finding.reason.trim().length === 0)).map((finding) => finding.id);
  const blockingTaskIds = goal.trackedTasks === undefined ? goal.activeTaskIds : goal.trackedTasks.filter((task) => task.role === 'blocking_job').map((task) => task.taskId);
  const reasons: { code: string; message: string }[] = [];
  if (incompleteStepIds.length) reasons.push({ code: 'PLAN_INCOMPLETE', message: `Goal cannot be completed while plan steps remain unfinished: ${incompleteStepIds.join(', ')}` });
  if (incompleteAcceptanceIds.length) reasons.push({ code: 'ACCEPTANCE_INCOMPLETE', message: `Goal cannot be completed while acceptance criteria remain unfinished: ${incompleteAcceptanceIds.join(', ')}` });
  if (unresolvedGateIds.length) reasons.push({ code: 'ENGINEERING_PROOF_REQUIRED', message: `Engineering goal cannot be completed while required gates are unresolved or missing host-observed evidence: ${unresolvedGateIds.join(', ')}` });
  if (blockingFindingIds.length) reasons.push({ code: 'BLOCKING_REVIEW_FINDINGS', message: `Engineering goal cannot be completed while blocking review findings remain unresolved: ${blockingFindingIds.join(', ')}` });
  if (goal.blockers.length) reasons.push({ code: 'DURABLE_BLOCKERS', message: 'Goal cannot be completed while durable blockers remain' });
  if (blockingTaskIds.length) reasons.push({ code: 'BLOCKING_TASKS', message: 'Goal cannot be completed while blocking tasks remain tracked' });
  return { ready: reasons.length === 0, incompleteStepIds, incompleteAcceptanceIds, unresolvedGateIds, blockingFindingIds, blockingTaskIds, reasons };
}
