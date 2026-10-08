import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GitAdapter } from './git-adapter.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))});
it('shows exact contents of a newly created nested directory, not the directory name',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'lnwjud-git-list-'));
  roots.push(root);
  const init=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8'});
  if(init.status!==0)throw new Error(`git unavailable: ${init.stderr}`);
  const nested=path.join(root,'new-folder','nested');
  await mkdir(nested,{recursive:true});
  await writeFile(path.join(root,'.gitignore'),'*.cache\n');
  await writeFile(path.join(root,'new-folder','สินค้าไทย.txt'),'การนำเข้า\n');
  await writeFile(path.join(nested,'layout.glb'),Buffer.from([0,1,2]));
  await writeFile(path.join(nested,'report.xlsx'),Buffer.from([0x50,0x4b,3,4]));
  await writeFile(path.join(nested,'.env'),'SECRET=not-real\n');
  await writeFile(path.join(nested,'omit.cache'),'ignored\n');
  const result=await new GitAdapter().statusSummary(root);
  if(!result.ok)throw new Error(result.error.message);
  const files=result.value.entries.map(item=>item.path.replaceAll('\\','/'));
  expect(files).toEqual(expect.arrayContaining([
    '.gitignore','new-folder/สินค้าไทย.txt','new-folder/nested/layout.glb',
    'new-folder/nested/report.xlsx','new-folder/nested/.env',
  ]));
  expect(files).not.toContain('new-folder/');
  expect(files).not.toContain('new-folder/nested/');
  expect(files).not.toContain('new-folder/nested/omit.cache');
  expect(files).toHaveLength(5);
});
