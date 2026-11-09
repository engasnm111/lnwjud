import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoalContinuationService } from '@lnwjud/application';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalPostCommitOutbox } from './goal-postcommit-outbox.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const workspaceId='aabf6b4d-0df9-4461-800e-f9dadddec961';
const actor={clientId:'host-goal-event-test',clientName:'Host Goal Test',sessionId:'test-session'};
describe('Authoritative Goal Repository post-COMMIT events',()=>{
  it('persists real revisions, rejects stale CAS and excludes Full Bypass',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'lnwjud-host-event-'));
    const db=new SqliteDatabase(path.join(root,'state.sqlite'));
    try {
      const workspaces=new SqliteWorkspaceRepository(db);
      await workspaces.insert({id:workspaceId,displayName:'Event Fixture',rootPath:root,
        realRootPath:root,createdAt:'2026-11-08T10:00:00.000Z'});
      const goals=new SqliteGoalRepository(db);
      const outbox=new SqliteGoalPostCommitOutbox(()=>db.connection);
      outbox.initialize();
      let fullBypass=false;
      let woke=0;
      goals.attachTrustedGoalPostCommitOutbox(outbox,
        ()=>fullBypass?'full_bypass':'standard',()=>{woke++;});
      const service=new GoalContinuationService(workspaces,goals,{
        now:()=>new Date('2026-11-08T10:00:00.000Z'),
      });
      const created=await service.runGoal(actor,{
        workspaceId,goalKey:'one-real-goal',objective:'Host-committed checkpoint test',
        plan:{steps:[{id:'work',title:'Work'},{id:'done',title:'Done'}]},leaseSeconds:120,
      });
      expect(created.ok).toBe(true);
      if(!created.ok||!created.value.leaseToken)throw Error('Goal missing');
      expect(outbox.pending(workspaceId)).toMatchObject([
        {operation:'run_goal',revision:0,toStatus:'active',fromStatus:null},
      ]);
      const input={
        goalId:created.value.goalId,leaseToken:created.value.leaseToken,
        currentPhase:'progress',summary:'One real checkpoint',
        stepUpdates:[],nextAction:'Next scoped action',blockers:[],
        evidence:[],activeTaskIds:[],
      };
      const committed=await service.checkpointGoal(actor,{...input,expectedRevision:0});
      expect(committed.ok).toBe(true);
      expect(outbox.pending(workspaceId).map(e=>[e.operation,e.revision,e.fromStatus,e.toStatus]))
        .toEqual([['run_goal',0,null,'active'],['checkpoint_goal',1,'active','active']]);
      const stale=await service.checkpointGoal(actor,{...input,expectedRevision:0});
      expect(stale.ok).toBe(false);
      expect(outbox.pending(workspaceId)).toHaveLength(2);
      fullBypass=true;
      const excluded=await service.checkpointGoal(actor,{...input,expectedRevision:1});
      expect(excluded.ok).toBe(true);
      expect(outbox.pending(workspaceId)).toHaveLength(2);
      await Promise.resolve();
      expect(woke).toBeGreaterThan(0);
    }finally{
      db.close();
      await rm(root,{recursive:true,force:true});
    }
  });
});
