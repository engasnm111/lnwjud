/**
 * Github Actions-only. Single fixed managed ref and PR. Never force-pushes,
 * rebases, approves CI, or touches dev/main on the remote.
 */
import { appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { MANAGED_RUNTIME_REF, MANAGED_RUNTIME_MARKER, MANAGED_RUNTIME_PR_TITLE,
  classifyRuntimePullRequests, planRuntimeDependencyUpdate } from './runtime-dependency-pr.mjs';

const PIN_FILE = 'apps/desktop/src/main/runtime-dependencies.json';
const MANAGED_REMOTE_REF = 'refs/heads/' + MANAGED_RUNTIME_REF;
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const GH_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function runCommand(name,args,allowedCodes=[0]) {
  const command = spawnSync(name,args,{encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
  if(!allowedCodes.includes(command.status) || command.error){
    const reason=String(command.stderr??'').slice(0,1200);
    throw new Error(`${name} ${args[0]??''} exited ${command.status}: ${reason}`);
  }
  return { stdout:command.stdout.trim(),status:command.status };
}
function jsonCommand(name,args) {
  const result=runCommand(name,args).stdout;
  try{return JSON.parse(result)}catch{throw new Error(`Invalid JSON from ${name} ${args[0]}`)}
}
function remoteManagedHead() {
  const result=runCommand('git',['ls-remote','--exit-code','--heads','origin',MANAGED_REMOTE_REF],[0,2]);
  if(result.status===2)return null;
  const sha=result.stdout.split(/\s+/)[0];
  if(!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Unverified managed remote ref');
  return sha;
}
function ensureAutomatedCheckout() {
  if(process.env.GITHUB_ACTIONS!=='true' || !GH_REPOSITORY_PATTERN.test(process.env.GITHUB_REPOSITORY??'')
    || process.env.GH_TOKEN === undefined){
    throw new Error('Managed dependency updater requires a GitHub Actions repository and GITHUB_TOKEN');
  }
  const active=runCommand('git',['branch','--show-current']).stdout;
  if(active!=='dev')throw new Error('Managed updater must start on dev');
  const dirty=runCommand('git',['status','--porcelain','--untracked-files=all']).stdout.split('\n').filter(Boolean);
  if(dirty.some((entry)=>entry.slice(3).replaceAll('\\','/')!==PIN_FILE)) {
    throw new Error('Updater checkout contains unowned changes');
  }
}
function verifyBotOnlyBranch() {
  const delta=runCommand('git',['diff','--name-only','origin/dev...HEAD']).stdout.split('\n').filter(Boolean);
  if(delta.some((file)=>file!==PIN_FILE)) throw new Error('Managed branch contains changes outside runtime manifest');
  const authors=runCommand('git',['log','--format=%ae','origin/dev..HEAD']).stdout.split('\n').filter(Boolean);
  if(authors.some((email)=>email!==BOT_EMAIL)) throw new Error('Managed branch has commits from unrecognized author');
}
async function record(note) {
  process.stdout.write(note+'\n');
  if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,note+'\n','utf8');
}
export async function applyManagedRuntimePr() {
  ensureAutomatedCheckout();
  const repository=process.env.GITHUB_REPOSITORY;
  if(!repository)throw new Error('Missing repository');
  const prs=jsonCommand('gh',['pr','list','--state','open','--base','dev','--limit','100','--json','number,headRefName,baseRefName,isCrossRepository,headRefOid,headRepository,author,body']);
  const classified=classifyRuntimePullRequests(prs,repository);
  const remote=remoteManagedHead();
  const state=classified.conflict
    ? {changed:true,branchOwnership:'foreign',openPr:null,legacyOpenPrCount:classified.legacyOpenPrCount}
    : {changed:true,branchOwnership:remote===null?'absent':classified.managed?'managed':'foreign',
      openPr:classified.managed?{number:classified.managed.number,managed:true,headSha:classified.managed.headRefOid}:null,
      legacyOpenPrCount:classified.legacyOpenPrCount};
  const decision=planRuntimeDependencyUpdate(state);
  if(decision.action==='blocked') throw new Error(`Runtime dependency bot blocked: ${decision.reason}. Preserve refs/PRs for maintainer review.`);
  if(decision.action==='none') {await record('No new pinned runtime update.');return}
  runCommand('git',['config','user.name','github-actions[bot]']);
  runCommand('git',['config','user.email',BOT_EMAIL]);
  if(decision.action==='create'){
    if(remote!==null)throw new Error('Managed ref appeared after initial read');
    runCommand('git',['switch','-c',MANAGED_RUNTIME_REF]);
  }else{
    if(remote!==decision.expectedHeadSha)throw new Error('Managed branch head moved; no update attempted');
    // Discard only the pin diff produced by this workflow in a fresh CI checkout.
    runCommand('git',['restore','--',PIN_FILE]);
    runCommand('git',['fetch','origin',MANAGED_REMOTE_REF]);
    runCommand('git',['switch','-c',MANAGED_RUNTIME_REF,'--track','origin/'+MANAGED_RUNTIME_REF]);
    runCommand('git',['fetch','origin','dev']);
    verifyBotOnlyBranch();
    runCommand('git',['merge','--no-edit','origin/dev']);
    verifyBotOnlyBranch();
    // Recalculate the verified pins after integrating the current authoritative dev.
    runCommand('node',['scripts/update-runtime-dependencies.mjs','--write']);
  }
  const changed=runCommand('git',['diff','--quiet','--',PIN_FILE],[0,1]).status===1;
  if(!changed){await record('Managed branch already contains the current verified pins. No push.');return}
  const verify=[
    ['corepack',['pnpm@10.15.0','install','--frozen-lockfile']],
    ['corepack',['pnpm@10.15.0','test:version']],
    ['corepack',['pnpm@10.15.0','--filter','@lnwjud/desktop','typecheck']],
    ['corepack',['pnpm@10.15.0','--filter','@lnwjud/desktop','build']],
    ['corepack',['pnpm@10.15.0','test:packaging']],
  ];
  for(const [name,args] of verify) runCommand(name,args);
  runCommand('git',['add','--',PIN_FILE]);
  const staged=runCommand('git',['diff','--cached','--name-only']).stdout.split('\n').filter(Boolean);
  if(staged.length!==1||staged[0]!==PIN_FILE)throw new Error('Unexpected staged bot files');
  runCommand('git',['commit','-m','chore: update verified runtime dependencies']);
  const head=runCommand('git',['rev-parse','HEAD']).stdout;
  if(!/^[a-f0-9]{40}$/i.test(head))throw new Error('Cannot prove exact bot source SHA');
  // Normal fast-forward. No reset or force-push of any branch.
  runCommand('git',['push','origin',`HEAD:${MANAGED_REMOTE_REF}`]);
  const body=[
    MANAGED_RUNTIME_MARKER,
    'One managed runtime dependency PR against dev.',
    'Pinned assets: validated SHA-256, upstream checksums and available provenance assets.',
    'Checked: pnpm frozen-lockfile, version contract, Desktop typecheck/build, packaging contract.',
    `Source SHA: ${head}`,
    'CI status: awaiting exact-head CI; no merge or approval is automatic.',
  ].join('\n\n');
  if(decision.action==='create'){
    runCommand('gh',['pr','create','--base','dev','--head',MANAGED_RUNTIME_REF,'--title',MANAGED_RUNTIME_PR_TITLE,'--body',body]);
  }else{
    runCommand('gh',['pr','edit',String(decision.prNumber),'--body',body]);
  }
  const list=jsonCommand('gh',['pr','list','--state','open','--base','dev','--limit','100','--json','number,headRefName,baseRefName,isCrossRepository,headRefOid,headRepository,author,body']);
  const after=classifyRuntimePullRequests(list,repository);
  if(after.conflict || !after.managed || after.managed.headRefOid!==head) {
    throw new Error('Managed PR verification failed at exact pushed SHA');
  }
  const number=after.managed.number;
  await record(`Managed dependency PR #${number}; exact head ${head}; CI not yet verified.`);
  // GITHUB_TOKEN PR events may not trigger CI. workflow_dispatch is explicit.
  runCommand('gh',['workflow','run','ci.yml','--ref',MANAGED_RUNTIME_REF]);
  const runs=jsonCommand('gh',['run','list','--workflow','ci.yml','--branch',MANAGED_RUNTIME_REF,'--limit','20','--json','databaseId,headSha,status,conclusion,url,event']);
  const matching=runs.filter((item)=>item.headSha===head);
  if(matching.length===0){
    await record('CI dispatch requested. Awaiting exact-head run visibility or maintainer approval, not passed.');
  }else{
    for(const run of matching) await record(`CI run ${run.databaseId}: ${run.status} / ${run.conclusion??'pending'} ${run.url}`);
  }
}
if(process.argv.includes('--apply')) {
  applyManagedRuntimePr().catch((error)=>{ process.stderr.write(String(error instanceof Error?error.message:error)+'\n');process.exitCode=1; });
}
