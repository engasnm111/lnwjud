import { expect, it } from 'vitest';
import type { GitStatusEntrySummary } from '@lnwjud/ipc-contracts';
import { filterGitFiles, gitFileFolder, gitFolderCounts } from './git-file-browser.js';
it('lists every untracked file, including nested any-extension and dotfiles, never collapses folder',()=>{
  const entries=[
    'new/picture.png','new/model.glb','new/sub/data.xlsx','new/sub/.env','new/README',
  ].map((path)=>({path,kind:'untracked',indexStatus:'?',worktreeStatus:'?'})) as GitStatusEntrySummary[];
  expect(filterGitFiles(entries,'','all').map(x=>x.path)).toHaveLength(5);
  expect(filterGitFiles(entries,'xlsx','all').map(x=>x.path)).toEqual(['new/sub/data.xlsx']);
  expect([...gitFolderCounts(entries)]).toEqual([['new',3],['new/sub',2]]);
  expect(gitFileFolder('new/sub/.env')).toBe('new/sub');
});
it('distinguishes index, worktree and untracked statuses',()=>{
 const entries=[
 {path:'staged.txt',kind:'modified',indexStatus:'M',worktreeStatus:' '},
 {path:'working.txt',kind:'modified',indexStatus:' ',worktreeStatus:'M'},
 {path:'new.glb',kind:'untracked',indexStatus:'?',worktreeStatus:'?'},
 ];
 expect(filterGitFiles(entries,'','staged').map(e=>e.path)).toEqual(['staged.txt']);
 expect(filterGitFiles(entries,'','unstaged').map(e=>e.path)).toEqual(['working.txt']);
 expect(filterGitFiles(entries,'','untracked').map(e=>e.path)).toEqual(['new.glb']);
});
