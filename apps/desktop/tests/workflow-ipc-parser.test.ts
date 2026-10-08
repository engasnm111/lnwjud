import { describe, expect, it } from 'vitest';
import { parseCancelOwnedGoalTask, parseRestoreTaskCheckpoint } from '../src/main/workflow-ipc-parser.js';

describe('Goal-scoped Desktop IPC mutations', () => {
  const original = {
    workspaceId:'workspace-1',goalId:'goal-1',goalRevision:3,
    checkpointId:'checkpoint-1',expectedCurrentHashes:{'src/file.ts':'a'.repeat(64)},
    userConfirmed:true,
  };
  it('accepts a bounded exact Goal checkpoint/hash request', () => {
    expect(parseRestoreTaskCheckpoint(original)).toMatchObject(original);
  });
  it('fails closed on stale/missing confirmation, unknown fields, and malformed hashes', () => {
    for (const bad of [
      {...original,userConfirmed:false},
      {...original,goalRevision:-1},
      {...original,expectedCurrentHashes:{}},
      {...original,expectedCurrentHashes:{'src/file.ts':'fake'}},
      {...original,expectedCurrentHashes:{'src/file.ts':'a'.repeat(64)},leaseToken:'forbidden'},
      {...original,expectedCurrentHashes:Object.fromEntries(Array.from({length:21},(_,i)=>['file'+i,'a'.repeat(64)]))},
    ]) expect(()=>parseRestoreTaskCheckpoint(bad)).toThrow();
  });
  it('accepts only exact supported providers and explicit cancellation', () => {
    const input={workspaceId:'workspace-1',goalId:'goal-1',taskId:'task-1',provider:'shell',userConfirmed:true};
    expect(parseCancelOwnedGoalTask(input)).toEqual(input);
    for(const bad of [
      {...input,userConfirmed:false},
      {...input,provider:'unknown'},
      {...input,ownerClientId:'spoofed'},
      {...input,taskId:''},
    ]) expect(()=>parseCancelOwnedGoalTask(bad)).toThrow();
  });
});
