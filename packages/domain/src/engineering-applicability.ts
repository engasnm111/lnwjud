import type { EngineeringCapabilityFacts, EngineeringDeliveryContract, EngineeringDeliveryScope, EngineeringGateDefinition } from './engineering.js';

export interface EngineeringApplicabilityInput {
  readonly deliveryScope: EngineeringDeliveryScope;
  readonly facts: EngineeringCapabilityFacts;
  readonly contract: EngineeringDeliveryContract;
  readonly policyDigest: string;
  readonly allowNoGit: boolean;
}
type Decision = Pick<EngineeringGateDefinition, 'applicability' | 'reason'> & { readonly reasonCode: string };
interface GateRule { readonly id: string; readonly title: string; readonly decide: (input: EngineeringApplicabilityInput) => Decision | undefined }
const delivery = (input: EngineeringApplicabilityInput): boolean => input.deliveryScope === 'release' || input.deliveryScope === 'deploy';

const RULES: readonly GateRule[] = [
  { id: 'exact_sha_ci', title: 'Exact-source hosted checks', decide: (input): Decision | undefined => {
    if (!delivery(input)) return undefined;
    if (input.contract.hostedCi === 'required') return { applicability: 'required', reasonCode: 'TRUSTED_CI_REQUIRED', reason: 'Trusted user policy requires terminal hosted checks for this source. Missing credentials or configuration cannot waive this requirement.' };
    if (input.facts.ci.state === 'absent') return { applicability: 'not_applicable', reasonCode: 'TRUSTED_LOCAL_WORKFLOW', reason: 'Trusted user policy selects local validation and the host observed no hosted CI configuration.' };
    return { applicability: input.facts.ci.state === 'present' && input.facts.ci.value.provider === 'github' ? 'required' : 'unresolved', reasonCode: 'CI_NOT_PROVEN_ABSENT', reason: 'Hosted CI is present or its absence could not be established; verify the configured provider.' };
  } },
  { id: 'focused_validation', title: 'Local behavioral validation', decide: (input) => delivery(input) && input.contract.hostedCi === 'local_only' && input.facts.ci.state === 'absent'
    ? { applicability: 'required', reasonCode: 'LOCAL_VALIDATION_REQUIRED', reason: 'The explicit local workflow requires successful host-observed validation for the delivered source.' } : undefined },
  { id: 'package', title: 'Delivered artifact verification', decide: (input): Decision => {
    if (!delivery(input)) return { applicability: 'not_applicable', reasonCode: 'LOCAL_NO_DELIVERY', reason: 'Current intent requests local work without artifact delivery. Source and validation obligations remain.' };
    if (input.contract.artifactRole === 'unresolved') return { applicability: 'unresolved', reasonCode: 'DELIVERY_ARTIFACT', reason: 'Resolve which artifact role this delivery produces before verification.' };
    if (input.contract.artifactRole === 'none') return { applicability: 'not_applicable', reasonCode: 'NO_ARTIFACT_EXPECTED', reason: 'The trusted delivery contract declares no package artifact; source identity and applicable deployment evidence remain required.' };
    return { applicability: 'required', reasonCode: 'DELIVERY_ARTIFACT', reason: `Verify the delivered ${input.contract.artifactRole} against its source and content digest.` };
  } },
  { id: 'deployment', title: 'Deployment readback', decide: (input) => input.deliveryScope === 'deploy'
    ? { applicability: input.facts.deployment.state === 'present' && input.facts.deployment.value === 'cloudflare_worker' && input.contract.workerTarget !== undefined ? 'required' : 'unresolved', reasonCode: 'PROVIDER_READBACK_REQUIRED', reason: 'Verify the deployed version, account, Worker, environment and approved traffic target through a supported host adapter.' } : undefined },
  { id: 'source_identity', title: 'Source content identity', decide: (input): Decision => {
    const allowed = input.facts.source.state === 'present' && (input.facts.git.state === 'present' || (input.facts.git.state === 'absent' && input.allowNoGit));
    return allowed ? { applicability: 'required', reasonCode: 'SOURCE_CONTENT_MANIFEST', reason: 'Bind evidence to the bounded source content manifest, including dirty and untracked repository inputs.' }
      : { applicability: 'unresolved', reasonCode: 'SOURCE_IDENTITY_UNRESOLVED', reason: 'Obtain a stable readable source manifest. No-Git source requires explicit trusted user policy.' };
  } },
];

export function evaluateEngineeringApplicability(input: EngineeringApplicabilityInput): readonly EngineeringGateDefinition[] {
  return RULES.flatMap((rule) => {
    const result = rule.decide(input);
    if (result === undefined) return [];
    return [{ id: rule.id, title: rule.title, applicability: result.applicability, status: result.applicability === 'not_applicable' ? 'not_applicable' as const : 'pending' as const,
      reason: result.reason, basedOnUserIntentRevision: 0,
      decision: { authority: 'host_policy' as const, reasonCode: result.reasonCode, policyDigest: input.policyDigest, capabilityDigest: input.facts.digest, contractDigest: input.contract.digest } }];
  });
}
