import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse';

export const OFFICE_DATA_LIMITS = {
  inputBytes: 25 * 1024 * 1024,
  zipInflatedBytes: 128 * 1024 * 1024,
  zipEntries: 10_000,
  maxRecordBytes: 1024 * 1024,
  maxFieldBytes: 64 * 1024,
  defaultCells: 100_000,
  maxCells: 1_000_000,
  defaultFindings: 200,
  maxFindings: 1000,
} as const;

export type OfficeDataProvider = 'file_csv' | 'file_xlsx';
export type OfficeValue = { kind: 'empty' } | { kind: 'text' | 'number' | 'boolean' | 'date' | 'formula' | 'error' | 'other'; value: string; formula?: string; calculated?: boolean };
export interface OfficeDataRow { readonly index: number; readonly values: readonly OfficeValue[] }
export interface OfficeTable {
  readonly provider: OfficeDataProvider;
  readonly workbook?: ExcelJS.Workbook;
  readonly sheet: string;
  readonly headers: readonly string[];
  readonly rows: readonly OfficeDataRow[];
  readonly totalRowsSeen: number;
  readonly scannedRows: number;
  readonly scannedCells: number;
  readonly truncated: boolean;
  readonly inputHash: string;
}
export class OfficeFileError extends Error {
  public constructor(public readonly code: 'INVALID_INPUT' | 'FILE_TOO_LARGE' | 'CONFLICT' | 'UNSUPPORTED_PLATFORM', message: string) {
    super(message);
  }
}
export function reject(code: OfficeFileError['code'], message: string): never {
  throw new OfficeFileError(code, message);
}

function inside(root: string, destination: string): boolean {
  const relative = path.relative(root, destination);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
/** Input identities must be canonical. Output parents must already exist and stay within the workspace. */
export async function safeOfficePath(root: string, filename: string, output = false): Promise<string> {
  if (!filename || filename.length > 4096 || filename.includes('\0')) reject('INVALID_INPUT','Invalid file path');
  const canonicalRoot = await realpath(root);
  const lexical = path.resolve(canonicalRoot, filename);
  if (!inside(canonicalRoot, lexical)) reject('INVALID_INPUT', 'File is outside workspace');
  if (output) {
    const parent = await realpath(path.dirname(lexical));
    if (!inside(canonicalRoot, parent)) reject('INVALID_INPUT','Output parent escapes workspace');
    const candidate = path.join(parent, path.basename(lexical));
    try {
      await lstat(candidate);
      reject('CONFLICT','Output already exists; replacement recovery must be used for overwrite');
    } catch (error) {
      if (error instanceof OfficeFileError) throw error;
      if (!isNoEntry(error)) throw error;
    }
    return candidate;
  }
  const canonical = await realpath(lexical);
  if (!inside(canonicalRoot, canonical)) reject('INVALID_INPUT','Input file escapes workspace');
  const file = await stat(canonical);
  if (!file.isFile()) reject('INVALID_INPUT','Input must be a regular file');
  if (file.size > OFFICE_DATA_LIMITS.inputBytes) reject('FILE_TOO_LARGE','Input exceeds 25 MiB file-provider limit');
  return canonical;
}
function isNoEntry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Read ZIP central-directory metadata before decompressing an XLSX. ZIP64 and multi-disk archives are unsupported. */
export function preflightXlsxZip(bytes: Buffer): void {
  if (bytes.length < 22 || !bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) {
    reject('INVALID_INPUT','XLSX is not a normal ZIP archive');
  }
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) reject('INVALID_INPUT','XLSX ZIP central directory missing');
  const entries = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
    || bytes.readUInt16LE(eocd + 8) !== entries || entries === 0
    || entries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF
    || entries > OFFICE_DATA_LIMITS.zipEntries || cdOffset + cdSize > eocd) {
    reject('FILE_TOO_LARGE','XLSX ZIP uses unsupported size/entry or multi-disk format');
  }
  let offset = cdOffset;
  let inflated = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) reject('INVALID_INPUT','Invalid ZIP central directory entry');
    const entrySize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    if ((flags & 1) !== 0 || (compression !== 0 && compression !== 8)) reject('UNSUPPORTED_PLATFORM','Encrypted or unsupported XLSX ZIP entry');
    inflated += entrySize;
    if (inflated > OFFICE_DATA_LIMITS.zipInflatedBytes || entrySize === 0xFFFFFFFF) reject('FILE_TOO_LARGE','XLSX exceeds 128 MiB uncompressed limit');
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocd) reject('INVALID_INPUT','Malformed ZIP directory entry');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) reject('INVALID_INPUT','Unsafe workbook ZIP entry');
    offset = entryEnd;
  }
  if (offset !== cdOffset + cdSize) reject('INVALID_INPUT','Unexpected central directory size');
}
export function cellValue(value: ExcelJS.CellValue | undefined): OfficeValue {
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  if (typeof value === 'string') return { kind:'text', value };
  if (typeof value === 'number') return { kind:'number', value:String(value) };
  if (typeof value === 'boolean') return { kind:'boolean', value: String(value) };
  if (value instanceof Date) return { kind:'date', value:value.toISOString() };
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const formula = 'formula' in value ? String(value.formula) : String(value.sharedFormula);
      const result = 'result' in value ? value.result : undefined;
      if (result === undefined || result === null) return { kind:'formula',value:'',formula,calculated:false };
      if (typeof result === 'object' && result !== null && 'error' in result) return { kind:'error', value:String(result.error),formula,calculated:true };
      return { kind:'formula',value:String(result),formula,calculated:true };
    }
    if ('error' in value) return { kind:'error', value:String(value.error) };
    if ('text' in value) return { kind:'text', value:String(value.text) };
    if ('richText' in value && Array.isArray(value.richText)) {
      return { kind:'text',value:value.richText.map((segment)=>segment.text).join('') };
    }
  }
  return { kind:'other',value:'[structured value]' };
}
export async function loadOfficeTable(root: string, filename: string, options?: {
  readonly sheet?: string; readonly scanCellLimit?: number; readonly signal?: AbortSignal;
}): Promise<OfficeTable> {
  if (options?.signal?.aborted) reject('CONFLICT','Office audit cancelled');
  const name = await safeOfficePath(root,filename);
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.csv' && ext !== '.xlsx') reject('UNSUPPORTED_PLATFORM','File provider supports only CSV and XLSX');
  const maxCells = options?.scanCellLimit ?? OFFICE_DATA_LIMITS.defaultCells;
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > OFFICE_DATA_LIMITS.maxCells) reject('INVALID_INPUT','Invalid scanCellLimit');
  const raw = await readFile(name);
  const inputHash = digest(raw);
  const rows: OfficeDataRow[] = [];
  let headers: string[] = [];
  let scannedCells = 0;
  let scannedRows = 0;
  let totalRowsSeen = 0;
  let truncated = false;
  let sheet = options?.sheet ?? '';
  let workbook: ExcelJS.Workbook | undefined;
  const ingest = (index: number, values: OfficeValue[]): void => {
    if (options?.signal?.aborted) reject('CONFLICT','Office audit cancelled');
    if (index === 1) {
      headers = values.map((item)=>item.kind === 'empty' ? '' : item.value);
      if (headers.some((header)=>header.length === 0) || new Set(headers).size !== headers.length) reject('INVALID_INPUT','Missing or duplicate column headers');
      if (headers.length > maxCells) reject('FILE_TOO_LARGE','Header exceeds scanCellLimit');
      scannedCells += headers.length;
      return;
    }
    totalRowsSeen++;
    if (truncated || scannedCells + values.length > maxCells) { truncated = true; return; }
    scannedCells += values.length; scannedRows++;
    rows.push({ index,values });
  };
  if (ext === '.csv') {
    // Validate UTF-8 strictly. Silent replacement characters would corrupt Thai columns/keys.
    try { new TextDecoder('utf-8',{fatal:true}).decode(raw); }
    catch { reject('INVALID_INPUT','CSV is not UTF-8. Select/convert the encoding explicitly.'); }
    if (options?.sheet && options.sheet !== 'CSV') reject('INVALID_INPUT','CSV has only the CSV sheet');
    sheet = 'CSV';
    const stream = createReadStream(name).pipe(parse({
      bom:true, relax_quotes:false, skip_empty_lines:false, max_record_size:OFFICE_DATA_LIMITS.maxRecordBytes,
    }));
    let line = 0;
    try {
      for await (const record of stream) {
        line++;
        if (!Array.isArray(record)) reject('INVALID_INPUT','Invalid CSV record');
        const fields = record as unknown[];
        if (fields.length > 16_384 || fields.some((field)=>typeof field !== 'string' || Buffer.byteLength(field) > OFFICE_DATA_LIMITS.maxFieldBytes)) {
          reject('FILE_TOO_LARGE','CSV has oversized field or record');
        }
        if (line > 1 && fields.length !== headers.length) reject('INVALID_INPUT','Inconsistent CSV column count');
        ingest(line, fields.map((field)=>field === '' ? {kind:'empty'} : {kind:'text',value:String(field)}));
      }
    } finally { stream.destroy(); }
  } else {
    preflightXlsxZip(raw);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(name);
    const target: ExcelJS.Worksheet | undefined = options?.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];
    if (!target) reject('INVALID_INPUT','XLSX sheet not found');
    sheet = target.name;
    for (let index=1;index<=target.rowCount;index++) {
      const row = target.getRow(index);
      const values: OfficeValue[] = Array.from({length:Math.max(target.columnCount,1)},(_,col)=>cellValue(row.getCell(col+1).value));
      ingest(index,values);
    }
  }
  if (headers.length === 0) reject('INVALID_INPUT','Input data has no header row');
  return {provider:ext === '.csv'?'file_csv':'file_xlsx',...(workbook ? {workbook}:{}),
    sheet,headers,rows,totalRowsSeen,scannedRows,scannedCells,truncated,inputHash};
}
