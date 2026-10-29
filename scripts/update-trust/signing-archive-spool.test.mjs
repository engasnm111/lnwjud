import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { ArchiveQuarantineError, withDownloadedSigningArchive } from './signing-archive-spool.mjs';

const windows = process.platform === 'win32' && process.arch === 'x64';
const addonPath = process.env.LNWJUD_ARCHIVE_PIN_TEST_ADDON
  ?? fileURLToPath(new URL('../../apps/desktop/build/native-containment/lnwjud-containment-pin.node', import.meta.url));
const addon = windows ? createRequire(import.meta.url)(path.resolve(addonPath)) : undefined;
const payload = Buffer.alloc(1024 * 1024 + 13, 0x61);
const hash = createHash('sha256').update(payload).digest('hex');
const artifact = Object.freeze({ artifactId: '12', archiveSha256: hash, archiveSizeBytes: payload.length });
const fetchFixture = async url => url.startsWith('https://api.github.com/')
  ? new globalThis.Response(null, { status: 302, headers: { location: 'https://productionresultssa8.blob.core.windows.net/a' } })
  : new globalThis.Response(payload);

function zipFixture() {
  const name = Buffer.from('manifest.json'), content = Buffer.from('{"fixture":true}');
  const compressed = deflateRawSync(content);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), descriptor = Buffer.alloc(16), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(content.length, 12);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x81a40000, 38);
  const directoryOffset = local.length + name.length + compressed.length + descriptor.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(directoryOffset, 16);
  return { bytes: Buffer.concat([local, name, compressed, descriptor, central, name, end]), content };
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-signing-spool-'));
  const filename = path.join(root, 'archive.zip');
  try { await run(filename); }
  finally { await unlink(filename).catch(() => undefined); await rmdir(root); }
}

test('downloads into one spool, seals before reading and closes the reader scope', { skip: !windows }, async () => {
  await fixture(async filename => {
    let saved;
    const result = await withDownloadedSigningArchive({ addon, filename, artifact, token: 'fixture', fetchImpl: fetchFixture }, async reader => {
      saved = reader;
      assert.equal(reader.size, payload.length);
      assert.deepEqual(reader.readAt(2, 8), payload.subarray(2, 10));
      const digest = createHash('sha256');
      for await (const chunk of reader.stream(0)) digest.update(chunk);
      const tail = [];
      for await (const chunk of reader.stream(reader.size - 5, 100)) tail.push(chunk);
      assert.deepEqual(Buffer.concat(tail), payload.subarray(-5));
      return digest.digest('hex');
    });
    assert.equal(result, hash);
    assert.throws(() => saved.readAt(0, 1), /SIGNING_ARCHIVE_READ_INVALID/);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
  });
});

test('serves an actual unzipper custom source through the retained handle', { skip: !windows }, async () => {
  await fixture(async filename => {
    const fixtureZip = zipFixture();
    const sha256 = createHash('sha256').update(fixtureZip.bytes).digest('hex');
    const source = { artifactId: '12', archiveSha256: sha256, archiveSizeBytes: fixtureZip.bytes.length };
    const fetchImpl = async url => url.startsWith('https://api.github.com/')
      ? new globalThis.Response(null, { status: 302, headers: { location: 'https://productionresultssa8.blob.core.windows.net/a' } })
      : new globalThis.Response(fixtureZip.bytes);
    const { Open } = createRequire(fileURLToPath(new URL('../../apps/desktop/package.json', import.meta.url)))('unzipper');
    const value = await withDownloadedSigningArchive({ addon, filename, artifact: source, token: 'fixture', fetchImpl }, async reader => {
      const archive = await Open.custom({ size: async () => reader.size, stream: (offset, length) => reader.stream(offset, length) });
      assert.equal(archive.files.length, 1);
      return archive.files[0].buffer();
    });
    assert.deepEqual(value, fixtureZip.content);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
  });
});

test('discards a failed download and never exposes a reader', { skip: !windows }, async () => {
  await fixture(async filename => {
    let called = false;
    await assert.rejects(withDownloadedSigningArchive({ addon, filename,
      artifact: { ...artifact, archiveSha256: '0'.repeat(64) }, token: 'fixture', fetchImpl: fetchFixture }, () => { called = true; }),
    /SIGNING_ARCHIVE_DOWNLOAD_REFUSED/);
    assert.equal(called, false);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
  });
});

test('rejects metadata size mismatch and key-bearing preflight without leaving a spool', { skip: !windows }, async () => {
  await fixture(async filename => {
    let called = false;
    await assert.rejects(withDownloadedSigningArchive({ addon, filename,
      artifact: { ...artifact, archiveSizeBytes: payload.length + 1 }, token: 'fixture', fetchImpl: fetchFixture }, () => { called = true; }),
    /SIGNING_ARCHIVE_SIZE_MISMATCH/);
    assert.equal(called, false);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
    const name = 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM', original = process.env[name];
    try {
      process.env[name] = 'fixture-only';
      await assert.rejects(withDownloadedSigningArchive({ addon, filename, artifact, token: 'fixture', fetchImpl: fetchFixture }, () => {}),
        /SIGNING_ARCHIVE_DOWNLOAD_REFUSED/);
      await assert.rejects(readFile(filename), { code: 'ENOENT' });
    } finally { if (original === undefined) delete process.env[name]; else process.env[name] = original; }
  });
});

test('refuses abandoned reader streams and preserves a thrown undefined', { skip: !windows }, async () => {
  await fixture(async filename => {
    let stream;
    await assert.rejects(withDownloadedSigningArchive({ addon, filename, artifact, token: 'fixture', fetchImpl: fetchFixture }, reader => {
      stream = reader.stream(0, 4);
      stream.destroy = () => { throw new Error('fixture override'); };
      assert.throws(() => { stream._destroy = () => {}; }, TypeError);
    }), /SIGNING_ARCHIVE_READ_INCOMPLETE/);
    assert.equal(stream.destroyed, true);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
    let caught = false;
    try { await withDownloadedSigningArchive({ addon, filename, artifact, token: 'fixture', fetchImpl: fetchFixture }, () => { throw undefined; }); }
    catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
    const primary = new Error('fixture consumer');
    await assert.rejects(withDownloadedSigningArchive({ addon, filename, artifact, token: 'fixture', fetchImpl: fetchFixture }, reader => {
      reader.stream(0, 4);
      throw primary;
    }), error => error === primary);
    await assert.rejects(readFile(filename), { code: 'ENOENT' });
  });
});

test('retains failed cleanup ownership and the original operation error', async () => {
  let failCleanup = true, closed = false;
  const spool = { write() {}, seal() {}, readAt() { return Buffer.alloc(0); },
    discard() { if (failCleanup) throw new Error('fixture cleanup'); }, close() { closed = true; } };
  const primary = new Error('fixture operation');
  let failure;
  try {
    await withDownloadedSigningArchive({ addon: { createArchiveSpool: () => spool }, filename: 'fixture', artifact,
      token: 'fixture', fetchImpl: fetchFixture }, () => { throw primary; });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof ArchiveQuarantineError);
  assert.equal(failure.cause.errors[0], primary);
  assert.equal(failure.cause.errors[1].message, 'fixture cleanup');
  assert.equal(closed, false);
  failCleanup = false;
  failure.retryDiscard();
  assert.throws(() => failure.retryDiscard(), /SIGNING_ARCHIVE_CLEANUP_UNVERIFIED/);
});

test('propagates a retained-handle read failure and still discards the spool', async () => {
  let discarded = false;
  const primary = new Error('fixture read');
  const spool = { write() {}, seal() {}, readAt() { throw primary; }, discard() { discarded = true; }, close() {} };
  await assert.rejects(withDownloadedSigningArchive({ addon: { createArchiveSpool: () => spool }, filename: 'fixture', artifact,
    token: 'fixture', fetchImpl: fetchFixture }, async reader => {
    const stream = reader.stream(0, 4);
    stream.destroy = () => { throw new Error('fixture override'); };
    for await (const chunk of stream) assert.ok(chunk);
  }), error => error === primary);
  assert.equal(discarded, true);
});

test('can explicitly release a retained quarantine without claiming deletion', async () => {
  let closed = false;
  const spool = { write() {}, seal() {}, readAt() { return Buffer.alloc(0); },
    discard() { throw new Error('fixture cleanup'); }, close() { closed = true; } };
  let failure;
  try {
    await withDownloadedSigningArchive({ addon: { createArchiveSpool: () => spool }, filename: 'fixture', artifact,
      token: 'fixture', fetchImpl: fetchFixture }, () => {});
  } catch (error) { failure = error; }
  assert.ok(failure instanceof ArchiveQuarantineError);
  failure.releaseWithoutDelete();
  assert.equal(closed, true);
  assert.throws(() => failure.releaseWithoutDelete(), /SIGNING_ARCHIVE_CLEANUP_UNVERIFIED/);
});
