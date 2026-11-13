import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';

const MAX_ARCHIVE = 5 * 1024 ** 3;
const decoder = new TextDecoder('utf-8', { fatal: true });
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refuse = () => { throw new Error('SIGNING_ARCHIVE_STRUCTURE_REFUSED'); };

function read(reader, offset, count) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0
    || count > 1024 * 1024 || offset > reader.size || count > reader.size - offset) refuse();
  const result = reader.readAt(offset, count);
  if (!Buffer.isBuffer(result) || result.length !== count) refuse();
  return result;
}

function checkExtra(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) refuse();
    const type = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    if (type === 1 || offset + 4 + size > bytes.length) refuse();
    offset += 4 + size;
  }
}

function safeName(bytes) {
  let text;
  try { text = decoder.decode(bytes); } catch { refuse(); }
  if (text === 'manifest.json') return text;
  if (!/^files\/(?:candidate|predecessor)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)
    || /[. ]$/.test(text) || /\/(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(text)) refuse();
  return text;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});
function crc32(initial, bytes) {
  let crc = initial;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function entries(reader) {
  if (!Number.isSafeInteger(reader?.size) || reader.size < 22 || reader.size > MAX_ARCHIVE
    || typeof reader.readAt !== 'function' || typeof reader.stream !== 'function') refuse();
  // shortcut: only single-disk, uncompressed, non-ZIP64 archives with no comment;
  // widen this format only after checking the real GitHub-hosted archive producer.
  const tail = read(reader, reader.size - 22, 22);
  if (tail.readUInt32LE(0) !== 0x06054b50 || tail.readUInt16LE(4) !== 0 || tail.readUInt16LE(6) !== 0
    || tail.readUInt16LE(8) !== tail.readUInt16LE(10) || tail.readUInt16LE(20) !== 0) refuse();
  const count = tail.readUInt16LE(10), size = tail.readUInt32LE(12), start = tail.readUInt32LE(16);
  if (count < 1 || count > 9 || size < 46 || size > 32768
    || start > reader.size - 22 || size !== reader.size - 22 - start) refuse();
  const central = read(reader, start, size);
  const found = new Map(); let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) refuse();
    const os = central.readUInt16LE(cursor + 4) >>> 8;
    const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
    const checksum = central.readUInt32LE(cursor + 16);
    const compressed = central.readUInt32LE(cursor + 20), expanded = central.readUInt32LE(cursor + 24);
    const nameSize = central.readUInt16LE(cursor + 28), extraSize = central.readUInt16LE(cursor + 30);
    const commentSize = central.readUInt16LE(cursor + 32), disk = central.readUInt16LE(cursor + 34);
    const internal = central.readUInt16LE(cursor + 36), external = central.readUInt32LE(cursor + 38);
    const localOffset = central.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameSize + extraSize + commentSize;
    if (end > central.length || nameSize < 1 || commentSize !== 0 || disk !== 0 || internal !== 0
      || method !== 0 || compressed !== expanded || expanded === 0 || expanded === 0xffffffff
      || localOffset === 0xffffffff || (flags & ~0x808) !== 0 || ![0, 3].includes(os)
      || (os === 3 && (external >>> 16) !== 0 && ((external >>> 16) & 0xf000) !== 0x8000)
      || (os === 0 && (external & 0x10) !== 0)) refuse();
    const filenameBytes = central.subarray(cursor + 46, cursor + 46 + nameSize);
    checkExtra(central.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize));
    const filename = safeName(filenameBytes), normalized = filename.toLowerCase();
    if (found.has(normalized)) refuse();
    const local = read(reader, localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags
      || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameSize) refuse();
    const localExtra = local.readUInt16LE(28), localName = read(reader, localOffset + 30, nameSize);
    if (!filenameBytes.equals(localName)) refuse();
    checkExtra(read(reader, localOffset + 30 + nameSize, localExtra));
    const descriptor = Boolean(flags & 0x8);
    for (const [at, value] of [[14, checksum], [18, compressed], [22, expanded]])
      if (local.readUInt32LE(at) !== value && !(descriptor && local.readUInt32LE(at) === 0)) refuse();
    const contentStart = localOffset + 30 + nameSize + localExtra, contentEnd = contentStart + compressed;
    let extent = contentEnd;
    if (descriptor) {
      const withSignature = read(reader, contentEnd, 4).readUInt32LE(0) === 0x08074b50;
      const record = read(reader, contentEnd + (withSignature ? 4 : 0), 12);
      if (record.readUInt32LE(0) !== checksum || record.readUInt32LE(4) !== compressed
        || record.readUInt32LE(8) !== expanded) refuse();
      extent += withSignature ? 16 : 12;
    }
    if (extent > start) refuse();
    found.set(normalized, { filename, localOffset, contentStart, size: expanded, checksum, extent });
    cursor = end;
  }
  if (cursor !== central.length) refuse();
  const sorted = [...found.values()].sort((a, b) => a.localOffset - b.localOffset);
  if (sorted[0].localOffset !== 0 || sorted.at(-1).extent !== start) refuse();
  for (let i = 1; i < sorted.length; i++) if (sorted[i].localOffset !== sorted[i - 1].extent) refuse();
  return found;
}

async function hashEntry(reader, entry, keepBytes) {
  let length = 0, crc = 0xffffffff;
  const hash = createHash('sha256'), retained = [];
  for await (const chunk of reader.stream(entry.contentStart, entry.size)) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 1024 * 1024
      || chunk.length > entry.size - length) refuse();
    length += chunk.length;
    crc = crc32(crc, chunk);
    hash.update(chunk);
    if (keepBytes) retained.push(chunk);
  }
  if (length !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.checksum) refuse();
  return { sha256: hash.digest('hex'), bytes: keepBytes ? Buffer.concat(retained) : undefined };
}

/** A key-free, data-only check on a pinned, already SHA-256-validated archive. */
export async function inspectSigningArchive(reader, expectedManifestSha256, expectedSource) {
  // Caller must supply the independently observed source-run and tracked policy identity.
  // Never adopt a run or policy claimed only by the untrusted archive manifest.
  if (!sha256(expectedManifestSha256) || !expectedSource || typeof expectedSource !== 'object'
    || Array.isArray(expectedSource)
    || Object.keys(expectedSource).sort().join(',') !== 'policySha256,repositoryId,runAttempt,runId'
    || !/^[1-9][0-9]{0,14}$/.test(expectedSource.repositoryId)
    || !/^[1-9][0-9]{0,14}$/.test(expectedSource.runId)
    || !Number.isSafeInteger(Number(expectedSource.repositoryId))
    || !Number.isSafeInteger(Number(expectedSource.runId))
    || expectedSource.runAttempt !== 1 || !sha256(expectedSource.policySha256)
    || Object.keys(process.env).some(key => key.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
  const files = entries(reader);
  const top = files.get('manifest.json');
  if (!top || top.size > 32768) refuse();
  const manifestContents = await hashEntry(reader, top, true);
  if (manifestContents.sha256 !== expectedManifestSha256) refuse();
  let manifest;
  try { manifest = parseSigningVerificationManifest(manifestContents.bytes); } catch { refuse(); }
  if (manifest.verification.repositoryId !== expectedSource.repositoryId
    || manifest.verification.runId !== expectedSource.runId
    || manifest.verification.runAttempt !== expectedSource.runAttempt
    || manifest.policySha256 !== expectedSource.policySha256) refuse();
  const expected = new Map([['manifest.json', { name: 'manifest.json', sizeBytes: String(top.size), sha256: expectedManifestSha256 }]]);
  for (const [scope, roles] of [['candidate', manifest.candidate],
    ...(manifest.purpose === 'update' ? [['predecessor', manifest.predecessor]] : [])]) {
    for (const spec of Object.values(roles)) {
      const filename = `files/${scope}/${spec.name}`.toLowerCase();
      if (expected.has(filename)) refuse();
      expected.set(filename, { ...spec, name: `files/${scope}/${spec.name}` });
    }
  }
  if (expected.size !== files.size) refuse();
  for (const [filename, spec] of expected) {
    const file = files.get(filename);
    if (!file || file.filename !== spec.name || String(file.size) !== spec.sizeBytes) refuse();
    if (filename !== 'manifest.json' && (await hashEntry(reader, file, false)).sha256 !== spec.sha256) refuse();
  }
  return Object.freeze({ status: 'verified-archive-contents-only', manifestSha256: expectedManifestSha256,
    purpose: manifest.purpose, fileCount: files.size });
}
