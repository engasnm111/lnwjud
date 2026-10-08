import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { AuditEventRepository } from '@lnwjud/audit';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';
import { TaskResultService } from './task-result-service.js';

const created:string[]=[];
afterEach(async()=>{await Promise.all(created.splice(0).map((dir)=>rm(dir,{recursive:true,force:true})))});
const actor:FileActor={clientId:'goal-owner',clientName:'Goal Owner'};
async function fixture(): Promise<{dir:string;workspace:WorkspaceRepository;service:GoalContinuationService}> {
  const dir=await mkdtemp(path.join(os.tmpdir(),'lnwjud-task-results-'));
  created.push(dir);
  const workspace={get:async(id:string)=>id==='ws'?{id:'ws',realRootPath:dir}:null} as WorkspaceRepository;
  const goal={goalId:'goal-1',workspaceId:'ws',revision:4,status:'active',blockers:[],
    lastCheckpoint:{id:'cp-1'},engineering:{gates:[{title:'Functional integration',status:'pending'}]}};
  const service={getGoal:async()=>ok(goal)} as unknown as GoalContinuationService;
  return {dir,workspace,service};
}
describe('Task Results authoritative observations',()=>{
  it('reports exact first-party mutation receipts without claiming unknown checks passed',async()=>{
    const {dir,workspace,service}=await fixture();
    const file='result.xlsx',contents=Buffer.from('actual verified bytes');
    await writeFile(path.join(dir,file),contents);
    const sha=createHash('sha256').update(contents).digest('hex');
    const source={listGoalMutationReceipts:async()=>[
      {operationId:'event-1',path:file,action:'office_excel',observedAt:'2026-10-08T00:00:00Z',
        afterSha256:sha,sizeBytes:contents.length,verification:'verified' as const},
      {operationId:'event-2',path:'legacy.txt',action:'edit_file',observedAt:'2026-10-08T00:00:00Z'},
    ]} as Pick<AuditEventRepository,'listGoalMutationReceipts'>;
    const result=await new TaskResultService(service,source,workspace).get(actor,'ws','goal-1');
    expect(result).toMatchObject({ok:true,value:{
      observedChanges:[{operationId:'event-1',path:file},{operationId:'event-2',path:'legacy.txt'}],
      artifacts:[{path:file,verification:'verified',sha256:sha}],
      checks:[{name:'Functional integration',status:'pending'}],
      evidenceCoverage:'partial',lastCheckpointId:'cp-1',
    }});
  });
  it('fails artifact verification after user edits bytes and never rewrites files',async()=>{
    const {dir,workspace,service}=await fixture();
    const originalSha=createHash('sha256').update('expected bytes').digest('hex');
    await writeFile(path.join(dir,'edited.xlsx'),'user changed bytes');
    const source={listGoalMutationReceipts:async()=>[{
      operationId:'event-1',path:'edited.xlsx',action:'office_excel',observedAt:'2026-10-08T00:00:00Z',
      afterSha256:originalSha,verification:'verified' as const,
    }]} as Pick<AuditEventRepository,'listGoalMutationReceipts'>;
    const result=await new TaskResultService(service,source,workspace).get(actor,'ws','goal-1');
    expect(result).toMatchObject({ok:true,value:{artifacts:[{verification:'failed'}],evidenceCoverage:'partial'}});
  });
  it('rejects cross-workspace Goal requests before fetching receipts',async()=>{
    const {workspace,service}=await fixture();
    let called=false;
    const source={listGoalMutationReceipts:async()=>{called=true;return[]}} as Pick<AuditEventRepository,'listGoalMutationReceipts'>;
    const result=await new TaskResultService(service,source,workspace).get(actor,'other','goal-1');
    expect(result).toMatchObject({ok:false,error:{code:'WORKSPACE_NOT_FOUND'}});
    expect(called).toBe(false);
  });
});
