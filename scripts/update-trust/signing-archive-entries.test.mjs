import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Readable } from 'node:stream';
import { inspectSigningArchive } from './signing-archive-entries.mjs';
import { withInspectedSigningArchive } from './signing-archive-spool.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedSource = Object.freeze({ repositoryId: '1329830515', runId: '123', runAttempt: 1,
  policySha256: 'b'.repeat(64) });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const fixture = () => {
  const values = {
    candidate: Buffer.from('candidate metadata'),
    artifact: Buffer.from('setup bytes'),
    provenance: Buffer.from('provenance bytes'),
    artifactBundle: Buffer.from('artifact attestation'),
    provenanceBundle: Buffer.from('provenance attestation'),
  };
  const names = { candidate: 'CANDIDATE.json', artifact: 'lnwjud-Setup-5.9.1.exe', provenance: 'PROVENANCE.json',
    artifactBundle: 'artifact.bundle.json', provenanceBundle: 'provenance.bundle.json' };
  const manifest = { schema: 'lnwjud.signing-verification/v1', verification: { repositoryId: '1329830515',
    runId: '123', runAttempt: 1 }, policySha256: 'b'.repeat(64), purpose: 'baseline', candidate: {} };
  const files = [];
  for (const [role, bytes] of Object.entries(values)) {
    manifest.candidate[role] = { name: names[role], sizeBytes: String(bytes.length), sha256: sha256(bytes) };
    files.push({ name: `files/candidate/${names[role]}`, bytes });
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files.unshift({ name: 'manifest.json', bytes: manifestBytes });
  return { files, manifestSha256: sha256(manifestBytes) };
};

function zip(files, { descriptor = false } = {}) {
  const localParts = [], directoryParts = [];
  let offset = 0;
  for (const file of files) {
    const filename = Buffer.from(file.name, 'utf8'), contents = Buffer.from(file.bytes);
    const extra = Buffer.from(file.extra ?? []);
    const crc = crc32(contents), flag = descriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(0, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(contents.length, 18);
      local.writeUInt32LE(contents.length, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const description = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      description.writeUInt32LE(0x08074b50, 0);
      description.writeUInt32LE(crc, 4);
      description.writeUInt32LE(contents.length, 8);
      description.writeUInt32LE(contents.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flag, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, filename, extra, contents, description);
    directoryParts.push(central, filename, extra);
    offset += local.length + filename.length + extra.length + contents.length + description.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function reader(bytes) {
  return { size: bytes.length, readAt: (at, size) => bytes.subarray(at, at + size),
    stream: (at, size) => Readable.from([bytes.subarray(at, at + size)]) };
}
const inspect = (bytes, sha, source = expectedSource) => inspectSigningArchive(reader(bytes), sha, source);

test('sealed archive checks every fixed role, SHA-256 and ZIP CRC without unpacking executable files', async () => {
  const f = fixture();
  for (const descriptor of [false, true]) {
    const result = await inspect(zip(f.files, { descriptor }), f.manifestSha256);
    assert.deepEqual(result, { status: 'verified-archive-contents-only',
      manifestSha256: f.manifestSha256, purpose: 'baseline', fileCount: 6 });
  }
});

test('archive manifest must match independently selected source run and tracked policy before consumption', async () => {
  const f = fixture(), bytes = zip(f.files);
  for (const source of [
    undefined, null, {},
    { ...expectedSource, repositoryId: '7' },
    { ...expectedSource, runId: '124' },
    { ...expectedSource, runAttempt: 2 },
    { ...expectedSource, policySha256: 'c'.repeat(64) },
    { ...expectedSource, runId: '0123' },
    { ...expectedSource, unexpected: true },
  ]) await assert.rejects(inspectSigningArchive(reader(bytes), f.manifestSha256, source),
    /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
  assert.equal((await inspect(bytes, f.manifestSha256)).fileCount, 6);
});

test('archive rejects wrong manifest, malicious filename, unexpected role, missing role and duplicated member', async () => {
  const f = fixture(), good = zip(f.files);
  await assert.rejects(inspect(good, 'c'.repeat(64)), /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
  const changed = [
    [{ ...f.files[0], name: '../manifest.json' }, ...f.files.slice(1)],
    [...f.files, { name: 'files/candidate/extra.json', bytes: Buffer.from('extra') }],
    f.files.slice(0, -1),
    [...f.files, f.files[0]],
    [{ ...f.files[0], name: 'MANIFEST.json' }, ...f.files.slice(1)],
    [{ ...f.files[1], name: 'files/candidate/CON.txt' }, ...f.files.slice(1)],
    [{ ...f.files[0], bytes: Buffer.from(JSON.stringify({ bad: 1 })) }, ...f.files.slice(1)],
    f.files.map((v, i) => i === 2 ? { ...v, bytes: Buffer.from('tampered setup') } : v),
    f.files.map((v, i) => i === 3 ? { ...v, name: v.name.toLowerCase() } : v),
  ];
  for (const members of changed) await assert.rejects(inspect(zip(members), f.manifestSha256),
    /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
});

test('ZIP parser refuses compressed, encrypted, symlink, inconsistent local header and descriptor bytes', async () => {
  const f = fixture();
  const altered = [];
  const base = zip(f.files), startOfDirectory = base.readUInt32LE(base.length - 6);
  const encrypted = Buffer.from(base);
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(1, startOfDirectory + 8);
  altered.push(encrypted);
  const deflate = Buffer.from(base);
  deflate.writeUInt16LE(8, 8);
  deflate.writeUInt16LE(8, startOfDirectory + 10);
  altered.push(deflate);
  const symlink = Buffer.from(base);
  symlink.writeUInt32LE(0xa1ff0000, startOfDirectory + 38);
  altered.push(symlink);
  altered.push(zip(f.files.map((v, i) => i === 0 ? { ...v, extra: Buffer.from([1, 0, 0, 0]) } : v)));
  const forgedLocal = Buffer.from(base);
  forgedLocal.writeUInt32LE(0, 14);
  altered.push(forgedLocal);
  const comment = Buffer.concat([base, Buffer.from('ignored')]);
  altered.push(comment);
  const descriptor = zip(f.files, { descriptor: true });
  const forgedDescriptor = Buffer.from(descriptor);
  const firstDescriptor = 30 + Buffer.byteLength(f.files[0].name) + f.files[0].bytes.length;
  forgedDescriptor.writeUInt32LE(0, firstDescriptor + 4);
  altered.push(forgedDescriptor);
  for (const archive of altered) await assert.rejects(inspect(archive, f.manifestSha256), /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
});

test('signing-key presence prevents reading archive contents', async () => {
  const f = fixture();
  const prior = process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
  process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = '';
  try { await assert.rejects(inspect(zip(f.files), f.manifestSha256), /SIGNING_ARCHIVE_STRUCTURE_REFUSED/); }
  finally {
    if (prior === undefined) delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    else process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = prior;
  }
});

test('native spool verifies exact ZIP members before invoking a consumer, then discards input', async () => {
  const f = fixture(), archive = zip(f.files);
  let discarded = 0, consumed = 0;
  const addon = { createArchiveSpool() {
    const parts = []; let sealed;
    return {
      write(chunk) { parts.push(Buffer.from(chunk)); },
      seal() { sealed = Buffer.concat(parts); },
      readAt(offset, size) { return sealed.subarray(offset, offset + size); },
      discard() { discarded++; },
    };
  } };
  const fetchImpl = async url => url.startsWith('https://api.github.com/')
    ? new globalThis.Response(null, { status: 302, headers: { location: 'https://productionresultssa8.blob.core.windows.net/a' } })
    : new globalThis.Response(archive);
  const options = { addon, filename: 'fixture-only', artifact: {
    artifactId: '12', archiveSha256: sha256(archive), archiveSizeBytes: archive.length },
    token: 'test-token', fetchImpl, expectedManifestSha256: f.manifestSha256, expectedSource };
  const result = await withInspectedSigningArchive(options, (_reader, inspection) => {
    consumed++;
    return inspection.fileCount;
  });
  assert.equal(result, 6);
  assert.equal(consumed, 1);
  assert.equal(discarded, 1);
  await assert.rejects(withInspectedSigningArchive({ ...options, expectedManifestSha256: 'c'.repeat(64) },
    () => { consumed++; }), /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
  assert.equal(discarded, 2);
  assert.equal(consumed, 1);
  await assert.rejects(withInspectedSigningArchive({ ...options, expectedSource: undefined },
    () => { consumed++; }), /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
  assert.equal(discarded, 3);
  assert.equal(consumed, 1);
  const mutableSource = { ...expectedSource, runId: '124' };
  const pending = withInspectedSigningArchive({ ...options, expectedSource: mutableSource },
    () => { consumed++; });
  mutableSource.runId = '123'; // A late mutation must not replace the pre-download source identity.
  await assert.rejects(pending, /SIGNING_ARCHIVE_STRUCTURE_REFUSED/);
  assert.equal(discarded, 4);
  assert.equal(consumed, 1);
  assert.throws(() => withInspectedSigningArchive({ ...options, expectedManifestSha256: 'INVALID' },
    () => { consumed++; }), /SIGNING_ARCHIVE_INPUT_INVALID/);
  assert.equal(discarded, 4);
});
