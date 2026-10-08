import { expect, it } from 'vitest';
import { inspectGitFileBytes } from './git-file-inspection.js';
it('supports UTF-8, Thai text and extensionless files without discarding data',()=>{
  expect(inspectGitFileBytes(Buffer.from('ภาษาไทย\n0\n'), 'new/no-extension'))
    .toMatchObject({kind:'text',text:'ภาษาไทย\n0\n',extension:''});
  expect(inspectGitFileBytes(Buffer.from('id,name\n001,ไทย'), 'new/file.csv').kind).toBe('text');
});
it('detects binary regardless of extension and keeps typed metadata for every file',()=>{
  expect(inspectGitFileBytes(Buffer.from([0x50,0x4b,3,4,0,0,0,0]), 'new/report.xlsx'))
    .toMatchObject({kind:'binary',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  expect(inspectGitFileBytes(Buffer.from([0x00,0x01,0xff]),'code.ts').kind).toBe('binary');
  expect(inspectGitFileBytes(Buffer.from([0x00,0xff,0x10]),'scene.glb'))
    .toMatchObject({kind:'binary',mimeType:'model/gltf-binary'});
  expect(inspectGitFileBytes(Buffer.from([0x25,0x50,0x44,0x46,0x2d]),'document.pdf').kind).toBe('binary');
});
it('recognizes UTF-16 BOM, ignores invalid UTF-8 and treats images as image preview only',()=>{
  expect(inspectGitFileBytes(Buffer.from([0xff,0xfe,0x41,0,0x42,0]),'data.txt'))
    .toMatchObject({kind:'text',text:'AB'});
  expect(inspectGitFileBytes(Buffer.from([0xc3,0x28]),'bad.txt').kind).toBe('binary');
  expect(inspectGitFileBytes(Buffer.from([0x89,0x50,0x4e,0x47]),'new.png').kind).toBe('image');
});
