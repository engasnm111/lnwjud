import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function verifyContainmentArtifacts({ directory, compiledBundlePath, platform }) {
  const bundle = await readFile(compiledBundlePath, 'utf8');
  const runtime = await verifyPinnedFile(directory, 'process-runtime.mjs', embeddedDigest(bundle, 'CONTAINMENT_RUNTIME_SHA256'));
  if (platform !== 'win32') return { runtime };
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const helperDigest = embeddedDigest(bundle, 'CONTAINMENT_HELPER_SHA256');
  const pinDigest = embeddedDigest(bundle, 'CONTAINMENT_PIN_SHA256');
  if (manifest.schemaVersion !== 2 || manifest.buildId !== 'lnwjud-containment-v2'
    || manifest.platform !== 'win32' || manifest.architecture !== 'x64'
    || manifest.filename !== 'lnwjud-containment.exe' || manifest.sha256 !== helperDigest
    || manifest.pinFilename !== 'lnwjud-containment-pin.node' || manifest.pinSha256 !== pinDigest) {
    throw new Error('Packaged containment manifest does not match compiled trust');
  }
  const helper = await verifyPinnedFile(directory, manifest.filename, helperDigest);
  const pin = await verifyPinnedFile(directory, manifest.pinFilename, pinDigest);
  return { runtime, helper, pin };
}

export function validateContainmentEvidence(containment, files, platform) {
  const names = platform === 'win32'
    ? { runtime: 'process-runtime.mjs', helper: 'lnwjud-containment.exe', pin: 'lnwjud-containment-pin.node' }
    : { runtime: 'process-runtime.mjs' };
  const prefix = platform === 'darwin' ? 'Contents/Resources' : 'resources';
  for (const [kind, filename] of Object.entries(names)) {
    const identity = containment?.[kind];
    if (identity?.filename !== filename || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? '')
      || /^0+$/.test(identity.sha256) || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes <= 0) {
      throw new Error(`Containment ${kind} evidence is missing or invalid`);
    }
    const matches = files.filter(entry => entry?.relativePath === `${prefix}/native-containment/${filename}`);
    if (matches.length !== 1 || matches[0].sha256 !== identity.sha256 || matches[0].sizeBytes !== identity.sizeBytes) {
      throw new Error(`Containment ${kind} evidence does not match the packaged runtime ledger`);
    }
  }
  return containment;
}

function embeddedDigest(bundle, name) {
  const matches = [...bundle.matchAll(new RegExp(`(?:var|const)\\s+${name}\\s*=\\s*["']([a-f0-9]{64})["']`, 'g'))];
  if (matches.length !== 1 || /^0+$/.test(matches[0][1])) throw new Error(`Compiled containment trust is unavailable: ${name}`);
  return matches[0][1];
}

async function verifyPinnedFile(directory, filename, expectedDigest) {
  const file = path.resolve(directory, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error(`Containment runtime path is not canonical: ${filename}`);
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  if (sha256 !== expectedDigest) throw new Error(`Containment runtime hash does not match compiled trust: ${filename}`);
  return { filename, sha256, sizeBytes: info.size };
}
