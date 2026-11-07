import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceRecoveryContracts, assertSourceRecoveryContracts } from './source-recovery-contracts.mjs';

const files = [
  'packages/storage/src/backup-service.ts',
  'native/update-worker/UpdateTransactionJournal.cs',
  'native/update-admission-broker/AdmissionProtocol.cs',
];

test('signed rollback contracts bind exact source bytes and reject a changed recovery implementation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-recovery-contract-'));
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), 'contract version one\n');
    }
    const baseline = await sourceRecoveryContracts(root);
    assert.equal(assertSourceRecoveryContracts(baseline, baseline), true);
    await writeFile(path.join(root, files[0]), 'contract version one\r\n');
    assert.deepEqual(await sourceRecoveryContracts(root), baseline, 'CRLF must not invalidate the same source bytes');
    await writeFile(path.join(root, files[1]), 'contract version two\n');
    const changed = await sourceRecoveryContracts(root);
    assert.throws(() => assertSourceRecoveryContracts(baseline, changed), /UPDATE_RECOVERY_CONTRACT_UNVERIFIED/);
    assert.throws(() => assertSourceRecoveryContracts({ ...baseline, extra: 'a' }, baseline), /UPDATE_RECOVERY_CONTRACT_UNVERIFIED/);
    const expected = await readFile(path.join(root, files[2]));
    await writeFile(path.join(root, files[2]), Buffer.concat([expected, Buffer.from([0])]));
    await assert.rejects(sourceRecoveryContracts(root), /UPDATE_RECOVERY_CONTRACT_UNVERIFIED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
