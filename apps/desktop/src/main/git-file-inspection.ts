import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface GitFileInspection {
  readonly kind: 'text' | 'image' | 'binary' | 'too_large' | 'missing';
  readonly sizeBytes: number | null;
  readonly extension: string;
  readonly mimeType: string | null;
  readonly text?: string;
}
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const mediaTypes: Readonly<Record<string,string>> = {
  '.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':'application/vnd.ms-excel','.xlsm':'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip':'application/zip','.7z':'application/x-7z-compressed','.rar':'application/vnd.rar',
  '.gz':'application/gzip','.tar':'application/x-tar','.exe':'application/vnd.microsoft.portable-executable',
  '.dll':'application/vnd.microsoft.portable-executable','.sqlite':'application/vnd.sqlite3',
  '.db':'application/octet-stream','.glb':'model/gltf-binary','.gltf':'model/gltf+json',
  '.fbx':'application/octet-stream','.blend':'application/octet-stream','.obj':'text/plain',
  '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac',
};
const imageExtensions=new Set(['.png','.jpeg','.jpg','.gif','.webp','.bmp','.ico','.svg','.avif','.heic','.heif']);
function knownBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0) ||
    (bytes.length>=4 && ((bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4)
    || (bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46)
    || (bytes[0]===0x7f&&bytes[1]===0x45&&bytes[2]===0x4c&&bytes[3]===0x46)));
}
export function inspectGitFileBytes(bytes: Uint8Array, filename: string): GitFileInspection {
  const extension=path.extname(filename).toLowerCase();
  const mimeType=mediaTypes[extension] ?? (imageExtensions.has(extension)?'image/*':null);
  const base={sizeBytes:bytes.byteLength,extension,mimeType};
  if (imageExtensions.has(extension)) return {...base,kind:'image'};
  // A file may be named .csv, .ts, or extensionless; trust bytes not the suffix.
  const utf16Bom = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (!utf16Bom && knownBinary(bytes)) return {...base,kind:'binary'};
  let text: string;
  try {
    const decoder = bytes.length>=2 && bytes[0]===0xff && bytes[1]===0xfe
      ? new TextDecoder('utf-16le',{fatal:true})
      : bytes.length>=2 && bytes[0]===0xfe && bytes[1]===0xff
        ? new TextDecoder('utf-16be',{fatal:true})
        : new TextDecoder('utf-8',{fatal:true});
    text=decoder.decode(bytes).replace(/^\uFEFF/,'');
  } catch { return {...base,kind:'binary'}; }
  if ([...text].some((character) => { const code = character.charCodeAt(0); return code < 32 && code !== 9 && code !== 10 && code !== 13; })) return {...base,kind:'binary'};
  return {...base,kind:'text',text};
}
export async function inspectGitWorkingFile(filePath: string | undefined, filename: string): Promise<GitFileInspection> {
  const extension=path.extname(filename).toLowerCase();
  const fallback={kind:'missing' as const,sizeBytes:null,extension,mimeType:mediaTypes[extension]??null};
  if (!filePath) return fallback;
  try {
    const metadata=await stat(filePath);
    if(!metadata.isFile())return fallback;
    if(metadata.size>MAX_TEXT_BYTES)return {
      kind:'too_large',sizeBytes:metadata.size,extension,mimeType:mediaTypes[extension]??null,
    };
    const bytes=await readFile(filePath);
    return inspectGitFileBytes(bytes,filename);
  } catch { return fallback; }
}
