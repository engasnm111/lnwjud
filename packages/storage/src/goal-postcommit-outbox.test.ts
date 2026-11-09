import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteGoalPostCommitOutbox } from './goal-postcommit-outbox.js';

const workspaceId='aabf6b4d-0df9-4461-800e-f9dadddec961';
const goalId='ee54fd17-3050-4da9-ac64-038e2d5602e1';
const transition={
  operation:'checkpoint_goal' as const,
  workspaceId,goalId,revision:5,
  fromStatus:'active' as const,toStatus:'active' as const,
  committedAt:'2026-11-08T10:00:00.000Z',
};
function fixture(){
  const db=new DatabaseSync(':memory:');
  const outbox=new SqliteGoalPostCommitOutbox(db);
  outbox.initialize();
  return {db,outbox};
}
describe('Durable Goal post-commit outbox',()=>{
  it('retains only transaction-committed events, not rolled-back changes',()=>{
    const {db,outbox}=fixture();
    db.exec('BEGIN IMMEDIATE');
    outbox.stage(transition);
    db.exec('ROLLBACK');
    expect(outbox.pending(workspaceId)).toEqual([]);
    db.exec('BEGIN IMMEDIATE');
    const id=outbox.stage(transition);
    db.exec('COMMIT');
    expect(outbox.pending(workspaceId)).toHaveLength(1);
    expect(outbox.inspect(id)?.payload.revision).toBe(5);
    db.close();
  });
  it('keeps the exact scope, status, operation and minimal metadata',()=>{
    const {db,outbox}=fixture();
    const id=outbox.stage(transition);
    const p=outbox.inspect(id)?.payload;
    expect(p).toMatchObject({
      workspaceId,goalId,revision:5,operation:'checkpoint_goal',
      fromStatus:'active',toStatus:'active',
      origin:'host-goal-repository',authorizationMode:'standard',
    });
    expect(Object.keys(p ?? {}).sort()).toEqual([
      'authorizationMode','committedAt','contract','eventId','fromStatus',
      'goalId','operation','origin','revision','toStatus','workspaceId',
    ].sort());
    expect(outbox.pending('00000000-0000-4000-8000-000000000001')).toEqual([]);
    db.close();
  });
  it('does not redispatch after durable claim or uncertain settlement',()=>{
    const {db,outbox}=fixture();
    const id=outbox.stage(transition);
    expect(outbox.markDispatched(id)).toBe(true);
    expect(outbox.markDispatched(id)).toBe(false);
    expect(outbox.pending(workspaceId)).toEqual([]);
    outbox.settle(id,'uncertain');
    expect(outbox.inspect(id)?.state).toBe('uncertain');
    expect(()=>outbox.settle(id,'verified')).toThrow('HOST_EVENT_SETTLEMENT_CONFLICT');
    db.close();
  });
  it('deduplicates by workspace, Goal and revision regardless of event identity',()=>{
    const {db,outbox}=fixture();
    outbox.stage(transition);
    expect(()=>outbox.stage(transition)).toThrow('HOST_EVENT_REVISION_DUPLICATE');
    db.close();
  });
  it('refuses forged no-change run_goal lifecycle entries',()=>{
    const {db,outbox}=fixture();
    expect(()=>outbox.stage({...transition,operation:'run_goal'})).toThrow('INVALID_COMMITTED_GOAL_EVENT');
    db.close();
  });
});
