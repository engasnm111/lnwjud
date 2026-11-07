import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/**
 * Conservative, source-bound recovery compatibility contract.
 * Intentional incompatibility must fail closed rather than silently promise data rollback.
 * This does not prove migration execution or installed app health.
 */
const paths = Object.freeze({
  migrationContractSha256: 'packages/storage/src/backup-service.ts',
  workerContractSha256: 'native/update-worker/UpdateTransactionJournal.cs',
  serviceContractSha256: 'native/update-admission-broker/AdmissionProtocol.cs',
});

function fail() { throw new Error('UPDATE_RECOVERY_CONTRACT_UNVERIFIED'); }

export async function sourceRecoveryContracts(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) fail();
  const contracts = {};
  for (const [role, relative] of Object.entries(paths)) {
    const filename = path.resolve(repositoryRoot, relative);
    if (!filename.startsWith(path.resolve(repositoryRoot) + path.sep)) fail();
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2 * 1024 * 1024) fail();
    const contents = await readFile(filename);
    if (contents.length < 1 || contents.length > 2 * 1024 * 1024 || contents.includes(0)) fail();
    // Git worktrees may differ only by CRLF checkout normalization.
    const plain = Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
    if (plain.includes(13) || plain.length === 0) fail();
    contracts[role] = createHash('sha256').update(plain).digest('hex');
  }
  return Object.freeze(contracts);
}

export function assertSourceRecoveryContracts(observed, expected) {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)
    || Object.keys(observed).length !== 3) fail();
  for (const key of Object.keys(paths))
    if (typeof observed[key] !== 'string' || !/^[a-f0-9]{64}$/.test(observed[key]) || observed[key] !== expected[key]) fail();
  return true;
}
