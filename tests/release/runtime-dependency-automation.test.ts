import { describe, expect, it } from 'vitest';
import { planRuntimeDependencyUpdate, isManagedRuntimePr, classifyRuntimePullRequests, MANAGED_RUNTIME_MARKER } from '../../scripts/runtime-dependency-pr.mjs';
import { planRuntimeDependencyCleanup } from '../../scripts/cleanup-runtime-dependency-branch.mjs';

const sha = 'a'.repeat(40);
describe('managed runtime dependency PR state machine', () => {
  const managed = {
    number: 175, headRefName:'automation/runtime-dependencies', baseRefName:'dev',
    isCrossRepository:false, headRefOid:sha, headRepository:{nameWithOwner:'engasnm111/lnwjud'},
    author:{login:'app/github-actions'}, body:MANAGED_RUNTIME_MARKER,
  };
  it('verifies repository, bot, marker and head identity beyond PR title/label', () => {
    expect(isManagedRuntimePr(managed,'engasnm111/lnwjud')).toBe(true);
    for(const changed of [
      {...managed,author:{login:'untrusted-human'}},
      {...managed,body:'Not a managed PR'},
      {...managed,isCrossRepository:true},
      {...managed,headRepository:{nameWithOwner:'another/repo'}},
      {...managed,headRefOid:'not-a-sha'},
    ]) expect(isManagedRuntimePr(changed,'engasnm111/lnwjud')).toBe(false);
  });
  it('blocks two managed PRs or legacy run-ID branches before creating anything', () => {
    expect(classifyRuntimePullRequests([managed,managed],'engasnm111/lnwjud').conflict).toBe(true);
    expect(classifyRuntimePullRequests([managed,{...managed,headRefName:'automation/runtime-dependencies-123'}],'engasnm111/lnwjud'))
      .toMatchObject({legacyOpenPrCount:1,conflict:false});
  });
  it('conditionally cleans only a merged owned SHA with no other PR using the ref', () => {
    const valid={merged:true,sameRepository:true,managedIdentity:true,baseRef:'dev',
      headRef:'automation/runtime-dependencies',expectedHeadSha:sha,remoteHeadSha:sha,
      mergedHeadAncestorOfDev:true,otherOpenPrsUsingHead:0};
    expect(planRuntimeDependencyCleanup(valid)).toEqual({action:'delete',expectedHeadSha:sha});
    expect(planRuntimeDependencyCleanup({...valid,remoteHeadSha:null})).toEqual({action:'none',reason:'already_absent'});
    for(const changed of [
      {...valid,remoteHeadSha:'b'.repeat(40)},
      {...valid,mergedHeadAncestorOfDev:false},
      {...valid,otherOpenPrsUsingHead:1},
      {...valid,headRef:'dev'},
      {...valid,managedIdentity:false},
      {...valid,merged:false},
    ])expect(planRuntimeDependencyCleanup(changed).action).toBe('blocked');
  });

  it('reuses the one verified bot PR, never opens a second one', () => {
    expect(planRuntimeDependencyUpdate({ changed: true, branchOwnership: 'managed', legacyOpenPrCount: 0,
      openPr: { number: 175, managed: true, headSha: sha } }))
      .toEqual({ action: 'update', prNumber: 175, expectedHeadSha: sha });
  });
  it('creates only when the managed ref is absent and pins changed', () => {
    expect(planRuntimeDependencyUpdate({ changed: true, branchOwnership: 'absent', legacyOpenPrCount: 0, openPr: null })).toEqual({ action: 'create' });
    expect(planRuntimeDependencyUpdate({ changed: false, branchOwnership: 'absent', legacyOpenPrCount: 0, openPr: null })).toEqual({ action: 'none' });
  });
  it.each([
    { changed: true, branchOwnership: 'foreign', legacyOpenPrCount: 0, openPr: null },
    { changed: true, branchOwnership: 'unknown', legacyOpenPrCount: 0, openPr: null },
    { changed: true, branchOwnership: 'managed', legacyOpenPrCount: 0, openPr: null },
    { changed: true, branchOwnership: 'managed', legacyOpenPrCount: 1, openPr: { number: 12, managed: true, headSha: sha } },
    { changed: true, branchOwnership: 'managed', legacyOpenPrCount: 0, openPr: { number: 13, managed: false, headSha: sha } },
    { changed: true, branchOwnership: 'absent', legacyOpenPrCount: 0, openPr: { number: 14, managed: true, headSha: sha } },
    { changed: true, branchOwnership: 'managed', legacyOpenPrCount: 0, openPr: { number: 15, managed: true, headSha: 'not-a-sha' } },
  ])('blocks unsafe or competing state: %j', (input) => {
    expect(planRuntimeDependencyUpdate(input).action).toBe('blocked');
  });
});
