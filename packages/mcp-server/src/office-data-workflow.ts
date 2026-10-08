import { randomUUID } from 'node:crypto';
import { link, readFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { digest, loadOfficeTable, OfficeFileError, preflightXlsxZip, reject, safeOfficePath, OFFICE_DATA_LIMITS } from './office-file-provider.js';

export interface OfficeFinding {
  readonly sheet: string; readonly address: string;
  readonly kind: 'duplicate_key' | 'missing' | 'required_column' | 'formula_error' | 'unknown_calculation' | 'mismatch';
  readonly message: string;
}
export interface OfficeAuditRequest {
  readonly workspaceId: string; readonly inputPath: string;
  readonly sheet?: string; readonly keyColumns: readonly string[];
  readonly requiredColumns?: readonly string[];
  readonly scanCellLimit?: number; readonly maxFindings?: number;
}
export interface OfficeAuditResult {
  readonly provider: 'file_csv' | 'file_xlsx';
  readonly fidelity: 'typed_values_no_calculation';
  readonly supportedFeatures: readonly string[];
  readonly unsupportedFeatures: readonly string[];
  readonly findings: readonly OfficeFinding[];
  readonly stats: { readonly rowCount: number; readonly duplicateCount: number; readonly missingCount: number };
  readonly scannedRows: number; readonly scannedCells: number;
  readonly coverage: 'complete' | 'partial';
  readonly inputHash: string; readonly sheet: string; readonly truncated: boolean;
}
export interface OfficeComparisonRequest {
  readonly workspaceId: string; readonly leftPath: string; readonly rightPath: string;
  readonly sheet?: string; readonly maxFindings?: number;
}
export interface OfficeComparisonResult {
  readonly findings: readonly OfficeFinding[]; readonly mismatchCount: number;
  readonly coverage: 'complete' | 'partial'; readonly leftHash: string; readonly rightHash: string;
  readonly provider: 'typed_file_comparison';
}
export interface OfficeReportRequest {
  readonly workspaceId: string; readonly inputPath: string; readonly templatePath: string;
  readonly mappingPath: string; readonly outputPath: string;
  readonly keyColumns: readonly string[]; readonly signal?: AbortSignal;
}
export interface OfficeReportResult {
  readonly outputPath: string; readonly sha256: string; readonly sizeBytes: number;
  readonly provider: 'file_xlsx'; readonly fidelity: 'typed_values_no_calculation';
  readonly verification: 'verified'; readonly coverage: 'complete' | 'partial';
  readonly inputHashes: Readonly<Record<string,string>>;
  readonly checks: readonly string[];
}
export type OfficeRootResolver = (workspaceId: string) => Promise<string | null>;

export class OfficeDataWorkflowService {
  public constructor(private readonly root: OfficeRootResolver) {}
  private async workspace(workspaceId: string): Promise<string> {
    if (!workspaceId) reject('INVALID_INPUT','workspaceId required');
    const root = await this.root(workspaceId);
    if (!root) reject('INVALID_INPUT','Registered workspace not found');
    return root;
  }
  public async audit(_actor: unknown, request: OfficeAuditRequest, signal?: AbortSignal): Promise<Result<OfficeAuditResult>> {
    try {
      const root = await this.workspace(request.workspaceId);
      if (!Array.isArray(request.keyColumns) || !request.keyColumns.every((name)=>typeof name === 'string' && name.length > 0 && name.length <= 256)) {
        reject('INVALID_INPUT','keyColumns must be nonempty strings');
      }
      if (request.requiredColumns !== undefined && (!Array.isArray(request.requiredColumns)
        || !request.requiredColumns.every((name)=>typeof name === 'string' && name.length > 0 && name.length <= 256))) {
        reject('INVALID_INPUT','requiredColumns invalid');
      }
      const maxFindings = request.maxFindings ?? OFFICE_DATA_LIMITS.defaultFindings;
      if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > OFFICE_DATA_LIMITS.maxFindings) reject('INVALID_INPUT','maxFindings out of range');
      const table = await loadOfficeTable(root,request.inputPath,{ ...(request.sheet === undefined ? {} : { sheet:request.sheet }),
        ...(request.scanCellLimit === undefined ? {} : { scanCellLimit:request.scanCellLimit }), ...(signal===undefined?{}:{signal}) });
      const findings: OfficeFinding[] = [];
      let omitted = false;
      const add = (finding:OfficeFinding): void => {
        if (findings.length < maxFindings) findings.push(finding);
        else omitted = true;
      };
      const required = new Set([...request.keyColumns,...(request.requiredColumns??[])]);
      for (const name of required) {
        if (!table.headers.includes(name)) add({sheet:table.sheet,address:'1:1',kind:'required_column',message:`Required column missing: ${name}`});
      }
      const indexes = request.keyColumns.map((name)=>table.headers.indexOf(name));
      const seen = new Set<string>();
      let duplicateCount = 0;
      let missingCount = 0;
      const width = table.headers.length;
      for (const row of table.rows) {
        let rowMissing = false;
        for (let col=0;col<width;col++) {
          const entry = row.values[col]??{kind:'empty'};
          const address = `${columnLetter(col+1)}${row.index}`;
          if (entry.kind==='empty') {
            missingCount++; rowMissing=true;
            add({sheet:table.sheet,address,kind:'missing',message:`Empty cell in ${table.headers[col]}`});
          } else if (entry.kind==='error') {
            add({sheet:table.sheet,address,kind:'formula_error',message:'Excel formula/cached cell error'});
          } else if (entry.kind==='formula' && entry.calculated===false) {
            add({sheet:table.sheet,address,kind:'unknown_calculation',message:'Formula has no cached result. Result unknown; not recalculated.'});
          }
        }
        if (indexes.length > 0 && indexes.every((index)=>index>=0)) {
          const key = JSON.stringify(indexes.map((index)=>row.values[index]??{kind:'empty'}));
          if (seen.has(key)) { duplicateCount++; add({sheet:table.sheet,address:`A${row.index}`,kind:'duplicate_key',message:'Duplicate exact typed key'}); }
          else seen.add(key);
        }
        if (rowMissing && signal?.aborted) reject('CONFLICT','Audit cancelled');
      }
      return ok({
        provider:table.provider, fidelity:'typed_values_no_calculation',
        supportedFeatures:['typed_cells','exact_keys','missing','cached_formula_errors'],
        unsupportedFeatures:['formula_recalculation','macro_execution','external_connections'],
        findings, stats:{rowCount:table.scannedRows,duplicateCount,missingCount},
        scannedRows:table.scannedRows,scannedCells:table.scannedCells,
        sheet:table.sheet, inputHash:table.inputHash, truncated:table.truncated||omitted,
        coverage:table.truncated||omitted?'partial':'complete',
      });
    } catch(error) { return officeFailure(error); }
  }
  public async compare(_actor: unknown,request: OfficeComparisonRequest,signal?:AbortSignal):Promise<Result<OfficeComparisonResult>> {
    try {
      const root=await this.workspace(request.workspaceId);
      const max=request.maxFindings??200;
      if (!Number.isInteger(max)||max<1||max>1000) reject('INVALID_INPUT','maxFindings invalid');
      const opts={...(request.sheet===undefined?{}:{sheet:request.sheet}),...(signal===undefined?{}:{signal})};
      const left=await loadOfficeTable(root,request.leftPath,opts);
      const right=await loadOfficeTable(root,request.rightPath,opts);
      const findings:OfficeFinding[]=[];
      let mismatches=0;
      const note=(address:string,message:string):void => {
        mismatches++;
        if(findings.length<max) findings.push({sheet:left.sheet,address,kind:'mismatch',message});
      };
      const headers=Math.max(left.headers.length,right.headers.length);
      for (let i=0;i<headers;i++) if (left.headers[i]!==right.headers[i]) note(`${columnLetter(i+1)}1`,'Header differs');
      const total=Math.max(left.rows.length,right.rows.length);
      for(let r=0;r<total;r++) {
        if(signal?.aborted) reject('CONFLICT','Comparison cancelled');
        const a=left.rows[r],b=right.rows[r];
        const width=Math.max(a?.values.length??0,b?.values.length??0);
        for(let c=0;c<width;c++){
          if(JSON.stringify(a?.values[c]??{kind:'empty'})!==JSON.stringify(b?.values[c]??{kind:'empty'})) note(`${columnLetter(c+1)}${r+2}`,'Typed cell value or formula differs');
        }
      }
      if(left.workbook&&right.workbook) {
        const a=left.workbook.getWorksheet(left.sheet)!,b=right.workbook.getWorksheet(right.sheet)!;
        if(JSON.stringify(a.model.merges)!==JSON.stringify(b.model.merges)) note('merges','Merged ranges differ');
        for(let r=1;r<=Math.max(a.rowCount,b.rowCount);r++){
          const rowA=a.getRow(r),rowB=b.getRow(r);
          if(rowA.height!==rowB.height) note(`row:${r}`,'Row height differs');
          for(let c=1;c<=Math.max(a.columnCount,b.columnCount);c++){
            if(rowA.getCell(c).numFmt!==rowB.getCell(c).numFmt) note(`${columnLetter(c)}${r}`,'Number format differs');
          }
        }
        for(let c=1;c<=Math.max(a.columnCount,b.columnCount);c++){
          if(a.getColumn(c).width!==b.getColumn(c).width) note(`column:${columnLetter(c)}`,'Column width differs');
        }
      }
      return ok({findings,mismatchCount:mismatches,
        coverage:left.truncated||right.truncated||mismatches>max?'partial':'complete',
        leftHash:left.inputHash,rightHash:right.inputHash,provider:'typed_file_comparison'});
    }catch(error){return officeFailure(error)}
  }
  public async createReport(_actor:unknown,request:OfficeReportRequest):Promise<Result<OfficeReportResult>> {
    let temp:string|undefined;
    try {
      if(request.signal?.aborted) reject('CONFLICT','Report cancelled');
      const root=await this.workspace(request.workspaceId);
      const input=await safeOfficePath(root,request.inputPath);
      const template=await safeOfficePath(root,request.templatePath);
      const mapping=await safeOfficePath(root,request.mappingPath);
      const output=await safeOfficePath(root,request.outputPath,true);
      if(new Set([input,template,mapping,output]).size!==4) reject('CONFLICT','Input/template/mapping/output identities collide');
      if(path.extname(output).toLowerCase()!=='.xlsx'||path.extname(template).toLowerCase()!=='.xlsx') reject('INVALID_INPUT','Report uses a new XLSX output and XLSX template');
      const mappingBytes=await readFile(mapping);
      if(mappingBytes.length>16384) reject('FILE_TOO_LARGE','Mapping exceeds 16 KiB');
      let config:unknown;
      try{config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(mappingBytes))}catch{reject('INVALID_INPUT','Invalid UTF-8 mapping JSON')}
      const validated=parseMapping(config);
      const templateBytes=await readFile(template);
      preflightXlsxZip(templateBytes);
      // ExcelJS does not guarantee preservation of all native Office structures.
      const unsupported=['xl/charts/','xl/pivotTables/','xl/externalLinks/','xl/drawings/','xl/embeddings/','xl/activeX/','vbaProject.bin','xl/media/'];
      if(unsupported.some((segment)=>templateBytes.includes(Buffer.from(segment)))) reject('UNSUPPORTED_PLATFORM','Template uses charts, pivots, external links, drawings, images, macros or embedded content. Use the native Office provider.');
      const inputBytes=await readFile(input);
      const before={input:digest(inputBytes),template:digest(templateBytes),mapping:digest(mappingBytes)};
      const audit=await this.audit(_actor,{workspaceId:request.workspaceId,inputPath:request.inputPath,keyColumns:request.keyColumns},request.signal);
      if(!audit.ok)return audit;
      const data=audit.value;
      const wb=new ExcelJS.Workbook();
      await wb.xlsx.readFile(template);
      if(wb.worksheets.some((sheet)=>Boolean((sheet.model as unknown as {sheetProtection?:unknown}).sheetProtection))) reject('UNSUPPORTED_PLATFORM','Protected templates require native Office');
      const assigned: {sheet:string,address:string,value:string|number}[]=[];
      for(const cell of validated.cells){
        const sheet=wb.getWorksheet(cell.sheet);
        if(!sheet) reject('INVALID_INPUT',`Mapping sheet missing: ${cell.sheet}`);
        const value=cell.source==='stats.rowCount'?data.stats.rowCount:cell.source==='stats.duplicateCount'?data.stats.duplicateCount:data.stats.missingCount;
        sheet.getCell(cell.address).value=value;
        assigned.push({sheet:cell.sheet,address:cell.address,value});
      }
      for(const table of validated.tables){
        const sheet=wb.getWorksheet(table.sheet);
        if(!sheet) reject('INVALID_INPUT',`Mapping sheet missing: ${table.sheet}`);
        const start=sheet.getCell(table.startCell);
        const baseRow=start.row,baseCol=start.col;
        for(let i=0;i<data.findings.length&&i<5000;i++){
          for(let j=0;j<table.columns.length;j++){
            const key=table.columns[j]!;
            sheet.getCell(baseRow+i,baseCol+j).value=String(data.findings[i]![key]);
          }
        }
      }
      if(request.signal?.aborted) reject('CONFLICT','Report cancelled');
      temp=path.join(path.dirname(output),`.${path.basename(output)}.${randomUUID()}.lnwjud-tmp`);
      await wb.xlsx.writeFile(temp);
      const bytes=await readFile(temp);
      if(bytes.length>OFFICE_DATA_LIMITS.inputBytes) reject('FILE_TOO_LARGE','Generated report exceeds file provider limit');
      preflightXlsxZip(bytes);
      const verified=new ExcelJS.Workbook();
      await verified.xlsx.readFile(temp);
      if(JSON.stringify(verified.worksheets.map((s)=>s.name))!==JSON.stringify(wb.worksheets.map((s)=>s.name))) reject('CONFLICT','Report sheets changed on readback');
      for(const entry of assigned) {
        if(verified.getWorksheet(entry.sheet)?.getCell(entry.address).value!==entry.value) reject('CONFLICT','Report mapped cell failed typed readback');
      }
      if(request.signal?.aborted) reject('CONFLICT','Report cancelled');
      for (const [name,filename] of [['input',input],['template',template],['mapping',mapping]] as const) {
        if(digest(await readFile(filename))!==before[name]) reject('CONFLICT','Input/template/mapping changed during report');
      }
      // A hardlink fails when the user created the target meanwhile. No overwrites or rename races.
      await link(temp,output);
      const size=(await stat(output)).size;
      return ok({outputPath:output,sha256:digest(bytes),sizeBytes:size,provider:'file_xlsx',
        fidelity:'typed_values_no_calculation',verification:'verified',coverage:data.coverage,
        inputHashes:before,checks:['input_hash_unchanged','template_hash_unchanged','mapping_hash_unchanged','readback_typed_cells','new_output_only']});
    } catch(error){return officeFailure(error)}
    finally {if(temp)await unlink(temp).catch(()=>undefined)}
  }
}
function columnLetter(index:number):string {
  let output='';
  for(let current=index;current>0;current=Math.floor((current-1)/26)) output=String.fromCharCode(65+(current-1)%26)+output;
  return output;
}
interface Mapping {
  schemaVersion:1;
  cells: {sheet:string;address:string;source:'stats.rowCount'|'stats.duplicateCount'|'stats.missingCount'}[];
  tables:{sheet:string;startCell:string;columns:('sheet'|'address'|'kind'|'message')[]}[];
}
function parseMapping(value:unknown):Mapping {
  if(typeof value!=='object'||value===null||Array.isArray(value))reject('INVALID_INPUT','Invalid mapping');
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some((key)=>!['schemaVersion','cells','tables'].includes(key))||raw.schemaVersion!==1
    ||!Array.isArray(raw.cells)||raw.cells.length>200||!Array.isArray(raw.tables)||raw.tables.length>10) {
    reject('INVALID_INPUT','Invalid mapping schema');
  }
  const validSheet=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=31;
  const validAddress=(value:unknown):value is string=>typeof value==='string'&&/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(value);
  const validCells=raw.cells.every((item:unknown)=>{
    if(typeof item!=='object'||item===null||Array.isArray(item))return false;
    const cell=item as Record<string,unknown>;
    return validSheet(cell.sheet)&&validAddress(cell.address)&&['stats.rowCount','stats.duplicateCount','stats.missingCount'].includes(String(cell.source))
      &&Object.keys(cell).every((k)=>['sheet','address','source'].includes(k));
  });
  const validTables=raw.tables.every((item:unknown)=>{
    if(typeof item!=='object'||item===null||Array.isArray(item))return false;
    const table=item as Record<string,unknown>;
    return validSheet(table.sheet)&&validAddress(table.startCell)&&Array.isArray(table.columns)
      &&table.columns.length<=4&&table.columns.length>0
      &&table.columns.every((key:unknown)=>['sheet','address','kind','message'].includes(String(key)))
      &&Object.keys(table).every((k)=>['sheet','startCell','columns'].includes(k));
  });
  if(!validCells||!validTables)reject('INVALID_INPUT','Invalid report mapping cell/table');
  return value as Mapping;
}
function officeFailure(error:unknown):Result<never> {
  const known=error instanceof OfficeFileError?error:null;
  return err(appError(known?.code??'INVALID_INPUT',known?.message??'Office file workflow failed'));
}
