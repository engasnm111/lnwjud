/**
 * Candidate v3: Host-owned, scoped Goal event → durable journal → Hindsight document.
 * This module does not detect chat milestones and is disabled until trusted Host
 * configuration, bank mapping, local approval and migration have been reviewed.
 */
import { createHash } from 'node:crypto';

const BACKEND = 'http://127.0.0.1:8888';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATUS = new Set(['active','blocked','completed','failed','cancelled']);
const GOAL_TOOLS = new Set(['run_goal','checkpoint_goal','finish_goal']);
const digest = (input: string): string => createHash('sha256').update(input).digest('hex');

type EventKind = 'completed' | 'decision' | 'blocker' | 'next_step';
type CheckpointState = 'skipped' | 'indeterminate' | 'verified';
export type CheckpointOutcome = {
  status: CheckpointState;
  reason?: string;
  kind?: EventKind;
  documentId?: string;
  bankId?: string;
  contentHash?: string;
};
const outcome = (status: CheckpointState, reason?: string): CheckpointOutcome => ({
  status, ...(reason === undefined ? {} : {reason}),
});

export interface HostProjectScope {
  readonly workspaceId: string;
  readonly realRootPath: string;
}
export interface HostGoalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly revision: number;
  readonly updatedAt?: string;
  /** Derived by the Host from a persisted checkpoint at this exact Goal revision. */
  readonly decisionRecorded?: boolean;
  readonly nextStepRecorded?: boolean;
  /** Only bounded, validated Host-persisted milestone text. Never a transcript. */
  readonly decisionSummary?: string;
  readonly nextStepSummary?: string;
  readonly terminalSummary?: string;
}
export interface HostGoalSnapshot {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: string;
}
export interface GoalCheckpointEvent {
  readonly phase: 'completed';
  readonly resultCode: 'SUCCESS';
  readonly authorizationMode?: 'standard' | 'full_bypass';
  readonly eventId: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly goalStatus: string;
  readonly goalRevision: number;
  /** Only authoritative after matching the persisted Host Goal checkpoint. */
  readonly decisionRecorded?: boolean;
  readonly nextStepRecorded?: boolean;
  readonly toolName: 'run_goal' | 'checkpoint_goal' | 'finish_goal';
}
export interface JournalIdentity {
  readonly key: string;
  readonly payloadHash: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly bankId: string;
  readonly documentId: string;
}
export interface GoalMemoryJournal {
  begin(identity: JournalIdentity): Promise<boolean> | boolean;
  markDispatched(key: string): Promise<void> | void;
  settle(input: {key:string;state:'no_write'|'uncertain'|'verified';receiptHash?:string|null}): Promise<void> | void;
}
export interface NativeCheckpointApprovalRequest {
  readonly toolName: 'automatic_project_checkpoint_memory';
  readonly mutationKind: 'bounded_write';
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly reason: string;
  readonly summary: string;
}
export interface HttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export type HttpFetch = (url: string, init: RequestInit) => Promise<HttpResponse>;
export interface ProductionGoalMemoryOptions {
  readonly getSelectedScope: () => Promise<HostProjectScope|null>;
  readonly getPersistedGoal: (goalId:string) => Promise<HostGoalRecord|null>;
  readonly getAuthorizedBank: (workspaceId:string) => Promise<string|null> | string | null;
  readonly requestApproval: (request:NativeCheckpointApprovalRequest) => Promise<boolean> | boolean;
  readonly journal: GoalMemoryJournal;
  readonly fetchImpl?: HttpFetch;
  readonly endpoint?: string;
}

export function classifyGoalEvent(toolName: string, status: string, committedDecision=false, committedNextStep=false): EventKind|null {
  if (toolName==='checkpoint_goal' && status==='active' && committedDecision) return 'decision';
  if (toolName==='finish_goal' && status==='completed') return 'completed';
  if (toolName==='finish_goal' && (status==='blocked'||status==='failed')) return 'blocker';
  if ((toolName==='run_goal'||toolName==='checkpoint_goal') && status==='active' && committedNextStep) return 'next_step';
  return null;
}
export function selectChangedHostGoal(before: readonly HostGoalSnapshot[], after: readonly HostGoalSnapshot[], verifiedGoalId?: string): HostGoalSnapshot|null {
  if (!Array.isArray(before)||!Array.isArray(after)) return null;
  const previous=new Map(before.map(g=>[g.id,g]));
  const changed=after.filter(g=>{
    const old=previous.get(g.id);
    return old===undefined||old.status!==g.status||old.updatedAt!==g.updatedAt;
  });
  if (verifiedGoalId!==undefined) return changed.find(g=>g.id===verifiedGoalId)??null;
  return changed.length===1 ? changed[0]! : null;
}
/** Reject possible credentials, paths, URLs and identifiers instead of silently leaking them. */
export function safeMilestoneText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < 8 || text.length > 220 || /[\r\n\x00-\x1f]/.test(value)) return null;
  if (/(?:password|passwd|secret|token|api[\s_-]?key|bearer|private[\s_-]?key|credential|authorization|otp|รหัสผ่าน|โทเคน|คีย์ลับ)/i.test(text)) return null;
  if (/(?:https?:\/\/|[A-Za-z]:\\|\\\\|\/\w+\/|@[\w.-]+\.[a-z]{2,}|(?:[A-Za-z0-9+/]{36,}={0,2})|\b[A-Za-z0-9_-]{30,}\b|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,})/i.test(text)) return null;
  return text;
}
function scopeMatches(a: HostProjectScope|null,b:HostProjectScope|null): boolean {
  return a!==null && b!==null && IDENTIFIER.test(a.workspaceId)
    && a.workspaceId===b.workspaceId && typeof a.realRootPath==='string'
    && a.realRootPath.length>0 && a.realRootPath===b.realRootPath;
}
async function trustedRead<T,A>(fn:(arg:A)=>Promise<T>|T, arg:A):Promise<T|null> {
  try{return await fn(arg);}catch{return null;}
}
function validEvent(e:GoalCheckpointEvent):boolean {
  return e!==null && e.phase==='completed' && e.resultCode==='SUCCESS'
    && e.authorizationMode!=='full_bypass' && GOAL_TOOLS.has(e.toolName)
    && UUID.test(e.eventId) && UUID.test(e.goalId)
    && IDENTIFIER.test(e.workspaceId) && STATUS.has(e.goalStatus)
    && (e.decisionRecorded === undefined || typeof e.decisionRecorded === 'boolean')
    && (e.nextStepRecorded === undefined || typeof e.nextStepRecorded === 'boolean')
    && Number.isSafeInteger(e.goalRevision) && e.goalRevision>=0;
}

export class ProductionGoalMemoryBoundary {
  private readonly options:Required<Pick<ProductionGoalMemoryOptions,'getSelectedScope'|'getPersistedGoal'|'getAuthorizedBank'|'requestApproval'|'journal'>>;
  private readonly fetchImpl:HttpFetch;
  constructor(input?:ProductionGoalMemoryOptions){
    if(!input) throw Error('Host authority not configured');
    if(input.endpoint!==undefined && input.endpoint!==BACKEND) throw Error('Production memory endpoint rejected');
    for(const fn of [input.getSelectedScope,input.getPersistedGoal,input.getAuthorizedBank,input.requestApproval]) {
      if(typeof fn!=='function') throw Error('Host authority not configured');
    }
    if(!input.journal || ['begin','markDispatched','settle'].some(name=>typeof (input.journal as unknown as Record<string,unknown>)[name]!=='function')) {
      throw Error('Host durable idempotency journal required');
    }
    this.options=input;
    this.fetchImpl=input.fetchImpl ?? (fetch as HttpFetch);
  }
  async recordGoalEvent(e:GoalCheckpointEvent):Promise<CheckpointOutcome>{
    if(!validEvent(e)) return outcome('skipped','invalid_or_untrusted_event');
    const kind=classifyGoalEvent(e.toolName,e.goalStatus,e.decisionRecorded===true,e.nextStepRecorded===true);
    if(kind===null) return outcome('skipped','non_milestone_transition');
    const opts=this.options;
    const scope=await trustedRead(opts.getSelectedScope,undefined);
    if(scope===null||scope.workspaceId!==e.workspaceId||!IDENTIFIER.test(scope.workspaceId)||!scope.realRootPath) return outcome('skipped','selected_project_mismatch');
    const goal=await trustedRead(opts.getPersistedGoal,e.goalId);
    if(!goal||goal.id!==e.goalId||goal.workspaceId!==e.workspaceId||goal.status!==e.goalStatus||goal.revision!==e.goalRevision) return outcome('skipped','committed_goal_not_verified');
    if (e.decisionRecorded===true && goal.decisionRecorded!==true) return outcome('skipped','committed_decision_not_verified');
    if (e.nextStepRecorded===true && goal.nextStepRecorded!==true) return outcome('skipped','committed_next_step_not_verified');
    const bankId=await trustedRead(opts.getAuthorizedBank,scope.workspaceId);
    if(typeof bankId!=='string'||!IDENTIFIER.test(bankId)) return outcome('skipped','authorized_bank_unavailable');
    // Only the authoritative persisted Goal supplies content, never the signed
    // envelope or a caller-generated Tool Activity payload.
    const decision = kind === 'decision' ? safeMilestoneText(goal.decisionSummary) : null;
    // One committed revision can contain a decision AND a next step. Store
    // both in the same approved document, rather than losing the next step.
    const next = (kind === 'next_step' || kind === 'decision') ? safeMilestoneText(goal.nextStepSummary) : null;
    const terminal = kind === 'completed' || kind === 'blocker'
      ? safeMilestoneText(goal.terminalSummary) : null;
    if (kind === 'decision' && decision === null) return outcome('skipped','unsafe_or_missing_decision_summary');
    if (kind === 'next_step' && next === null) return outcome('skipped','unsafe_or_missing_next_step_summary');
    const key=digest([scope.workspaceId,e.goalId,e.goalRevision,e.toolName,kind].join('\n'));
    const documentId='upm-goal-'+key.slice(0,42);
    const content=[
      'Project checkpoint v1',
      `Kind: ${kind}`,
      `Summary: ${decision ?? next ?? terminal ?? `Host-confirmed ${e.toolName}; status=${e.goalStatus}; goal=${e.goalId}`}`,
      `Evidence: goal-revision:${e.goalRevision}; call:${e.eventId}`,
      `Next: ${next ?? 'not included in this event'}`,
    ].join('\n');
    const payloadHash=digest(content);
    let begun=false,dispatched=false;
    const result:CheckpointOutcome=outcome('skipped','not_sent');
    const assign=(status:CheckpointState,reason:string):CheckpointOutcome=>{
      result.status=status;result.reason=reason;
      return result;
    };
    try{
      begun=await opts.journal.begin({key,payloadHash,workspaceId:e.workspaceId,goalId:e.goalId,bankId,documentId});
      if(!begun) return assign('skipped','event_already_attempted_durable');
      const approved=await opts.requestApproval({toolName:'automatic_project_checkpoint_memory',mutationKind:'bounded_write',
        workspaceId:scope.workspaceId,workspaceRoot:scope.realRootPath,
        reason:'One scoped Goal lifecycle checkpoint to existing Hindsight Production bank',
        summary:`bank=${bankId}\ndocument_id=${documentId}\nkind=${kind}\ngoal=${e.goalId}\nrevision=${e.goalRevision}\ncontent=${content}`});
      if(approved!==true)return assign('skipped','native_approval_denied');
      if(!scopeMatches(scope,await opts.getSelectedScope()))return assign('skipped','workspace_changed_after_approval');
      const latest=await opts.getPersistedGoal(e.goalId);
      if(!latest||latest.workspaceId!==e.workspaceId||latest.status!==e.goalStatus||latest.revision!==e.goalRevision
        ||(decision!==null && safeMilestoneText(latest.decisionSummary)!==decision)
        ||(next!==null && safeMilestoneText(latest.nextStepSummary)!==next)
        ||(terminal!==null && safeMilestoneText(latest.terminalSummary)!==terminal)
        ||(e.decisionRecorded===true && latest.decisionRecorded!==true)
        ||(e.nextStepRecorded===true && latest.nextStepRecorded!==true)) return assign('skipped','goal_changed_after_approval');
      if(await opts.getAuthorizedBank(scope.workspaceId)!==bankId)return assign('skipped','bank_mapping_changed');
      const base=`${BACKEND}/v1/default/banks/${bankId}`;
      const stats=await this.fetchImpl(base+'/stats',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10_000)});
      if(stats.status!==200)return assign('skipped','existing_bank_not_confirmed');
      const now=await opts.getPersistedGoal(e.goalId);
      if(!scopeMatches(scope,await opts.getSelectedScope())||await opts.getAuthorizedBank(scope.workspaceId)!==bankId
        ||!now||now.workspaceId!==e.workspaceId||now.status!==e.goalStatus||now.revision!==e.goalRevision
        ||(decision!==null && safeMilestoneText(now.decisionSummary)!==decision)
        ||(next!==null && safeMilestoneText(now.nextStepSummary)!==next)
        ||(terminal!==null && safeMilestoneText(now.terminalSummary)!==terminal)
        ||(e.decisionRecorded===true && now.decisionRecorded!==true)
        ||(e.nextStepRecorded===true && now.nextStepRecorded!==true)) {
        return assign('skipped','host_authority_changed_during_probe');
      }
      await opts.journal.markDispatched(key);
      dispatched=true;
      const response=await this.fetchImpl(base+'/memories',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
        headers:{'content-type':'application/json'},
        body:JSON.stringify({async:false,items:[{content,document_id:documentId,update_mode:'replace',tags:['project-checkpoint',`kind:${kind}`,'host-observed']}]})});
      if(response.status<200||response.status>=300)return assign('indeterminate','write_http_not_confirmed_do_not_retry');
      const rawReply=await response.json();
      const reply=(typeof rawReply==='object'&&rawReply!==null?rawReply:null) as {success?:unknown;items_count?:unknown}|null;
      if(reply?.success!==true||reply.items_count!==1)return assign('indeterminate','write_receipt_not_confirmed_do_not_retry');
      const readback=await this.fetchImpl(base+'/documents/'+documentId,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10_000)});
      if(readback.status!==200)return assign('indeterminate','document_readback_unavailable');
      const rawDocument=await readback.json();
      const doc=(typeof rawDocument==='object'&&rawDocument!==null?rawDocument:null) as {id?:unknown;bank_id?:unknown;original_text?:unknown}|null;
      if(doc?.id!==documentId||doc.bank_id!==bankId||doc.original_text!==content)return assign('indeterminate','document_readback_mismatch');
      result.status='verified';delete result.reason;
      result.kind=kind;result.documentId=documentId;result.bankId=bankId;result.contentHash=payloadHash;
      return result;
    }catch{
      return assign('indeterminate',dispatched?'post_or_readback_unverified_do_not_retry':'host_or_journal_unavailable');
    }finally{
      if(begun){
        try{await opts.journal.settle({key,state:dispatched?(result.status==='verified'?'verified':'uncertain'):'no_write',
          receiptHash:result.status==='verified'?payloadHash:null});}
        catch{
          assign('indeterminate','journal_settlement_unverified');
          delete result.kind;delete result.documentId;delete result.bankId;delete result.contentHash;
        }
      }
    }
  }
}
