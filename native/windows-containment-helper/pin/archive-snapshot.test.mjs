import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, link, unlink, rmdir, rename, open, symlink, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const addonPath = process.env.LNWJUD_ARCHIVE_PIN_TEST_ADDON
  ?? fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment-pin.node', import.meta.url));
const available = process.platform === 'win32' && process.arch === 'x64';
const addon = available ? createRequire(import.meta.url)(path.resolve(addonPath)) : undefined;
const bytes = Buffer.from('verified archive fixture');
const digest = createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-archive-snapshot-'));
  const file = path.join(root, 'archive.zip');
  await writeFile(file, bytes);
  try { await run({ root, file }); }
  finally {
    await unlink(path.join(root, 'alias.zip')).catch(() => undefined);
    await unlink(path.join(root, 'spool.zip')).catch(() => undefined);
    await unlink(path.join(root, 'archive.zip')).catch(() => undefined);
    await rmdir(root);
  }
}

test('pins exact verified bytes, supports bounded reads and discards by retained handle', { skip: !available }, async () => {
  assert.equal(addon.setArchiveTestFault, undefined);
  await fixture(async ({ root, file }) => {
    const snapshot = addon.openVerifiedArchiveSnapshot(file, bytes.length, digest);
    try {
      assert.equal(snapshot.size, bytes.length);
      assert.deepEqual(snapshot.readAt(0, 8), bytes.subarray(0, 8));
      assert.deepEqual(snapshot.readAt(8, bytes.length - 8), bytes.subarray(8));
      assert.deepEqual(snapshot.readAt(bytes.length, 0), Buffer.alloc(0));
      for (const input of [[-1, 1], [0, -1], [0, 1048577], [bytes.length, 1], [0.5, 1], [Infinity, 1]])
        assert.throws(() => snapshot.readAt(...input));
      await assert.rejects(writeFile(file, 'changed'));
      await assert.rejects(rename(file, path.join(root, 'renamed.zip')));
      snapshot.discard();
      await assert.rejects(readFile(file), { code: 'ENOENT' });
      assert.throws(() => snapshot.readAt(0, 1));
      snapshot.discard();
      snapshot.close();
    } finally { snapshot.close(); }
  });
});

test('refuses mismatched identities without deleting or retaining locks', { skip: !available }, async () => {
  await fixture(async ({ file }) => {
    assert.throws(() => addon.openVerifiedArchiveSnapshot(file, bytes.length, '0'.repeat(64)));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(file, bytes.length + 1, digest));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(file, 0, digest));
    assert.deepEqual(await readFile(file), bytes);
    await writeFile(file, bytes);
    const snapshot = addon.openVerifiedArchiveSnapshot(file, bytes.length, digest);
    snapshot.close();
    snapshot.close();
    assert.throws(() => snapshot.discard());
    assert.deepEqual(await readFile(file), bytes);
  });
});

test('rejects hard links and noncanonical path components', { skip: !available }, async () => {
  await fixture(async ({ root, file }) => {
    assert.throws(() => addon.openVerifiedArchiveSnapshot(`${root}\\.\\archive.zip`, bytes.length, digest));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(`${root}\\..\\archive.zip`, bytes.length, digest));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(`${file}:stream`, bytes.length, digest));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(`${root}\\COM¹.zip`, bytes.length, digest));
    const writer = await open(file, 'r+');
    try { assert.throws(() => addon.openVerifiedArchiveSnapshot(file, bytes.length, digest)); }
    finally { await writer.close(); }
    const junction = path.join(root, 'junction');
    await symlink(root, junction, 'junction');
    try {
      assert.throws(() => addon.openVerifiedArchiveSnapshot(path.join(junction, 'archive.zip'), bytes.length, digest));
      assert.throws(() => addon.pinExecutable(path.join(junction, 'archive.zip')));
    }
    finally { await rmdir(junction); }
    await link(file, path.join(root, 'alias.zip'));
    assert.throws(() => addon.openVerifiedArchiveSnapshot(file, bytes.length, digest));
  });
});

test('rejects methods borrowed between executable pins and archive snapshots', { skip: !available }, async () => {
  await fixture(async ({ root, file }) => {
    const other = path.join(root, 'other.exe');
    await writeFile(other, bytes);
    const pin = addon.pinExecutable(other);
    const snapshot = addon.openVerifiedArchiveSnapshot(file, bytes.length, digest);
    try {
      for (const call of [
        () => pin.close.call(snapshot),
        () => snapshot.close.call(pin),
        () => snapshot.discard.call(pin),
        () => snapshot.readAt.call(pin, 0, 1),
        () => snapshot.readAt.call({}, 0, 1),
      ]) assert.throws(call);
      await assert.rejects(writeFile(other, 'changed'));
      await assert.rejects(writeFile(file, 'changed'));
      assert.deepEqual(snapshot.readAt(0, bytes.length), bytes);
    } finally {
      snapshot.close();
      pin.close();
      await unlink(other);
    }
  });
});

test('holds the snapshot when handle-based deletion fails', { skip: !available }, async () => {
  await fixture(async ({ file }) => {
    await chmod(file, 0o444);
    let snapshot;
    try {
      snapshot = addon.openVerifiedArchiveSnapshot(file, bytes.length, digest);
      assert.throws(() => snapshot.discard(), /Archive cleanup unverified/);
      assert.deepEqual(snapshot.readAt(0, bytes.length), bytes);
      await assert.rejects(writeFile(file, 'changed'));
      snapshot.close();
      snapshot = undefined;
      assert.deepEqual(await readFile(file), bytes);
    } finally {
      snapshot?.close();
      await chmod(file, 0o666);
    }
  });
});

test('writes, seals, reads and discards a new spool using the retained handle', { skip: !available }, async () => {
  await fixture(async ({ root, file }) => {
    assert.throws(() => addon.createArchiveSpool(file, bytes.length, digest));
    assert.deepEqual(await readFile(file), bytes);
    const spoolFile = path.join(root, 'spool.zip');
    const spool = addon.createArchiveSpool(spoolFile, bytes.length, digest);
    try {
      assert.throws(() => spool.readAt(0, 1));
      spool.write(bytes.subarray(0, 8));
      spool.write(bytes.subarray(8));
      await assert.rejects(readFile(spoolFile));
      await assert.rejects(writeFile(spoolFile, 'changed'));
      spool.seal();
      assert.deepEqual(spool.readAt(0, bytes.length), bytes);
      assert.throws(() => spool.write(bytes));
      spool.discard();
      await assert.rejects(readFile(spoolFile), { code: 'ENOENT' });
    } finally { spool.close(); }
  });
});

test('failed spool verification cannot be resumed or read and can be discarded', { skip: !available }, async () => {
  for (const failure of ['truncated', 'wrong-digest', 'oversized-chunk']) await fixture(async ({ root }) => {
    const file = path.join(root, 'spool.zip');
    const spool = addon.createArchiveSpool(file, bytes.length, failure === 'wrong-digest' ? '0'.repeat(64) : digest);
    try {
      if (failure === 'oversized-chunk') assert.throws(() => spool.write(Buffer.alloc(1048577)));
      else {
        spool.write(failure === 'truncated' ? bytes.subarray(0, 4) : bytes);
        assert.throws(() => spool.seal());
      }
      assert.throws(() => spool.readAt(0, 1));
      assert.throws(() => spool.write(bytes));
      assert.throws(() => spool.seal());
      spool.discard();
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    } finally { spool.close(); }
  });
});
