/** Host repository outbox. Stage within the Goal SQL transaction; only COMMIT
 * makes an entry visible. Never accept caller-supplied Goal activity as a commit.
 * This queue carries only allowlisted metadata, not prompts, paths or secrets.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const GOAL_POSTCOMMIT_OUTBOX_SQL = `CREATE TABLE IF NOT EXISTS goal_postcommit_outbox_v1 (
  event_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL, goal_id TEXT NOT NULL, revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatched','verified','no_write','uncertain')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, settled_at TEXT,
  UNIQUE(workspace_id,goal_id,revision)
) WITHOUT ROWID;`;

export type GoalEventState = 'active'|'blocked'|'completed'|'failed'|'cancelled';
export type GoalEventOperation = 'run_goal'|'checkpoint_goal'|'finish_goal';
export interface HostGoalTransition {
  readonly workspaceId:string; readonly goalId:string; readonly revision:number;
  readonly operation:GoalEventOperation; readonly fromStatus:GoalEventState|null;
  readonly toStatus:GoalEventState; readonly committedAt:string;
}
export interface HostOutboxEvent extends HostGoalTransition {
  readonly contract:'lnwjud.goal.postcommit.v1'; readonly eventId:string;
  readonly origin:'host-goal-repository'; readonly authorizationMode:'standard';
}
export interface HostGoalOutboxWriter { stage(transition:HostGoalTransition):string; }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES=new Set(['active','blocked','completed','failed','cancelled']);
function valid(x:HostGoalTransition):boolean {
  return UUID.test(x.workspaceId)&&UUID.test(x.goalId)
    && Number.isSafeInteger(x.revision)&&x.revision>=0
    && ['run_goal','checkpoint_goal','finish_goal'].includes(x.operation)
    && STATES.has(x.toStatus)&&(x.fromStatus===null||STATES.has(x.fromStatus))
    && (x.fromStatus!==x.toStatus||x.operation==='checkpoint_goal')
    && Number.isFinite(Date.parse(x.committedAt));
}
interface Row {event_id:string;payload_json:string;state:string;}
/** Initialize only by explicit Host opt-in migration, not every MCP request. */
export class SqliteGoalPostCommitOutbox implements HostGoalOutboxWriter {
  private readonly provider:()=>DatabaseSync;
  constructor(db:DatabaseSync|(()=>DatabaseSync)) {
    this.provider=typeof db==='function'?db:()=>db;
    if(typeof this.provider()?.prepare!=='function')throw Error('HOST_SQLITE_REQUIRED');
  }
  initialize():void { this.provider().exec(GOAL_POSTCOMMIT_OUTBOX_SQL); }
  stage(x:HostGoalTransition):string {
    if(!valid(x))throw Error('INVALID_COMMITTED_GOAL_EVENT');
    const eventId=randomUUID();
    const p:HostOutboxEvent={contract:'lnwjud.goal.postcommit.v1',eventId,
      workspaceId:x.workspaceId,goalId:x.goalId,revision:x.revision,operation:x.operation,
      fromStatus:x.fromStatus,toStatus:x.toStatus,committedAt:x.committedAt,
      origin:'host-goal-repository',authorizationMode:'standard'};
    const row=this.provider().prepare(`INSERT INTO goal_postcommit_outbox_v1
      (event_id,workspace_id,goal_id,revision,payload_json,state)
      VALUES(?,?,?,?,?,'pending') ON CONFLICT(workspace_id,goal_id,revision) DO NOTHING`)
      .run(eventId,p.workspaceId,p.goalId,p.revision,JSON.stringify(p));
    if(row.changes!==1)throw Error('HOST_EVENT_REVISION_DUPLICATE');
    return eventId;
  }
  pending(workspaceId:string,limit=20):readonly HostOutboxEvent[] {
    if(!UUID.test(workspaceId)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('INVALID_EVENT_SCOPE');
    const rows=this.provider().prepare(`SELECT event_id,payload_json,state FROM goal_postcommit_outbox_v1
      WHERE workspace_id=? AND state='pending' ORDER BY revision,event_id LIMIT ?`)
      .all(workspaceId,limit) as unknown as Row[];
    return rows.map(row=>{
      const p=JSON.parse(row.payload_json) as HostOutboxEvent;
      if(!valid(p)||p.contract!=='lnwjud.goal.postcommit.v1'
        ||p.authorizationMode!=='standard'||p.origin!=='host-goal-repository'
        ||p.eventId!==row.event_id||p.workspaceId!==workspaceId)throw Error('CORRUPT_HOST_OUTBOX');
      return p;
    });
  }
  markDispatched(eventId:string):boolean {
    if(!UUID.test(eventId))throw Error('INVALID_EVENT_ID');
    return this.provider().prepare(`UPDATE goal_postcommit_outbox_v1 SET state='dispatched'
      WHERE event_id=? AND state='pending'`).run(eventId).changes===1;
  }
  settle(eventId:string,state:'verified'|'no_write'|'uncertain'):void {
    if(!UUID.test(eventId))throw Error('INVALID_EVENT_ID');
    if(this.provider().prepare(`UPDATE goal_postcommit_outbox_v1 SET state=?,settled_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND state='dispatched'`).run(state,eventId).changes!==1)
      throw Error('HOST_EVENT_SETTLEMENT_CONFLICT');
  }
  inspect(eventId:string):{state:string;payload:HostOutboxEvent}|null {
    if(!UUID.test(eventId))throw Error('INVALID_EVENT_ID');
    const row=this.provider().prepare(`SELECT event_id,payload_json,state FROM goal_postcommit_outbox_v1
      WHERE event_id=?`).get(eventId) as unknown as Row|undefined;
    if(!row)return null;
    const p=JSON.parse(row.payload_json) as HostOutboxEvent;
    if(!valid(p)||p.eventId!==row.event_id)throw Error('CORRUPT_HOST_OUTBOX');
    return {state:row.state,payload:p};
  }
}
