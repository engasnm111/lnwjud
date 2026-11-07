import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const VERIFIER_SHA256 = 'd303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function pinnedFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > 100 * 1024 * 1024) {
    throw new Error('UPDATE_VERIFIER_UNSAFE_FILE');
  }
  if (hash(await readFile(filename)) !== VERIFIER_SHA256) throw new Error('UPDATE_VERIFIER_DIGEST_MISMATCH');
}

export async function stageUpdateAttestationVerifier(repositoryRoot, nativeContainmentDirectory) {
  const source = path.join(repositoryRoot, 'tools/update-attestation/gh.exe');
  const targetDirectory = path.join(nativeContainmentDirectory, 'update-attestation');
  const target = path.join(targetDirectory, 'gh.exe');
  // Provisioning verifies the official ZIP digest, Authenticode publisher and pinned
  // executable digest. No developer credentials or signing secrets are used here.
  try {
    await lstat(source);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repositoryRoot, 'scripts/update-trust/provision-gh-verifier.ps1')],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
  }
  await pinnedFile(source);
  await mkdir(targetDirectory, { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await pinnedFile(target);
  return { filename: target, sha256: VERIFIER_SHA256 };
}
