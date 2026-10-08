import type { GitStatusEntrySummary } from '@lnwjud/ipc-contracts';

export type GitFileStatusFilter = 'all' | 'staged' | 'unstaged' | 'untracked';
export function gitFileFolder(path: string): string {
  const end = path.replace(/\\/gu,'/').lastIndexOf('/');
  return end < 0 ? '.' : path.slice(0,end).replace(/\\/gu,'/');
}
/** File-complete, stable paths. No directory aggregation or skipped extensions. */
export function filterGitFiles(entries: readonly GitStatusEntrySummary[],
  query: string, filter: GitFileStatusFilter): readonly GitStatusEntrySummary[] {
  const needle=query.trim().toLocaleLowerCase();
  return entries.filter((file)=>{
    if(needle && !file.path.toLocaleLowerCase().includes(needle))return false;
    switch(filter){
      case 'staged':return file.indexStatus !== ' ' && file.indexStatus !== '?';
      case 'unstaged':return file.worktreeStatus !== ' ' && file.worktreeStatus !== '?';
      case 'untracked':return file.kind === 'untracked' || file.indexStatus === '?';
      default:return true;
    }
  }).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'}));
}
export function gitFolderCounts(entries: readonly GitStatusEntrySummary[]): ReadonlyMap<string,number>{
  const counts=new Map<string,number>();
  for(const entry of entries)counts.set(gitFileFolder(entry.path),(counts.get(gitFileFolder(entry.path))??0)+1);
  return counts;
}
