import { readFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { MANAGED_RUNTIME_REF, isManagedRuntimePr } from './runtime-dependency-pr.mjs';

const ref='refs/heads/'+MANAGED_RUNTIME_REF;
export function planRuntimeDependencyCleanup(state){
  if(!state || !state.merged || !state.sameRepository || !state.managedIdentity || state.baseRef!=='dev' || state.headRef!==MANAGED_RUNTIME_REF
    || !/^[a-f0-9]{40}$/i.test(state.expectedHeadSha??''))return {action:'blocked',reason:'invalid_or_foreign_identity'};
  if(state.remoteHeadSha===null)return {action:'none',reason:'already_absent'};
  if(typeof state.remoteHeadSha!=='string'||state.remoteHeadSha!==state.expectedHeadSha)return {action:'blocked',reason:'changed_remote_head'};
  if(!state.mergedHeadAncestorOfDev)return {action:'blocked',reason:'head_not_ancestor_of_dev'};
  if(!Number.isInteger(state.otherOpenPrsUsingHead)||state.otherOpenPrsUsingHead!==0)return {action:'blocked',reason:'branch_still_in_use'};
  return {action:'delete',expectedHeadSha:state.expectedHeadSha};
}
function cmd(name,args,codes=[0]){
  const res=spawnSync(name,args,{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
  if(!codes.includes(res.status)||res.error)throw new Error(`${name} ${args[0]??''} failed: ${String(res.stderr??'').slice(0,1000)}`);
  return {status:res.status,stdout:res.stdout.trim()};
}
function json(name,args){return JSON.parse(cmd(name,args).stdout)}
async function receipt(message){
  process.stdout.write(message+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,message+'\n');
}
export async function cleanupManagedRuntimeRef(){
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.GITHUB_EVENT_PATH||!process.env.GITHUB_REPOSITORY||!process.env.GH_TOKEN){
    throw new Error('Cleanup must run inside trusted GitHub Actions with an event and GITHUB_TOKEN');
  }
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const pr=event.pull_request;
  if(!pr || pr.merged!==true || pr.base?.ref!=='dev' || pr.head?.ref!==MANAGED_RUNTIME_REF
    || pr.head?.repo?.full_name!==process.env.GITHUB_REPOSITORY || pr.base?.repo?.full_name!==process.env.GITHUB_REPOSITORY){
    await receipt('No exact merged same-repository managed dependency PR. Nothing was deleted.');
    return;
  }
  const number=pr.number;
  if(!Number.isInteger(number)||number<1)throw new Error('Invalid PR identity in event');
  const fresh=json('gh',['pr','view',String(number),'--json','number,headRefName,baseRefName,headRefOid,isCrossRepository,headRepository,author,body,mergedAt']);
  const managedIdentity=isManagedRuntimePr(fresh,process.env.GITHUB_REPOSITORY) && fresh.mergedAt !== null
    && fresh.headRefOid===pr.head.sha;
  const remoteResult=cmd('git',['ls-remote','--exit-code','--heads','origin',ref],[0,2]);
  const remoteHead=remoteResult.status===2?null:remoteResult.stdout.split(/\s+/)[0];
  const prs=json('gh',['pr','list','--state','open','--limit','100','--json','headRefName,headRepository,isCrossRepository']);
  const inUse=prs.filter((candidate)=>candidate.headRefName===MANAGED_RUNTIME_REF).length;
  cmd('git',['fetch','origin','dev']);
  const ancestor=managedIdentity
    ? cmd('git',['merge-base','--is-ancestor',pr.head.sha,'origin/dev'],[0,1]).status===0 : false;
  const decision=planRuntimeDependencyCleanup({
    merged:true,sameRepository:true,managedIdentity,baseRef:'dev',headRef:MANAGED_RUNTIME_REF,
    expectedHeadSha:pr.head.sha,remoteHeadSha:remoteHead,mergedHeadAncestorOfDev:ancestor,otherOpenPrsUsingHead:inUse,
  });
  if(decision.action==='none'){await receipt('Managed dependency ref is already absent. Idempotent cleanup complete.');return;}
  if(decision.action!=='delete')throw new Error(`Managed dependency ref preserved: ${decision.reason}`);
  const lease=`--force-with-lease=${ref}:${decision.expectedHeadSha}`;
  cmd('git',['push',lease,'origin',`:${ref}`]);
  const check=cmd('git',['ls-remote','--exit-code','--heads','origin',ref],[0,2]);
  if(check.status!==2)throw new Error('Managed dependency ref still present after conditional deletion');
  await receipt(`Deleted only ${ref} at reviewed merged head ${decision.expectedHeadSha}.`);
}
if(process.argv.includes('--apply')){
  cleanupManagedRuntimeRef().catch((error)=>{process.stderr.write(String(error instanceof Error?error.message:error)+'\n');process.exitCode=1;});
}
