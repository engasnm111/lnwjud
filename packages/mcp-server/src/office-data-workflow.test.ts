import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { OfficeDataWorkflowService } from './office-data-workflow.js';
import { digest, loadOfficeTable, preflightXlsxZip } from './office-file-provider.js';

const roots:string[]=[];
async function workspace():Promise<{root:string;service:OfficeDataWorkflowService}> {
  const root=await mkdtemp(path.join(os.tmpdir(),'lnwjud-office-v580-'));
  roots.push(root);
  const service=new OfficeDataWorkflowService(async (id)=>id==='ws'?root:null);
  return {root,service};
}
afterEach(async()=>{await Promise.all(roots.splice(0).map((r)=>rm(r,{recursive:true,force:true})))});
describe('CSV and XLSX data audit provider',()=>{
  it('preserves Thai UTF-8 BOM, leading-zero text, quoted newline and exact duplicate keys without modifying source',async()=>{
    const {root,service}=await workspace();
    const filename=path.join(root,'thai.csv');
    const bytes=Buffer.from('\ufeffรหัส,ชื่อ,ยอด\r\n001,"มะม่วง\nสด",0\r\n002,ทดสอบ,\r\n001,ทดสอบ,0\r\n');
    await writeFile(filename,bytes);
    const result=await service.audit(null,{workspaceId:'ws',inputPath:'thai.csv',keyColumns:['รหัส'],requiredColumns:['รหัส','ชื่อ','ยอด']});
    expect(result).toMatchObject({ok:true,value:{provider:'file_csv',stats:{rowCount:3,duplicateCount:1,missingCount:1},coverage:'complete',scannedRows:3}});
    if(!result.ok)throw new Error(result.error.message);
    expect(result.value.findings.map((v)=>v.kind)).toEqual(['missing','duplicate_key']);
    const table=await loadOfficeTable(root,'thai.csv');
    expect(table.rows[0]?.values[0]).toEqual({kind:'text',value:'001'});
    expect(table.rows[0]?.values[1]).toEqual({kind:'text',value:'มะม่วง\nสด'});
    expect(table.rows[0]?.values[2]).toEqual({kind:'text',value:'0'});
    expect(digest(await readFile(filename))).toBe(digest(bytes));
  });
  it('rejects malformed encodings and traversal before misleading counts',async()=>{
    const {root,service}=await workspace();
    await writeFile(path.join(root,'bad.csv'),Buffer.from([0x80,0xff]));
    expect(await service.audit(null,{workspaceId:'ws',inputPath:'bad.csv',keyColumns:['id']})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(await service.audit(null,{workspaceId:'ws',inputPath:'../../escape.csv',keyColumns:['id']})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    await writeFile(path.join(root,'duplicate.csv'),'name,name\nx,y');
    expect(await service.audit(null,{workspaceId:'ws',inputPath:'duplicate.csv',keyColumns:['name']})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  });
  it('separates formula errors from unknown calculation results and preserves zero/false',async()=>{
    const {root,service}=await workspace();
    const wb=new ExcelJS.Workbook();const sheet=wb.addWorksheet('Data');
    sheet.addRow(['key','value','state']);
    sheet.addRow(['001',{formula:'2+2'},false]);
    sheet.addRow(['002',{formula:'1/0',result:{error:'#DIV/0!'}},0]);
    const filename=path.join(root,'input.xlsx');await wb.xlsx.writeFile(filename);
    const before=digest(await readFile(filename));
    const result=await service.audit(null,{workspaceId:'ws',inputPath:'input.xlsx',keyColumns:['key'],sheet:'Data'});
    expect(result).toMatchObject({ok:true,value:{provider:'file_xlsx',stats:{rowCount:2,duplicateCount:0,missingCount:0}}});
    if(!result.ok)throw new Error(result.error.message);
    expect(result.value.findings.map((v)=>v.kind)).toEqual(['unknown_calculation','formula_error']);
    expect(digest(await readFile(filename))).toBe(before);
  });
  it('bounds incomplete scan and rejects non-XLSX ZIP metadata',async()=>{
    const {root,service}=await workspace();
    await writeFile(path.join(root,'big.csv'),'id,value\n1,a\n2,b\n3,c');
    const partial=await service.audit(null,{workspaceId:'ws',inputPath:'big.csv',keyColumns:['id'],scanCellLimit:4});
    expect(partial).toMatchObject({ok:true,value:{coverage:'partial',truncated:true,scannedRows:1,stats:{rowCount:1}}});
    expect(()=>preflightXlsxZip(Buffer.from('not a zip'))).toThrow('XLSX is not a normal ZIP');
  });
});
describe('typed comparison and template reports',()=>{
  it('detects changed typed cells and preserve binary, number format and widths without rewriting inputs',async()=>{
    const {root,service}=await workspace();
    const a=new ExcelJS.Workbook();const b=new ExcelJS.Workbook();
    for(const [wb,numFmt,width] of [[a,'0.00',14],[b,'#,##0',20]] as const){
      const sheet=wb.addWorksheet('Data');
      sheet.addRow(['id','total']);sheet.addRow(['01',10]);
      sheet.getCell('B2').numFmt=numFmt;
      sheet.getColumn(2).width=width;
    }
    b.getWorksheet('Data')!.getCell('B2').value=11;
    const first=path.join(root,'first.xlsx'),second=path.join(root,'second.xlsx');
    await a.xlsx.writeFile(first);await b.xlsx.writeFile(second);
    const before=[digest(await readFile(first)),digest(await readFile(second))];
    const result=await service.compare(null,{workspaceId:'ws',leftPath:'first.xlsx',rightPath:'second.xlsx'});
    expect(result).toMatchObject({ok:true,value:{provider:'typed_file_comparison',coverage:'complete'}});
    if(!result.ok)throw new Error(result.error.message);
    expect(result.value.mismatchCount).toBeGreaterThanOrEqual(3);
    expect(result.value.findings.map((e)=>e.message)).toEqual(expect.arrayContaining([
      'Typed cell value or formula differs','Number format differs','Column width differs',
    ]));
    expect([digest(await readFile(first)),digest(await readFile(second))]).toEqual(before);
  });
  it('writes only new verified XLSX, preserves template/source hashes and refuses a second publish',async()=>{
    const {root,service}=await workspace();
    const input=path.join(root,'records.csv');
    const template=path.join(root,'reference.xlsx');
    const mapping=path.join(root,'map.json');
    const output=path.join(root,'output.xlsx');
    await writeFile(input,'id,name\n001,ไทย\n001,ไทย\n002,\n');
    const wb=new ExcelJS.Workbook();
    const summary=wb.addWorksheet('Summary');
    summary.getCell('A1').value='Reference';summary.getCell('A1').font={bold:true};
    const findings=wb.addWorksheet('Findings');
    findings.getCell('A1').value='Kind';
    await wb.xlsx.writeFile(template);
    await writeFile(mapping,JSON.stringify({schemaVersion:1,cells:[
      {sheet:'Summary',address:'B4',source:'stats.rowCount'},
      {sheet:'Summary',address:'C4',source:'stats.duplicateCount'},
    ],tables:[{sheet:'Findings',startCell:'A2',columns:['kind','address','message']}]}));
    const before=await Promise.all([input,template,mapping].map(async f=>digest(await readFile(f))));
    const request={workspaceId:'ws',inputPath:'records.csv',templatePath:'reference.xlsx',mappingPath:'map.json',
      outputPath:'output.xlsx',keyColumns:['id']} as const;
    const result=await service.createReport(null,request);
    expect(result).toMatchObject({ok:true,value:{verification:'verified',coverage:'complete',provider:'file_xlsx'}});
    if(!result.ok)throw new Error(result.error.message);
    const reread=new ExcelJS.Workbook();await reread.xlsx.readFile(output);
    expect(reread.getWorksheet('Summary')?.getCell('B4').value).toBe(3);
    expect(reread.getWorksheet('Summary')?.getCell('C4').value).toBe(1);
    expect(reread.getWorksheet('Findings')?.getCell('A2').value).toBe('duplicate_key');
    expect(reread.getWorksheet('Summary')?.getCell('A1').font.bold).toBe(true);
    expect(result.value.sha256).toBe(digest(await readFile(output)));
    expect([await stat(input),await stat(template),await stat(mapping)].every((s)=>s.isFile())).toBe(true);
    expect(await Promise.all([input,template,mapping].map(async f=>digest(await readFile(f))))).toEqual(before);
    expect(await service.createReport(null,request)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect((await readFile(output)).length).toBeGreaterThan(500);
  });
  it('fails closed on unsupported reference objects and invalid mapping without creating output',async()=>{
    const {root,service}=await workspace();
    await writeFile(path.join(root,'data.csv'),'id\n001');
    const wb=new ExcelJS.Workbook();const sheet=wb.addWorksheet('Summary');sheet.addRow(['Reference']);
    await wb.xlsx.writeFile(path.join(root,'reference.xlsx'));
    await writeFile(path.join(root,'map.json'),JSON.stringify({schemaVersion:1,cells:[{sheet:'Summary',address:'A1',source:'globalThis.secret'}],tables:[]}));
    const request={workspaceId:'ws',inputPath:'data.csv',templatePath:'reference.xlsx',mappingPath:'map.json',
      outputPath:'result.xlsx',keyColumns:['id']} as const;
    expect(await service.createReport(null,request)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    await expect(stat(path.join(root,'result.xlsx'))).rejects.toThrow();
  });
  it('cancellation before report preflight leaves source untouched and no output',async()=>{
    const {root,service}=await workspace();
    await writeFile(path.join(root,'source.csv'),'id\n001');
    const controller=new AbortController();controller.abort();
    expect(await service.createReport(null,{
      workspaceId:'ws',inputPath:'source.csv',templatePath:'unused.xlsx',mappingPath:'unused.json',
      outputPath:'never.xlsx',keyColumns:['id'],signal:controller.signal,
    })).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    await expect(stat(path.join(root,'never.xlsx'))).rejects.toThrow();
  });
});
