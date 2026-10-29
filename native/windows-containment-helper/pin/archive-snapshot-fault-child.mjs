import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const addon = createRequire(import.meta.url)(path.resolve(process.argv[2]));
const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-archive-init-fault-'));
const file = path.join(root, 'spool.zip');
const digest = createHash('sha256').update('fixture').digest('hex');
try {
  for (const fault of [1, 2, 3]) {
    addon.setArchiveTestFault(fault);
    assert.throws(() => addon.createArchiveSpool(file, 7, digest), /Archive initialization failed/);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  addon.setArchiveTestFault(4);
  assert.throws(() => addon.createArchiveSpool(file, 7, digest), /Archive cleanup unverified/);
  assert.equal((await readFile(file)).length, 0);
  addon.setArchiveTestFault(0);
  await unlink(file);
  const spool = addon.createArchiveSpool(file, 7, digest);
  try {
    spool.write(Buffer.from('fixture'));
    spool.seal();
    addon.setArchiveTestFault(5);
    assert.throws(() => spool.discard(), /Archive cleanup unverified/);
    assert.throws(() => spool.readAt(0, 1));
    await assert.rejects(readFile(file));
    addon.setArchiveTestFault(0);
    spool.discard();
    spool.discard();
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { addon.setArchiveTestFault(0); spool.close(); }
  await writeFile(file, 'fixture');
  addon.setArchiveTestFault(9);
  const executablePin = addon.pinExecutable(file);
  executablePin.close();
  addon.setArchiveTestFault(0);
  await unlink(file);
  for (const fault of [6, 7, 8]) {
    const directory = path.join(root, `held-${fault}`), moved = path.join(root, `moved-${fault}`);
    await mkdir(directory);
    const heldFile = path.join(directory, 'spool.zip');
    try {
      addon.setArchiveTestFault(fault);
      if (fault === 8) assert.throws(() => addon.createArchiveSpool(heldFile, 7, digest), /Archive cleanup unverified/);
      else {
        let held = addon.createArchiveSpool(heldFile, 7, digest);
        held.write(Buffer.from('fixture')); held.seal();
        assert.throws(() => held.discard(), /Archive cleanup unverified/);
        assert.throws(() => held.readAt(0, 1));
        assert.throws(() => held.discard(), /Archive cleanup unverified/);
        held = null;
        const expectedPins = fault === 6 ? 2 : 1;
        for (let i = 0; i < 20 && addon.archiveQuarantineCountForTest() < expectedPins; i++) {
          globalThis.gc(); await new Promise(resolve => globalThis.setTimeout(resolve, 10));
        }
        assert.ok(addon.archiveQuarantineCountForTest() >= expectedPins);
      }
      assert.ok(addon.archiveQuarantineCountForTest() > 0);
      await assert.rejects(rename(directory, moved), `ancestor rename unexpectedly allowed for fault ${fault}`);
      addon.setArchiveTestFault(0);
      addon.releaseArchiveQuarantineForTest();
      await assert.rejects(readFile(heldFile), { code: 'ENOENT' });
      await rename(directory, moved);
      await rmdir(moved);
    } finally {
      addon.setArchiveTestFault(0);
      addon.releaseArchiveQuarantineForTest();
      await unlink(heldFile).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
      await rmdir(moved).catch(() => undefined);
    }
  }
  for (const fault of [10, 11]) {
    const directory = path.join(root, `pin-${fault}`), moved = path.join(root, `pin-moved-${fault}`);
    await mkdir(directory);
    const heldFile = path.join(directory, 'item.exe');
    await writeFile(heldFile, 'fixture');
    try {
      addon.setArchiveTestFault(fault === 10 ? 0 : fault);
      if (fault === 11) assert.throws(() => addon.pinExecutable(heldFile), /Executable cleanup unverified/);
      else {
        let pin = addon.pinExecutable(heldFile);
        addon.setArchiveTestFault(fault);
        assert.throws(() => pin.close(), /Executable cleanup unverified/);
        assert.throws(() => pin.close(), /Executable cleanup unverified/);
        pin = null;
        for (let i = 0; i < 20 && addon.archiveQuarantineCountForTest() === 0; i++) {
          globalThis.gc(); await new Promise(resolve => globalThis.setTimeout(resolve, 10));
        }
      }
      assert.ok(addon.archiveQuarantineCountForTest() > 0);
      await assert.rejects(rename(directory, moved));
      addon.setArchiveTestFault(0);
      addon.releaseArchiveQuarantineForTest();
      await rename(directory, moved);
      await unlink(path.join(moved, 'item.exe'));
      await rmdir(moved);
    } finally {
      addon.setArchiveTestFault(0);
      addon.releaseArchiveQuarantineForTest();
      await unlink(heldFile).catch(() => undefined);
      await unlink(path.join(moved, 'item.exe')).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
      await rmdir(moved).catch(() => undefined);
    }
  }
} finally {
  addon.setArchiveTestFault(0);
  await unlink(file).catch(() => undefined);
  await rmdir(root);
}
