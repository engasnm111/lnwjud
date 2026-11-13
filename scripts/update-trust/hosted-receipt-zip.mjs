import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

// Data-only inspector for a SHA-256-checked GitHub receipt ZIP. No extraction,
// filesystem writes, signer authority or attestation verification occurs here.
const maximumArchive = 32 * 1024 * 1024;
const limits = new Map([['receipt.json', 2048], ['receipt.bundle.json', 16 * 1024 * 1024]]);
const refuse = () => { throw new Error('HOSTED_RECEIPT_ZIP_REFUSED'); };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extras(bytes) {
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) refuse();
    const id = bytes.readUInt16LE(at), length = bytes.readUInt16LE(at + 2);
    if (id === 1 || at + 4 + length > bytes.length) refuse(); // ZIP64 is excluded.
    at += 4 + length;
  }
}

function readArchive(reader) {
  if (!Number.isSafeInteger(reader?.size) || reader.size < 22
    || reader.size > maximumArchive || typeof reader.readAt !== 'function') refuse();
  const chunks = [Buffer.alloc(0)];
  for (let at = 0; at < reader.size; at += 1024 * 1024) {
    const count = Math.min(1024 * 1024, reader.size - at);
    const chunk = reader.readAt(at, count);
    if (!Buffer.isBuffer(chunk) || chunk.length !== count) refuse();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function inspect(bytes) {
  const endAt = bytes.length - 22;
  if (bytes.readUInt32LE(endAt) !== 0x06054b50
    || bytes.readUInt16LE(endAt + 4) !== 0 || bytes.readUInt16LE(endAt + 6) !== 0
    || bytes.readUInt16LE(endAt + 8) !== 2 || bytes.readUInt16LE(endAt + 10) !== 2
    || bytes.readUInt16LE(endAt + 20) !== 0) refuse();
  const centralSize = bytes.readUInt32LE(endAt + 12);
  const centralAt = bytes.readUInt32LE(endAt + 16);
  if (centralSize < 94 || centralSize > 65536 || centralAt > endAt
    || centralAt + centralSize !== endAt) refuse();

  const entries = new Map();
  let at = centralAt;
  for (let index = 0; index < 2; index++) {
    if (at + 46 > endAt || bytes.readUInt32LE(at) !== 0x02014b50) refuse();
    const os = bytes.readUInt16LE(at + 4) >>> 8;
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const checksum = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20);
    const expanded = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const disk = bytes.readUInt16LE(at + 34);
    const internal = bytes.readUInt16LE(at + 36);
    const external = bytes.readUInt32LE(at + 38);
    const localAt = bytes.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > endAt || nameLength < 1 || commentLength !== 0 || disk !== 0 || internal !== 0
      || (flags & ~0x808) !== 0 || ![0, 8].includes(method)
      || ![0, 3].includes(os) || compressed < 1 || expanded < 1
      || compressed > maximumArchive || localAt >= centralAt
      || (os === 3 && (external >>> 16) !== 0 && ((external >>> 16) & 0xf000) !== 0x8000)
      || (os === 0 && (external & 0x10) !== 0)) refuse();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = [...limits.keys()].find(item => nameBytes.equals(Buffer.from(item)));
    if (name === undefined) throw new Error('HOSTED_RECEIPT_ZIP_REFUSED');
    const limit = limits.get(name) ?? 0;
    if (entries.has(name) || limit === 0 || expanded > limit
      || (method === 0 && compressed !== expanded)) refuse();
    extras(bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    if (localAt + 30 > centralAt || bytes.readUInt32LE(localAt) !== 0x04034b50
      || bytes.readUInt16LE(localAt + 6) !== flags
      || bytes.readUInt16LE(localAt + 8) !== method
      || bytes.readUInt16LE(localAt + 26) !== nameLength) refuse();
    const localExtra = bytes.readUInt16LE(localAt + 28);
    const localNameAt = localAt + 30;
    if (localNameAt + nameLength + localExtra > centralAt
      || !bytes.subarray(localNameAt, localNameAt + nameLength).equals(nameBytes)) refuse();
    extras(bytes.subarray(localNameAt + nameLength, localNameAt + nameLength + localExtra));
    const descriptor = Boolean(flags & 8);
    for (const [offset, value] of [[14, checksum], [18, compressed], [22, expanded]]) {
      const localValue = bytes.readUInt32LE(localAt + offset);
      if (localValue !== value && !(descriptor && localValue === 0)) refuse();
    }
    const dataAt = localNameAt + nameLength + localExtra;
    const dataEnd = dataAt + compressed;
    if (dataEnd > centralAt) refuse();
    let extent = dataEnd;
    if (descriptor) {
      if (extent + 12 > centralAt) refuse();
      const signature = bytes.readUInt32LE(extent) === 0x08074b50;
      if (signature) extent += 4;
      if (extent + 12 > centralAt || bytes.readUInt32LE(extent) !== checksum
        || bytes.readUInt32LE(extent + 4) !== compressed
        || bytes.readUInt32LE(extent + 8) !== expanded) refuse();
      extent += 12;
    }
    const payload = bytes.subarray(dataAt, dataEnd);
    let decoded;
    try {
      decoded = method === 0 ? Buffer.from(payload)
        : inflateRawSync(payload, { maxOutputLength: limit });
    } catch { refuse(); }
    if (decoded.length !== expanded || crc32(decoded) !== checksum) refuse();
    entries.set(name, { localAt, extent, bytes: decoded });
    at = next;
  }
  if (at !== endAt || entries.size !== 2) refuse();
  const sorted = [...entries.values()].sort((a, b) => a.localAt - b.localAt);
  if (sorted[0].localAt !== 0 || sorted[0].extent !== sorted[1].localAt
    || sorted[1].extent !== centralAt) refuse();
  return { receiptBytes: entries.get('receipt.json').bytes,
    bundleBytes: entries.get('receipt.bundle.json').bytes };
}

/** Inspect only the two exact receipt members of an already digest-checked ZIP. */
export function inspectHostedReceiptZip(reader) {
  try { return inspect(readArchive(reader)); } catch { refuse(); }
}
