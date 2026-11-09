import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProductionGoalMemoryBoundary } from '../src/main/production-goal-memory-core.js';
import {
  GOAL_POSTCOMMIT_CONTRACT,
  signCommittedGoalEvent,
  verifyAndClaimGoalEvent,
} from '../src/main/host-goal-postcommit-event-contract.js';

const workspaceId='aabf6b4d-0df9-4461-800e-f9dadddec961';
const goalId='ee54fd17-3050-4da9-ac64-038e2d5602e1';

describe('Signed committed checkpoint to Hindsight receipt (isolated transport)',()=>{
  it('requires one native consent, writes one document, verifies exact readback, blocks replay',async()=>{
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const envelope=signCommittedGoalEvent({
      contract:GOAL_POSTCOMMIT_CONTRACT,
      eventId:'a2e60d04-36b8-4e6f-84f3-b2583d62f409',
      workspaceId,goalId,revision:4,operation:'checkpoint_goal',
      fromStatus:'active',toStatus:'active',
      committedAt:'2026-11-08T10:00:00.000Z',
      origin:'host-goal-repository',authorizationMode:'standard',
    },'host-enrolled',privateKey);
    const claims=new Set<string>();
    const subscriber={
      isAuthorized:()=>true,
      trustedPublicKey:()=>publicKey,
      claimOnce:(_scope:string,_goal:string,revision:number)=>{
        const k=_scope+':'+_goal+':'+revision;
        if(claims.has(k))return false;
        claims.add(k);
        return true;
      },
    };
    const verified=await verifyAndClaimGoalEvent(envelope,workspaceId,subscriber);
    expect(verified.status).toBe('verified');
    if(verified.status!=='verified')throw Error('signature not verified');

    let approvals=0;
    let posts=0;
    let stored:{documentId:string;content:string}|null=null;
    const states=new Map<string,string>();
    const writer=new ProductionGoalMemoryBoundary({
      getSelectedScope:async()=>({workspaceId,realRootPath:'D:\\isolated-fixture'}),
      getPersistedGoal:async()=>({id:goalId,workspaceId,revision:4,status:'active',decisionRecorded:true,decisionSummary:'Approved scoped milestone checkpoint policy',nextStepRecorded:true,nextStepSummary:'Verify committed memory receipt exactly once'}),
      getAuthorizedBank:()=> 'project-approved-bank',
      requestApproval:request=>{
        expect(request.workspaceId).toBe(workspaceId);
        expect(request.summary).toContain('kind=decision');
        expect(request.summary).toContain('Approved scoped milestone checkpoint policy');
        expect(request.summary).toContain('Verify committed memory receipt exactly once');
        approvals++;
        return true;
      },
      journal:{
        begin:identity=>{
          if(states.has(identity.key))return false;
          states.set(identity.key,'reserved');
          return true;
        },
        markDispatched:key=>{
          expect(states.get(key)).toBe('reserved');
          states.set(key,'dispatched');
        },
        settle:({key,state})=>{
          expect(states.get(key)).toBe('dispatched');
          states.set(key,state);
        },
      },
      fetchImpl:async (url,init)=>{
        if(url.endsWith('/stats'))return{status:200,json:async()=>({documents:0})};
        if(url.endsWith('/memories')&&init.method==='POST'){
          posts++;
          const body=JSON.parse(String(init.body)) as {items:Array<{content:string;document_id:string}>};
          stored={content:body.items[0]!.content,documentId:body.items[0]!.document_id};
          return{status:200,json:async()=>({success:true,items_count:1})};
        }
        if(url.includes('/documents/')&&stored!==null){
          const document=stored as {documentId:string;content:string};
          return{status:200,json:async()=>({
            id:document.documentId,bank_id:'project-approved-bank',original_text:document.content,
          })};
        }
        throw Error('Unexpected Hindsight call: '+url);
      },
    });
    const outcome=await writer.recordGoalEvent({
      phase:'completed',resultCode:'SUCCESS',authorizationMode:'standard',
      eventId:verified.payload.eventId,workspaceId,
      goalId,goalStatus:'active',goalRevision:4,toolName:'checkpoint_goal',decisionRecorded:true,
    });
    expect(outcome.status).toBe('verified');
    expect(outcome.kind).toBe('decision');
    expect(approvals).toBe(1);
    expect(posts).toBe(1);
    expect([...states.values()]).toEqual(['verified']);
    expect(await verifyAndClaimGoalEvent(envelope,workspaceId,subscriber))
      .toEqual({status:'rejected',reason:'replay'});
    expect(posts).toBe(1);
  });
});
