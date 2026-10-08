import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import { ResourceSnapshotService } from './resource-snapshot-service.js';

const actor: FileActor = { clientId:'own-client', clientName:'Test' };
const workspaces = { get: async (id: string) => id === 'ws' ? { id:'ws' } : null } as WorkspaceRepository;
const task = { taskId:'task-1', provider:'shell', role:'blocking_job', cancelWithGoal:true } as const;
describe('ResourceSnapshotService ownership and metrics', () => {
  it('never grants cancellation from a Goal task ID alone, nor invents process or context metrics', async () => {
    const goal = { goalId:'g', workspaceId:'ws', trackedTasks:[task, {...task, taskId:'shared',role:'supporting_service'}] };
    const goals = { getGoal:async () => ok(goal) } as unknown as GoalContinuationService;
    const service = new ResourceSnapshotService(workspaces, goals, undefined, () => new Date('2026-10-08T00:00:00Z'));
    const result = await service.get(actor, { workspaceId:'ws', goalId:'g' });
    expect(result).toMatchObject({ ok:true, value:{
      coverage:'unknown', stale:false,
      resources:[{ ownership:'unknown', canCancel:false },{ ownership:'shared',canCancel:false }],
      context:{rawContextBytes:null,contextSentBytes:null,previouslySeenBytesAvoided:null,ledgerHits:null},
    }});
  });
  it('permits only freshly verified owned blocking tasks; refuses stale and shared cancellation', async () => {
    const goal = { goalId:'g', workspaceId:'ws', trackedTasks:[task,{...task, taskId:'stale'},{...task,taskId:'shared',role:'supporting_service'}] };
    const goals = { getGoal:async () => ok(goal) } as unknown as GoalContinuationService;
    const service = new ResourceSnapshotService(workspaces, goals, {
      getOwnedTask:async (_ws,_goal,taskId): Promise<{ownerVerified:boolean;observedAt:string;workingSetBytes:number}> => ({
        ownerVerified:true,
        observedAt:taskId==='stale'?'2026-10-07T20:00:00Z':'2026-10-08T00:00:00Z',
        workingSetBytes:taskId==='task-1'?123:null as never,
      }),
      getContextStats:async (): Promise<{rawContextBytes:number;contextSentBytes:number;ledgerHits:number;previouslySeenBytesAvoided:number}> => ({  rawContextBytes:512,contextSentBytes:400,ledgerHits:2,previouslySeenBytesAvoided:100 }),
    },()=>new Date('2026-10-08T00:00:03Z'));
    const result = await service.get(actor,{workspaceId:'ws',goalId:'g'});
    expect(result).toMatchObject({ ok:true,value:{
      stale:true,resources:[{ ownership:'owned',canCancel:true,workingSetBytes:123 },{ ownership:'unknown',canCancel:false },{ ownership:'shared',canCancel:false }],
      context:{rawContextBytes:512,contextSentBytes:400,ledgerHits:2,previouslySeenBytesAvoided:100},
    }});
  });
  it('aggregates tracked tasks across Goal options for measured workspace-wide filtering', async () => {
    const goals = { getGoal:async () => ok({ goalId:'g-a',workspaceId:'ws',trackedTasks:[] }) } as unknown as GoalContinuationService;
    const hostGoals = {
      listWorkspaceGoalFilters: async (): Promise<readonly {id:string}[]> => [{ id:'g-a' },{ id:'g-b' }],
      getById: async (id:string): Promise<{id:string;workspaceId:string;trackedTasks:readonly {taskId:string;provider:string;role:string;cancelWithGoal:boolean}[]}> => ({ id, workspaceId:'ws', trackedTasks:[{ ...task, taskId:id }] }),
    };
    const service = new ResourceSnapshotService(workspaces, goals, {
      getOwnedTask:async (_ws, goalId): Promise<{ownerVerified:boolean;observedAt:string;workingSetBytes?:number}> => ({
        ownerVerified:true, observedAt:'2026-10-08T00:00:00Z', ...(goalId==='g-a' ? { workingSetBytes: 1234 } : {}),
      }),
    }, () => new Date('2026-10-08T00:00:00Z'), hostGoals as never);
    const result = await service.get(actor, { workspaceId:'ws' });
    expect(result).toMatchObject({ ok:true, value: { resources: [
      { goalId:'g-a', workingSetBytes:1234, ownership:'owned' },
      { goalId:'g-b', ownership:'owned' },
    ] } });
    if (result.ok) expect(result.value.resources[1]).not.toHaveProperty('workingSetBytes');
  });

  it('keeps other Task measurements when one provider observation fails', async () => {
    const goals = { getGoal: async () => ok({ goalId:'g', workspaceId:'ws', trackedTasks:[task,{...task,taskId:'failed'}] }) } as unknown as GoalContinuationService;
    const service = new ResourceSnapshotService(workspaces, goals, {
      getOwnedTask: async (_workspaceId, _goalId, taskId): Promise<{ownerVerified:boolean;observedAt:string;workingSetBytes:number}> => {
        if (taskId === 'failed') throw new Error('Process exited while probing');
        return { ownerVerified:true, observedAt:'2026-10-08T00:00:00Z', workingSetBytes:512 };
      },
    }, () => new Date('2026-10-08T00:00:00Z'));
    const result = await service.get(actor,{workspaceId:'ws',goalId:'g'});
    expect(result).toMatchObject({ok:true,value:{stale:true,resources:[
      {taskId:'task-1',ownership:'owned',workingSetBytes:512},
      {taskId:'failed',ownership:'unknown',canCancel:false},
    ]}});
  });

  it('denies cross-workspace Goal visibility before returning tracked tasks', async () => {
    const goals = { getGoal:async () => ok({goalId:'g',workspaceId:'other',trackedTasks:[task]}) } as unknown as GoalContinuationService;
    expect(await new ResourceSnapshotService(workspaces,goals).get(actor,{workspaceId:'ws',goalId:'g'}))
      .toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
  });
});
