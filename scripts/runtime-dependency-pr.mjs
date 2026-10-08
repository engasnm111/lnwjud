/**
 * Runtime dependency update decision. A fixed managed ref is the sole permissible
 * automation branch; this pure function performs no Git/GitHub writes.
 */
export const MANAGED_RUNTIME_REF = 'automation/runtime-dependencies';
export const MANAGED_RUNTIME_MARKER = '<!-- lnwjud-runtime-update:v1 -->';

export const MANAGED_RUNTIME_PR_TITLE = 'chore: update verified runtime dependencies';

export function isManagedRuntimePr(pr, repository) {
  if (!pr || typeof pr !== 'object' || typeof repository !== 'string' || !repository.includes('/')) return false;
  const author = pr.author?.login;
  return pr.headRefName === MANAGED_RUNTIME_REF && pr.baseRefName === 'dev'
    && pr.isCrossRepository === false
    && (author === 'app/github-actions' || author === 'github-actions[bot]' || author === 'github-actions')
    && typeof pr.headRefOid === 'string' && /^[a-f0-9]{40}$/i.test(pr.headRefOid)
    && typeof pr.body === 'string' && pr.body.includes(MANAGED_RUNTIME_MARKER)
    && pr.headRepository?.nameWithOwner === repository;
}
export function classifyRuntimePullRequests(prs, repository) {
  if (!Array.isArray(prs)) return { managed: null, legacyOpenPrCount: 1, conflict: true };
  const legacy = prs.filter((pr) => typeof pr.headRefName === 'string'
    && pr.headRefName.startsWith('automation/runtime-dependencies-'));
  const matching = prs.filter((pr) => pr.headRefName === MANAGED_RUNTIME_REF);
  if (matching.length > 1 || (matching.length === 1 && !isManagedRuntimePr(matching[0], repository))) {
    return { managed: null, legacyOpenPrCount: legacy.length, conflict: true };
  }
  return { managed: matching[0] ?? null, legacyOpenPrCount: legacy.length, conflict: false };
}

export function planRuntimeDependencyUpdate(input) {
  if (!input || !['absent', 'managed', 'foreign', 'unknown'].includes(input.branchOwnership)
      || typeof input.changed !== 'boolean' || !Number.isInteger(input.legacyOpenPrCount)
      || input.legacyOpenPrCount < 0) {
    return { action: 'blocked', reason: 'invalid_state' };
  }
  if (input.legacyOpenPrCount > 0) return { action: 'blocked', reason: 'migration_needed' };
  if (input.branchOwnership === 'foreign' || input.branchOwnership === 'unknown') {
    return { action: 'blocked', reason: 'unverified_branch_ownership' };
  }
  if (input.openPr && (!input.openPr.managed || input.branchOwnership !== 'managed'
      || !Number.isInteger(input.openPr.number) || input.openPr.number < 1
      || !/^[a-f0-9]{40}$/i.test(input.openPr.headSha))) {
    return { action: 'blocked', reason: 'unverified_pr_ownership' };
  }
  if (input.branchOwnership === 'managed' && !input.openPr) {
    return { action: 'blocked', reason: 'orphan_managed_ref_needs_review' };
  }
  if (!input.changed) return { action: 'none' };
  if (input.openPr) return {
    action: 'update', prNumber: input.openPr.number, expectedHeadSha: input.openPr.headSha,
  };
  return { action: 'create' };
}
