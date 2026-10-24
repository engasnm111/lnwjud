import type {
  EngineeringDeliveryScope,
  EngineeringGateDefinition,
  EngineeringGoalMetadata,
  EngineeringRiskTier,
  EngineeringTaskKind,
} from '@lnwjud/domain';
import { projectEngineeringSettings, type EngineeringHarnessSettings, type EngineeringProfile, type ProjectEngineeringSettings } from '@lnwjud/shared';
import type { EngineeringProjectAssessment } from './engineering-project-assessment.js';

export type EngineeringCodeIntelligence = 'codegraph' | 'lsp_search';

export interface EngineeringWorkflowPolicy {
  readonly profile: EngineeringProfile;
  readonly custom?: NonNullable<EngineeringHarnessSettings['custom']>;
}

export interface EngineeringWorkflowStep {
  readonly id: string;
  readonly title: string;
}

export interface EngineeringWorkflowPlan {
  readonly primaryTaskKind: EngineeringTaskKind;
  readonly riskTier: EngineeringRiskTier;
  readonly analysisMode: 'focused' | 'cross_file';
  readonly riskReasons: readonly string[];
  readonly workflow: readonly EngineeringWorkflowStep[];
  readonly gates: readonly EngineeringGateDefinition[];
  readonly selectedCodeIntelligence: EngineeringCodeIntelligence;
  readonly codeIntelligenceReason: string;
  readonly deliveryScope: EngineeringDeliveryScope;
  readonly contract?: import('@lnwjud/domain').EngineeringDeliveryContract;
}

export function planEngineeringWorkflow(
  objective: string,
  assessment: EngineeringProjectAssessment,
  userIntentRevision = 0,
  policy: EngineeringWorkflowPolicy = { profile: 'senior' },
): EngineeringWorkflowPlan {
  const primaryTaskKind = classifyEngineeringTaskKind(objective);
  const { tier: riskTier, reasons: riskReasons } = classifyEngineeringRisk(objective, primaryTaskKind);
  const analysisMode = policy.profile === 'standard'
    ? 'focused'
    : policy.profile === 'custom'
      ? policy.custom?.analysis ?? 'cross_file'
      : 'cross_file';
  const deliveryScope = inferDeliveryScope(objective);
  const workflow = workflowFor(primaryTaskKind, riskTier);
  const gates = gatesFor(primaryTaskKind, riskTier, deliveryScope, objective, userIntentRevision, policy, projectEngineeringSettings(assessment.projectProfile));
  const instructionText = assessment.instructions
    .filter((entry) => entry.status === 'loaded' || entry.status === 'truncated')
    .map((entry) => entry.content ?? '')
    .join('\n');
  const codeGraphRequested = /codegraph/i.test(instructionText) && assessment.codeGraphIndexed === true;
  return {
    primaryTaskKind,
    riskTier,
    analysisMode,
    riskReasons,
    workflow,
    gates,
    selectedCodeIntelligence: codeGraphRequested ? 'codegraph' : 'lsp_search',
    codeIntelligenceReason: codeGraphRequested
      ? 'Applicable project instructions require CodeGraph and this workspace has a .codegraph index; verify the callable tool before use.'
      : 'No indexed CodeGraph-first instruction applies; use available symbol/LSP tools with search fallback.',
    deliveryScope,
  };
}

export function engineeringGoalMetadata(
  policyDigest: string,
  plan: EngineeringWorkflowPlan,
  scopedPath?: string,
): EngineeringGoalMetadata {
  return {
    schemaVersion: plan.contract === undefined ? 1 : 2,
    ...(plan.contract === undefined ? {} : { contract: plan.contract }),
    primaryTaskKind: plan.primaryTaskKind,
    riskTier: plan.riskTier,
    policyDigest,
    deliveryScope: plan.deliveryScope,
    ...(scopedPath === undefined ? {} : { scopedPath }),
    gates: plan.gates,
  };
}

export function classifyEngineeringTaskKind(objective: string): EngineeringTaskKind {
  const value = objective.trim().toLowerCase();
  if (hasDeliveryAction(value, 'release')) return 'release';
  if (/(\bincident\b|\boutage\b|production down|service down|เหตุขัดข้อง|ระบบล่ม)/i.test(value)) return 'incident';
  if (/(\breview\b|code review|\baudit\b|ตรวจ(?:สอบ|โค้ด)|รีวิวโค้ด)/i.test(value) && !hasRequestedCodeMutation(value)) return 'review';
  if (/(\bdocs?\b|readme|typo|copy change|documentation|เอกสาร|คำผิด)/i.test(value)) return 'docs';
  if (/(css[- ]only|style[- ]only|icon[- ]only|spacing[- ]only|harmless rename|ระยะห่าง|ไอคอน)/i.test(value)) return 'maintenance';
  if (/(\brefactor\b|restructure|rename architecture|รีแฟคเตอร์|ปรับโครงสร้าง)/i.test(value)) return 'refactor';
  if (/(\bbug\b|\bfix\b|broken|fails?|error|regression|doesn'?t|cannot|แก้บั๊ก|พัง|เออเรอร์)/i.test(value)) return 'bugfix';
  if (/(\badd\b|\bimplement\b|\bfeature\b|create|support|enable|เพิ่ม|สร้าง|รองรับ)/i.test(value)) return 'feature';
  if (/(dependency|upgrade|maintenance|chore|cleanup|อัปเดต dependency|บำรุงรักษา)/i.test(value)) return 'maintenance';
  return 'unknown';
}

export function classifyEngineeringRisk(
  objective: string,
  taskKind: EngineeringTaskKind = classifyEngineeringTaskKind(objective),
): { readonly tier: EngineeringRiskTier; readonly reasons: readonly string[] } {
  const value = objective.trim().toLowerCase();
  const platformIntent = inferPlatformIntent(value);
  const reasons: string[] = [];
  if (taskKind === 'release' || hasRequestedProductionDeploy(value) || /(\bdata migration\b|\bdestructive\b|\bdrop table\b|\bcredential boundary\b)/i.test(value)) {
    reasons.push('Release, production, destructive data, or credential-boundary work requires recovery/provenance evidence.');
    return { tier: 'critical', reasons };
  }
  if (platformIntent.nativeOrCrossPlatform || /(auth|token|session|permission|security|persist|storage|database|schema|migration|concurr|race|api contract|oauth|สิทธิ์|ฐานข้อมูล|โทเคน|เซสชัน)/i.test(value)) {
    reasons.push('The request touches a high-risk contract, persistence, security, concurrency, native, or cross-platform surface.');
    return { tier: 'high', reasons };
  }
  if (taskKind === 'docs' || /(css[- ]only|copy only|icon only|spacing|typo|คำผิด|ระยะห่าง|ไอคอน)/i.test(value)) {
    reasons.push('The request is documentation, copy, styling, icon, or another low-risk mechanical change.');
    return { tier: 'low', reasons };
  }
  if (taskKind === 'review') {
    reasons.push('Review is read-only unless mutation is separately requested.');
    return { tier: 'low', reasons };
  }
  reasons.push('The request changes local software behavior or structure without a high-risk trigger.');
  return { tier: 'medium', reasons };
}

function hasRequestedProductionDeploy(value: string): boolean {
  return hasAffirmativeMatch(value, /\bdeploy\s+(?:(?:to|into)\s+)?(?:the\s+)?prod(?:uction)?\b/i, 'deploy')
    || hasAffirmativeMatch(value, /\broll\s+out\s+(?:(?:to|into)\s+)?(?:the\s+)?prod(?:uction)?\b/i, 'deploy')
    || hasAffirmativeProductionDeployment(value)
    || hasAffirmativeMatch(value, /ขึ้น\s+(?:prod|production)\b/i, 'deploy');
}

function hasAffirmativeProductionDeployment(value: string): boolean {
  const patterns = [
    /\bproduction\s+(?:deployments?|deploy)\b/i,
    /\bdeployments?\s+(?:to|into)\s+(?:the\s+)?production\b/i,
  ] as const;
  for (const pattern of patterns) {
    for (const match of value.matchAll(globalMatcher(pattern))) {
      const index = match.index ?? 0;
      if (isNegatedAction(value, index)) continue;
      if (isThaiDeploymentReview(value, index)) continue;
      if (hasNegatedProductionDeployment(value.slice(index + match[0].length))) continue;
      const scope = actionScopeBefore(value, index);
      const followingScope = actionScopeAfter(value, index, match[0].length);
      const [deploymentClause = ''] = followingScope.split(';');
      const readOnlyTopic = /\b(?:review|audit|inspect|examine|check|read|document|list|compare|existing|previous|prior|historical|old|current|history|report|summary|overview)\b/i;
      const explicitAction = /\b(?:perform|execute|start|schedule|trigger|initiate|deploy|roll\s+out|publish|ship)\b/i;
      if ((readOnlyTopic.test(scope) || readOnlyTopic.test(deploymentClause))
        && !explicitAction.test(scope)) continue;
      return true;
    }
  }
  return false;
}

export function inferDeliveryScope(objective: string): EngineeringDeliveryScope {
  const value = objective.trim().toLowerCase();
  if (hasRequestedProductionDeploy(value)) return 'deploy';
  if (hasDeliveryAction(value, 'deploy')) return 'deploy';
  if (hasDeliveryAction(value, 'release')) return 'release';
  if (hasDeliveryAction(value, 'merge')) return 'merge';
  if (hasDeliveryAction(value, 'pull_request')) return 'pull_request';
  if (hasDeliveryAction(value, 'push')) return 'push';
  if (hasDeliveryAction(value, 'commit')) return 'commit';
  return 'local';
}

type DeliveryAction = 'deploy' | 'release' | 'merge' | 'pull_request' | 'push' | 'commit';

const DELIVERY_ACTION_PATTERNS: Readonly<Record<DeliveryAction, readonly RegExp[]>> = {
  deploy: [/\bdeploy\b|\broll\s+out\b|ขึ้น\s+(?:prod|production)\b/i],
  release: [
    /\brelease\b/i,
    /\bpublish\s+(?:(?:a|the|new)\s+)?(?:release|version|build|artifact|v?\d+(?:\.\d+)*)\b/i,
    /\btag\s+(?:(?:a|the|new)\s+)?(?:release|version|v?\d+(?:\.\d+)*)\b/i,
    /\bship\s+(?:(?:the|a)\s+)?(?:app|build|release|version)\b/i,
    /(?:ปล่อย|เผยแพร่)\s*(?:เวอร์ชัน|รุ่น)/i,
    /\b(?:release|รีลีส)\s*(?:version|เวอร์ชัน|รุ่น|v?\d+(?:\.\d+)*)/i,
  ],
  merge: [/\bmerge\b|รวม\s+pr/i],
  pull_request: [/\bpull request\b|\bpr\b/i],
  push: [/\bpush\b|ส่งขึ้น\s+git/i],
  commit: [/\bcommit\b|คอมมิต/i],
};

const CODE_MUTATION_PATTERNS = [
  /\b(?:fix|repair|patch|implement|add|edit|modify|remove|delete|refactor|restructure|rewrite)\b/i,
  /(?:แก้(?:ไข)?|เพิ่ม|ปรับปรุง|เปลี่ยน|ลบ|สร้าง)/i,
] as const;

function hasRequestedCodeMutation(value: string): boolean {
  return CODE_MUTATION_PATTERNS.some((pattern) => hasAffirmativeMatch(value, pattern));
}

function hasDeliveryAction(value: string, action: DeliveryAction): boolean {
  return DELIVERY_ACTION_PATTERNS[action].some((pattern) => {
    const globalPattern = globalMatcher(pattern);
    for (const match of value.matchAll(globalPattern)) {
      const index = match.index ?? 0;
      if (action === 'release' && !isReleaseVerbUse(value, index, match[0])) continue;
      const followingScope = value.slice(index + match[0].length);
      if (action === 'deploy') {
        if (isThaiDeploymentReview(value, index)) continue;
        const targets = getDeploymentTargets(followingScope) ?? [];
        if ((targets.length === 0 ? ['production'] : targets)
          .every((target) => hasNegatedDeploymentForTarget(followingScope, target))) continue;
      }
      if (!isNegatedAction(value, index)) return true;
    }
    return false;
  });
}

function hasAffirmativeMatch(value: string, pattern: RegExp, action?: DeliveryAction): boolean {
  const globalPattern = globalMatcher(pattern);
  for (const match of value.matchAll(globalPattern)) {
    if (action === 'deploy' && isThaiDeploymentReview(value, match.index ?? 0)) continue;
    if (action === 'deploy' && hasNegatedProductionDeployment(value.slice((match.index ?? 0) + match[0].length))) continue;
    if (!isNegatedAction(value, match.index ?? 0)) return true;
  }
  return false;
}

function globalMatcher(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.global ? pattern.flags : `${pattern.flags}g`);
}

function isReleaseVerbUse(value: string, index: number, matchedText: string): boolean {
  if (/^(?:ปล่อย|เผยแพร่|รีลีส|publish|tag|ship)\b/i.test(matchedText)) return true;
  const before = value.slice(Math.max(0, index - 80), index);
  const after = value.slice(index + matchedText.length);
  const actionScope = actionScopeBefore(value, index);
  const explicitDeliveryBefore = /\b(?:prepare|create|build|generate|publish|tag|ship|cut)\b/i.test(actionScope);
  if (/\b(?:review|audit|inspect|examine|check|summari[sz]e|historical|previous|prior|past|last|old|existing|current|yesterday)\b/i.test(actionScope)
    && !explicitDeliveryBefore) return false;
  if (/(?:\b(?:the|a|an|of|from|about|historical|previous|prior|past|last|old|existing|yesterday)\s*|\b(?:last|previous|prior|past)\s+\w+(?:['’]s)?\s*|\b(?:yesterday|today|tomorrow)(?:['’]s)?\s*)$/i.test(before)) return false;
  if (/^\s+(?:from|of|for|notes?|pipeline|process|workflow|history|yesterday|last|branch|candidate)\b/i.test(after)) return false;
  return true;
}

function actionScopeBefore(value: string, index: number): string {
  const before = value.slice(0, index);
  let sentencePeriod = -1;
  for (const match of before.matchAll(/(?<!\d)\.(?!\d)/g)) sentencePeriod = match.index ?? sentencePeriod;
  const boundary = Math.max(
    before.lastIndexOf(';'),
    before.lastIndexOf('\n'),
    before.lastIndexOf('\r'),
    sentencePeriod,
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
  );
  let scope = before.slice(boundary + 1);
  const contrast = /\b(?:but|however|then|instead|except)\b|(?:แต่|แล้ว|จากนั้น)/gi;
  let lastContrast = -1;
  for (const match of scope.matchAll(contrast)) lastContrast = (match.index ?? 0) + match[0].length;
  if (lastContrast >= 0) scope = scope.slice(lastContrast);
  return scope;
}

function actionScopeAfter(value: string, index: number, matchedLength: number): string {
  const after = value.slice(index + matchedLength);
  let boundary = after.length;
  for (const delimiter of ['!', '?']) {
    const position = after.indexOf(delimiter);
    if (position >= 0 && position < boundary) boundary = position;
  }
  for (const match of after.matchAll(/(?<!\d)\.(?!\d)/g)) {
    const period = match.index ?? after.length;
    if (period < boundary) boundary = period;
  }
  return after.slice(0, boundary);
}

function hasNegatedProductionDeployment(scope: string): boolean {
  return hasNegatedDeploymentForTarget(scope, 'production');
}

function hasNegatedDeploymentForTarget(scope: string, target: string): boolean {
  const denials = /\b(?:do\s+not|don't|dont|never|without|not|no)\s+(?:deploy|roll\s+out)\b|(?:ไม่ต้อง|ห้าม|อย่า|ไม่)\s*(?:deploy|roll\s+out|ขึ้น)\b/gi;
  for (const denial of scope.matchAll(denials)) {
    const deniedTarget = scope.slice((denial.index ?? 0) + denial[0].length);
    const deniedTargets = getDeploymentTargets(deniedTarget);
    if (deniedTargets === undefined) continue;
    if (deniedTargets.length > 0 && !deniedTargets.includes(target)) continue;
    return true;
  }
  return false;
}

function getDeploymentTargets(scope: string): readonly string[] | undefined {
  const environment = '(prod(?:uction)?|staging|stage|dev|development|test|testing|qa|preview)';
  const firstTarget = new RegExp(`^\\s+(?:(?:to|into)\\s+)?(?:both\\s+)?(?:the\\s+)?${environment}\\b`, 'i').exec(scope);
  if (firstTarget === null) return [];

  const targets = [firstTarget[1]!.toLowerCase()];
  let remaining = scope.slice(firstTarget[0].length);
  const targetEnd = /^(?:\s*$|\s*(?:[,;.!?:]|and\/or\b|and\b|or\b|&)|\s+(?:after|before|once|when|if|during|with|for|on)\b)/i;
  const ambiguousTargetEnd = /^(?:\s*$|\s*(?:[,;.!?:]|and\/or\b|and\b|or\b|&))/i;
  if (/^(?:stage|test|testing)$/.test(targets[0]!) && !ambiguousTargetEnd.test(remaining)) return undefined;
  const nextTarget = new RegExp(`^\\s*(?:,|and/or|and|or|&)\\s*(?:the\\s+)?${environment}\\b`, 'i');
  while (true) {
    const match = nextTarget.exec(remaining);
    if (match === null) break;
    const nextRemainder = remaining.slice(match[0].length);
    const targetName = match[1]!.toLowerCase();
    const ambiguousTarget = targetName === 'stage' || targetName === 'test' || targetName === 'testing';
    if (!(ambiguousTarget ? ambiguousTargetEnd : targetEnd).test(nextRemainder)) break;
    targets.push(targetName);
    remaining = nextRemainder;
  }
  return targets.map((target) => {
    if (target === 'prod') return 'production';
    if (target === 'stage') return 'staging';
    if (target === 'dev') return 'development';
    if (target === 'testing') return 'test';
    return target;
  });
}

function isThaiDeploymentReview(value: string, index: number): boolean {
  return /(?:ตรวจสอบ|ตรวจโค้ด|รีวิว)(?:การ)?\s*$/i.test(actionScopeBefore(value, index));
}

function isNegatedAction(value: string, index: number): boolean {
  const scope = actionScopeBefore(value, index);
  return /\b(?:do\s+not|don't|dont|never|without|no|not)\b|(?:ยัง)?ไม่ต้อง|ไม่|ห้าม|อย่า/i.test(scope);
}

function workflowFor(taskKind: EngineeringTaskKind, riskTier: EngineeringRiskTier): readonly EngineeringWorkflowStep[] {
  if (taskKind === 'docs' || (taskKind === 'maintenance' && riskTier === 'low')) {
    return [
      { id: 'inspect', title: 'Inspect target and nearby conventions' },
      { id: 'implement', title: 'Apply the bounded edit' },
      { id: 'validate', title: 'Check the resulting diff and applicable formatting or links' },
    ];
  }
  if (taskKind === 'review') {
    return [
      { id: 'scope', title: 'Resolve exact review scope and base' },
      { id: 'analyze', title: 'Inspect affected paths, callers, and contracts' },
      { id: 'report', title: 'Report source-backed findings without mutation' },
    ];
  }
  if (taskKind === 'bugfix') {
    return [
      { id: 'reproduce', title: 'Reproduce the failure or record why reproduction is unavailable' },
      { id: 'trace', title: 'Trace root cause and affected references' },
      { id: 'plan', title: 'Plan the smallest justified repair and regression evidence' },
      { id: 'implement', title: 'Implement the repair' },
      { id: 'validate', title: 'Run focused regression and affected diagnostics' },
      { id: 'review', title: 'Review compatibility, side effects, and documentation impact' },
    ];
  }
  if (taskKind === 'refactor') {
    return [
      { id: 'invariants', title: 'Capture current behavior, invariants, callers, and compatibility constraints' },
      { id: 'plan', title: 'Plan the migration or structural change' },
      { id: 'implement', title: 'Perform the refactor with reference-aware tooling where available' },
      { id: 'validate', title: 'Verify existing behavior and configured architecture checks' },
      { id: 'review', title: 'Review dependency and compatibility impact' },
    ];
  }
  if (taskKind === 'incident') {
    return [
      { id: 'observe', title: 'Capture observed failure, timeline, and scope' },
      { id: 'contain', title: 'Contain risk without hiding the root cause' },
      { id: 'diagnose', title: 'Establish root cause from evidence' },
      { id: 'repair', title: 'Apply and validate recovery' },
      { id: 'followup', title: 'Record regression and follow-up evidence' },
    ];
  }
  if (taskKind === 'release') {
    return [
      { id: 'source', title: 'Resolve exact source SHA and authorized delivery boundary' },
      { id: 'verify', title: 'Run required local and hosted release gates' },
      { id: 'artifacts', title: 'Verify exact-run artifacts, signatures, and provenance where applicable' },
      { id: 'deliver', title: 'Perform only the explicitly authorized delivery actions' },
    ];
  }
  return [
    { id: 'requirements', title: 'Resolve requirement and affected contracts' },
    { id: 'architecture', title: 'Inspect current architecture and affected references' },
    { id: 'risk', title: 'Confirm impact, risk, and validation plan' },
    { id: 'implement', title: 'Implement within the requested scope' },
    { id: 'validate', title: 'Run proportionate focused and integration validation' },
    { id: 'review', title: 'Review compatibility, tests, and documentation impact' },
  ];
}

function gatesFor(
  taskKind: EngineeringTaskKind,
  riskTier: EngineeringRiskTier,
  deliveryScope: EngineeringDeliveryScope,
  objective: string,
  userIntentRevision: number,
  policy: EngineeringWorkflowPolicy,
  project: ProjectEngineeringSettings,
): readonly EngineeringGateDefinition[] {
  const gates: EngineeringGateDefinition[] = [];
  const custom = policy.profile === 'custom' ? policy.custom : undefined;
  const strictValidation = policy.profile === 'strict' || custom?.validation === 'strict';
  const alwaysReview = policy.profile === 'strict' || custom?.review === 'always';
  const seniorReview = policy.profile === 'senior';
  const docsImpactCheck = custom?.docsImpactCheck ?? true;
  const add = (
    id: string,
    title: string,
    reason: string,
    applicability: EngineeringGateDefinition['applicability'] = 'required',
    checkCommand?: string,
    requiredPlatforms?: EngineeringGateDefinition['requiredPlatforms'],
  ): void => {
    gates.push({
      id,
      title,
      applicability,
      status: applicability === 'not_applicable' ? 'not_applicable' : 'pending',
      reason,
      basedOnUserIntentRevision: userIntentRevision,
      ...(checkCommand === undefined ? {} : { checkCommand }),
      ...(requiredPlatforms === undefined || requiredPlatforms.length === 0 ? {} : { requiredPlatforms }),
    });
  };

  add('diff', 'Diff/static inspection', 'Every mutation must be checked against the requested scope.');
  const changesBehavior = taskKind === 'feature' || taskKind === 'bugfix' || taskKind === 'refactor' || taskKind === 'incident';
  if (changesBehavior) add('coverage', 'Existing coverage inspection', 'Behavioral work must inspect existing relevant tests before adding a regression.');
  if (changesBehavior && riskTier !== 'low') add('focused_validation', 'Focused behavioral validation', 'Run the lowest meaningful test or diagnostic layer for the changed behavior.');
  if (changesBehavior && project.architecture !== undefined) {
    add('architecture', 'Project architecture check', 'Run the declared project architecture check and record the checked scope and rule coverage.', 'required', project.architecture.checkCommand);
  }
  if (riskTier === 'high' || riskTier === 'critical' || (strictValidation && changesBehavior && riskTier === 'medium')) {
    add('integration', 'Integration or contract validation', strictValidation && riskTier === 'medium'
      ? 'Strict validation requires proof across the affected contract boundary for behavioral work.'
      : 'High-risk work requires proof across the affected contract boundary.');
  }
  if (/(persist|storage|session|token|database|restart|ฐานข้อมูล|โทเคน|เซสชัน)/i.test(objective)) add('restart_persistence', 'Restart/persistence evidence', 'Persistence work must prove behavior across restart or reload.');
  if (/(auth|token|permission|security|credential|oauth|สิทธิ์|โทเคน)/i.test(objective)) add('security_review', 'Security boundary review', 'Security-sensitive changes require explicit boundary review.');
  const platformIntent = inferPlatformIntent(objective);
  if (platformIntent.requiredPlatforms.length > 0 || (changesBehavior && project.requiredPlatforms.length > 0)) {
    const requiredPlatforms = project.requiredPlatforms.length > 0 ? project.requiredPlatforms : platformIntent.requiredPlatforms;
    add('cross_platform', 'Cross-platform evidence', project.requiredPlatforms.length > 0
      ? `Project profile requires target-host or CI evidence for: ${project.requiredPlatforms.join(', ')}.`
      : 'Cross-platform claims require target-host or CI evidence.', 'required', undefined, requiredPlatforms);
  }
  if (changesBehavior && (alwaysReview || (seniorReview && riskTier !== 'low'))) {
    add('self_review', 'Implementation review', 'Review the final diff for compatibility, side effects, missing tests, and documentation impact.');
  }
  if (riskTier === 'high' || riskTier === 'critical' || (alwaysReview && changesBehavior && riskTier === 'medium')) {
    add('independent_review', 'Independent review', 'Risk/profile policy requires an independent review when an authorized reviewer is available.');
  }
  if (docsImpactCheck) add('docs_impact', 'Documentation impact', 'Record whether user/configuration/API/release documentation changed or why no update is required.');
  else add('docs_impact', 'Documentation impact', 'Custom preset disabled the optional documentation-impact check.', 'not_applicable');
  if (deliveryScope === 'release' || deliveryScope === 'deploy' || taskKind === 'release') {
    add('exact_sha_ci', 'Exact-SHA hosted checks', 'Release delivery requires terminal hosted checks for the exact source SHA.');
    add('package', 'Artifact/package verification', 'Release delivery requires package/artifact evidence where the project process requires it.');
  }
  return gates;
}

interface EngineeringPlatformIntent {
  readonly nativeOrCrossPlatform: boolean;
  readonly requiredPlatforms: ProjectEngineeringSettings['requiredPlatforms'];
}

function inferPlatformIntent(objective: string): EngineeringPlatformIntent {
  const componentObjective = objective.replace(/\b(?:windows|mac[ \t]*os|linux)(?:[ \t]*\/[ \t]*(?:windows|mac[ \t]*os|linux))+\b/gi, 'os');
  let nativeComponent = false;
  for (const native of componentObjective.matchAll(/\bnative\b/gi)) {
    let remaining = componentObjective.slice((native.index ?? 0) + native[0].length);
    for (let word = 0; word < 5; word += 1) {
      const next = /^[- \t]+([a-z][a-z0-9_]*)/i.exec(remaining);
      if (next === null) break;
      const token = next[1];
      if (token === undefined || /^(?:tools?|tooling|and|or|but|then|using|with|for|to|from|of|on|in|the|an?)$/i.test(token)) break;
      if (/^(?:apps?|applications?|modules?|bridges?|hosts?|providers?|adapters?|components?|backends?|process(?:es)?|platforms?|integrations?|code|libraries|library|bindings?|addons?)$/i.test(token)) {
        nativeComponent = true;
        break;
      }
      remaining = remaining.slice(next[0].length);
    }
    if (nativeComponent) break;
  }
  const crossPlatform = /\bcross[-\s]+platform\b/i.test(objective);
  const platforms: Array<ProjectEngineeringSettings['requiredPlatforms'][number]> = [];
  if (/\bwindows\b/i.test(objective)) platforms.push('win32');
  if (/\bmac\s*os\b/i.test(objective)) platforms.push('darwin');
  if (/\blinux\b/i.test(objective)) platforms.push('linux');
  return {
    nativeOrCrossPlatform: nativeComponent || crossPlatform,
    requiredPlatforms: platforms.length > 0 ? platforms
      : nativeComponent || crossPlatform || /แพลตฟอร์ม/i.test(objective) ? ['win32', 'darwin', 'linux'] : [],
  };
}
