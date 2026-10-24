import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const filename = 'lnwjud-update-worker.exe';

export async function verifyUpdateWorkerArtifacts({ directory, compiledBundlePath }) {
  const bundle = await readFile(compiledBundlePath, 'utf8');
  const matches = [...bundle.matchAll(/(?:var|const)\s+UPDATE_WORKER_SHA256\s*=\s*["']([a-f0-9]{64})["']/g)];
  if (matches.length !== 1 || /^0+$/.test(matches[0][1])) throw new Error('Compiled update worker trust is unavailable');
  const expected = matches[0][1];
  const pinMatches = [...bundle.matchAll(/(?:var|const)\s+UPDATE_WORKER_PIN_SHA256\s*=\s*["']([a-f0-9]{64})["']/g)];
  const containmentPinMatches = [...bundle.matchAll(/(?:var|const)\s+CONTAINMENT_PIN_SHA256\s*=\s*["']([a-f0-9]{64})["']/g)];
  if (pinMatches.length !== 1 || containmentPinMatches.length !== 1 || /^0+$/.test(pinMatches[0][1])
    || pinMatches[0][1] !== containmentPinMatches[0][1]) throw new Error('Compiled update worker pin trust is unavailable');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifestInfo = await ordinaryFile(manifestPath);
  if (manifestInfo.size > 16 * 1024) throw new Error('Update worker manifest is oversized');
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 16 * 1024) throw new Error('Update worker manifest is oversized');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.buildId !== 'lnwjud-update-worker-bootstrap-v1' || manifest.protocol !== 1
    || manifest.platform !== 'win32' || manifest.architecture !== 'x64' || manifest.filename !== filename
    || manifest.sha256 !== expected || manifest.installationEffects !== false
    || manifest.pinFilename !== 'lnwjud-containment-pin.node' || manifest.pinSha256 !== pinMatches[0][1]) {
    throw new Error('Update worker manifest does not match compiled trust');
  }
  const file = path.join(directory, filename);
  const metadata = await ordinaryFile(file);
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  if (sha256 !== expected) throw new Error('Update worker bytes do not match compiled trust');
  return { filename, sha256, sizeBytes: metadata.size };
}

export function validateUpdateWorkerEvidence(identity, files, platform) {
  if (platform !== 'win32') {
    if (identity !== null && identity !== undefined) throw new Error('Non-Windows release must not claim update worker evidence');
    return null;
  }
  if (identity?.filename !== filename || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? '') || /^0+$/.test(identity.sha256)
    || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes <= 0) {
    throw new Error('Update worker evidence is missing or invalid');
  }
  const entries = files.filter(entry => entry?.relativePath === `resources/update-worker/${filename}`);
  if (entries.length !== 1 || entries[0].sha256 !== identity.sha256 || entries[0].sizeBytes !== identity.sizeBytes) {
    throw new Error('Update worker evidence does not match packaged runtime ledger');
  }
  return identity;
}

async function ordinaryFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(file) !== path.resolve(file)) {
    throw new Error('Update worker artifact is not an ordinary canonical file');
  }
  return info;
}
