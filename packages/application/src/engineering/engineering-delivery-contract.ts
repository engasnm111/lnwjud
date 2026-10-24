import { createHash } from 'node:crypto';
import { evaluateEngineeringApplicability, type EngineeringCapabilityFacts, type EngineeringDeliveryContract } from '@lnwjud/domain';
import type { EngineeringHarnessSettings } from '@lnwjud/shared';
import type { EngineeringWorkflowPlan } from './engineering-workflow.js';

/** Applicability is derived only from host observations and trusted user settings. */
export function applyDeliveryContract(plan: EngineeringWorkflowPlan, facts: EngineeringCapabilityFacts, settings: EngineeringHarnessSettings, policyDigest: string): EngineeringWorkflowPlan {
  if (settings.workerTarget !== undefined) {
    const configured = { ...facts, workerTarget: settings.workerTarget };
    facts = { ...configured, digest: createHash('sha256').update(JSON.stringify(configured)).digest('hex') };
  }
  const delivery = plan.deliveryScope === 'release' || plan.deliveryScope === 'deploy';
  const hostedCi = settings.hostedCi ?? 'required';
  const artifactRole: EngineeringDeliveryContract['artifactRole'] = facts.artifact.state === 'present' ? facts.artifact.value : delivery ? 'unresolved' : 'none';
  const payload = { schemaVersion: 2 as const, facts, hostedCi, artifactRole, ...(facts.source.state === 'present' ? { sourceDigest: facts.source.value.digest } : {}), ...(facts.workerTarget === undefined ? {} : { workerTarget: facts.workerTarget }) };
  const digest = createHash('sha256').update(JSON.stringify({ ...payload, policyDigest, scope: plan.deliveryScope, kind: plan.primaryTaskKind })).digest('hex');
  const contract: EngineeringDeliveryContract = { ...payload, digest };
  const gates = new Map(plan.gates.map((gate) => [gate.id, gate]));
  for (const gate of evaluateEngineeringApplicability({ deliveryScope: plan.deliveryScope, facts, contract, policyDigest, allowNoGit: settings.allowNoGit === true })) gates.set(gate.id, gate);
  return { ...plan, gates: [...gates.values()].map((gate) => ({ ...gate, decision: gate.decision ?? { authority: 'host_policy', reasonCode: 'BASELINE_REQUIREMENT', policyDigest, capabilityDigest: facts.digest, contractDigest: digest } })), contract };
}
