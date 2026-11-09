/** Host-only SQLite journal; distinct from native durable-writer admission. */
import type { DatabaseSync } from 'node:sqlite';
import type { GoalMemoryJournal,JournalIdentity } from './production-goal-memory-core.js';
const HEX=/^[a-f0-9]{64}$/;
const STATES=new Set(['no_write','uncertain','verified']);
export const GOAL_MEMORY_MIGRATION_SQL=`CREATE TABLE IF NOT EXISTS upm_goal_checkpoint_events_v1 (
  event_key TEXT NOT NULL PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','no_write','uncertain','verified')),
  receipt_hash TEXT,
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT
) WITHOUT ROWID;`;
export class SqliteGoalMemoryJournal implements GoalMemoryJournal {
  private readonly provider:()=>DatabaseSync;
  constructor(database:DatabaseSync|(()=>DatabaseSync)){
    this.provider=typeof database==='function'?database:()=>database;
    const c=this.provider();
    if(!c||typeof c.exec!=='function'||typeof c.prepare!=='function')throw Error('Trusted SQLite database required');
  }
  /** Invoked only by reviewed numbered host migration, not at random runtime. */
  initialize():void{this.provider().exec(GOAL_MEMORY_MIGRATION_SQL);}
  begin(input:JournalIdentity):boolean{
    if(!HEX.test(input.key)||!HEX.test(input.payloadHash))throw Error('Invalid journal identity');
    for(const s of [input.workspaceId,input.goalId,input.bankId,input.documentId]){
      if(typeof s!=='string'||!s||s.length>160)throw Error('Invalid journal metadata');
    }
    const row=this.provider().prepare(`INSERT INTO upm_goal_checkpoint_events_v1
      (event_key,payload_hash,workspace_id,goal_id,bank_id,document_id,state)
      VALUES (?,?,?,?,?,?,'reserved') ON CONFLICT(event_key) DO NOTHING`).run(
      input.key,input.payloadHash,input.workspaceId,input.goalId,input.bankId,input.documentId);
    return row.changes===1;
  }
  markDispatched(key:string):void{
    if(!HEX.test(key))throw Error('Invalid event key');
    const row=this.provider().prepare(`UPDATE upm_goal_checkpoint_events_v1 SET state='dispatched'
      WHERE event_key=? AND state='reserved'`).run(key);
    if(row.changes!==1)throw Error('Dispatch intent not durably recorded');
  }
  settle({key,state,receiptHash=null}:{key:string;state:'no_write'|'uncertain'|'verified';receiptHash?:string|null}):void{
    if(!HEX.test(key)||!STATES.has(state))throw Error('Invalid settlement');
    if(receiptHash!==null&&!HEX.test(receiptHash))throw Error('Invalid receipt hash');
    if(state==='verified'&&receiptHash===null)throw Error('Verified requires readback hash');
    const expected=state==='no_write'?'reserved':'dispatched';
    const row=this.provider().prepare(`UPDATE upm_goal_checkpoint_events_v1
      SET state=?, receipt_hash=?, settled_at=CURRENT_TIMESTAMP
      WHERE event_key=? AND state=?`).run(state,receiptHash,key,expected);
    if(row.changes!==1)throw Error('Journal settlement conflict');
  }
  inspect(key:string):unknown{
    if(!HEX.test(key))throw Error('Invalid event key');
    return this.provider().prepare(`SELECT event_key,payload_hash,workspace_id,goal_id,
      bank_id,document_id,state,receipt_hash FROM upm_goal_checkpoint_events_v1
      WHERE event_key=?`).get(key)??null;
  }
}
