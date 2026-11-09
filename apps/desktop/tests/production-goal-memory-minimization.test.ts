import { describe, expect, it } from 'vitest';
import { safeMilestoneText, ProductionGoalMemoryBoundary } from '../src/main/production-goal-memory-core.js';
const goalId='b442ddcd-6d6b-4a71-bb1c-846e66379a60';
describe('Milestone data minimization and consent preview',()=>{
  it('accepts short useful scoped milestone, rejects credentials, URLs, paths and raw controls',()=>{
    expect(safeMilestoneText('Approved using verified Host event receipts')).toBe('Approved using verified Host event receipts');
    for (const text of ['token=ABCD123456789', 'Password is abcdefg', 'Open https://example.com/report',
      'Read C:\\Users\\person\\file.txt', 'secret: dont share','support@example.com', 'Line one\nLine two',
      'Decision includes sk-abcdefghijkmnopqrstuvwxyz1234567890']) {
      expect(safeMilestoneText(text)).toBeNull();
    }
  });
  it('does not request Native Consent or journal writes for unsafe Host decision text',async()=>{
    let approvals=0, dispatches=0;
    const boundary=new ProductionGoalMemoryBoundary({
      getSelectedScope:()=>({workspaceId:'project-1',realRootPath:'D:\\fixture'}),
      getPersistedGoal:()=>({id:goalId,workspaceId:'project-1',status:'active',revision:4,decisionRecorded:true,
        decisionSummary:'API token=PRIVATE_SECRET must never be sent'}),
      getAuthorizedBank:()=> 'approved-bank',
      requestApproval:()=>{approvals++;return true;},
      journal:{begin:()=>{dispatches++;return true;},markDispatched:()=>{},settle:()=>{}},
      fetchImpl:async()=>{throw Error('network forbidden');},
    });
    expect(await boundary.recordGoalEvent({
      phase:'completed',resultCode:'SUCCESS',eventId:'a2e60d04-36b8-4e6f-84f3-b2583d62f409',
      workspaceId:'project-1',goalId,goalStatus:'active',goalRevision:4,toolName:'checkpoint_goal',decisionRecorded:true,
    })).toEqual({status:'skipped',reason:'unsafe_or_missing_decision_summary'});
    expect(approvals).toBe(0);expect(dispatches).toBe(0);
  });
});
