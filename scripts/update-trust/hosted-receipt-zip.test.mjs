import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { inspectHostedReceiptZip } from './hosted-receipt-zip.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const receipt = Buffer.from('{"schema":"fixture"}');
const bundle = Buffer.from('{"bundle":"fixture"}');

function archive(files = [
  { name: 'receipt.json', bytes: receipt, method: 0 },
  { name: 'receipt.bundle.json', bytes: bundle, method: 8, descriptor: true },
]) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = file.method === 8 ? deflateRawSync(file.bytes) : file.bytes;
    const checksum = crc32(file.bytes), flags = file.descriptor ? 8 : 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(file.method, 8);
    if (!file.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(file.bytes.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(file.descriptor ? 16 : 0);
    if (file.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(file.bytes.length, 12);
    }
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(file.method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(file.external ?? 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    const localEntry = Buffer.concat([local, name, body, descriptor]);
    locals.push(localEntry);
    centrals.push(Buffer.concat([central, name]));
    offset += localEntry.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const reader = bytes => ({ size: bytes.length,
  readAt(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); } });
const reject = bytes => assert.throws(() => inspectHostedReceiptZip(reader(bytes)), /HOSTED_RECEIPT_ZIP_REFUSED/);

test('reads exact stored and DEFLATE receipt members, including a data descriptor', () => {
  const inspected = inspectHostedReceiptZip(reader(archive()));
  assert.deepEqual(inspected.receiptBytes, receipt);
  assert.deepEqual(inspected.bundleBytes, bundle);
});

test('rejects unknown, duplicate, missing and path-traversing ZIP members', () => {
  const first = { name: 'receipt.json', bytes: receipt, method: 0 };
  for (const files of [
    [first],
    [first, first],
    [first, { name: '../receipt.bundle.json', bytes: bundle, method: 8 }],
    [first, { name: 'receipt.bundle.json/', bytes: bundle, method: 8 }],
    [first, { name: 'receipt.bundle.json', bytes: bundle, method: 8 }, first],
  ]) reject(archive(files));
});

test('rejects tampered compressed data, CRC, symlink and malformed central directory', () => {
  const original = archive();
  const tampered = Buffer.from(original);
  const needle = deflateRawSync(bundle);
  const position = tampered.indexOf(needle);
  assert.ok(position > 0);
  tampered[position] ^= 0x40;
  reject(tampered);
  const symlink = archive([
    { name: 'receipt.json', bytes: receipt, method: 0, external: 0xa1ff0000 },
    { name: 'receipt.bundle.json', bytes: bundle, method: 8 },
  ]);
  reject(symlink);
  reject(Buffer.concat([original, Buffer.from('trailing')]));
  reject(original.subarray(0, original.length - 1));
  const oversized = Buffer.from(original);
  const centralAt = oversized.readUInt32LE(oversized.length - 22 + 16);
  oversized.writeUInt32LE(2049, centralAt + 24);
  reject(oversized);
});

test('refuses malformed native reader and truncated reads', () => {
  assert.throws(() => inspectHostedReceiptZip({ size: 32 * 1024 * 1024 + 1,
    readAt() { throw new Error('should not read'); } }), /HOSTED_RECEIPT_ZIP_REFUSED/);
  const bytes = archive();
  assert.throws(() => inspectHostedReceiptZip({ size: bytes.length,
    readAt() { return Buffer.alloc(0); } }), /HOSTED_RECEIPT_ZIP_REFUSED/);
});
