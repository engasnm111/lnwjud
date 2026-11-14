import { Buffer } from 'node:buffer';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { canonicalBase64, loadProductionPolicy, parseStrictJson } from './release-envelope.mjs';
import { authenticateAuthorizationV2 } from './release-authorization-v2.mjs';
import { validatePreviousTimeV2 } from './produce-release-authorization-v2.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';
import { readSignedPredecessor } from './build-signing-candidate.mjs';
import { signingPurposeSelection } from './authenticated-signer-receipt.mjs';

const refuse = () => { throw new Error('PUBLISHED_PREDECESSOR_REFUSED'); };
function requireKeyFree() {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
}

export async function fetchPublishedPredecessor({ tag, directory, policy, now, expectedSha256 = '', fetch = globalThis.fetch }) {
  requireKeyFree();
  if (typeof tag !== 'string' || !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag)
    || tag.length > 33 || !path.isAbsolute(directory) || await realpath(path.dirname(directory)) !== path.dirname(directory)
    || expectedSha256 !== '' && !/^[a-f0-9]{64}$/.test(expectedSha256)) refuse();
  await mkdir(directory);
  const download = async (publicName, localName, maximum) => {
    requireKeyFree();
    const response = await fetch(`https://github.com/engasnm111/lnwjud/releases/download/${tag}/${publicName}`, {
      redirect: 'follow', signal: globalThis.AbortSignal.timeout(600000),
    });
    if (!response.ok || response.body === null) refuse();
    const file = await open(path.join(directory, localName), 'wx', 0o600);
    let size = 0n;
    try {
      for await (const chunk of response.body) {
        size += BigInt(chunk.byteLength);
        if (size > maximum) refuse();
        await file.writeFile(Buffer.from(chunk));
      }
      await file.sync();
    } finally { await file.close(); }
    requireKeyFree();
    return readBoundedFile(path.join(directory, localName), maximum);
  };
  const envelope = await download('BASELINE-win32-x64.json', 'RELEASE.json', 49152n);
  if (expectedSha256 && envelope.sha256 !== expectedSha256) refuse();
  const outer = parseStrictJson(envelope.bytes, 49152, 12);
  const unsigned = parseStrictJson(canonicalBase64(outer.payload, 32768), 32768, 12);
  if (unsigned.kind !== 'baseline' || !/^[1-9][0-9]{0,11}$/.test(unsigned.issuedAt ?? '') || BigInt(unsigned.issuedAt) > now) refuse();
  const previous = authenticateAuthorizationV2(envelope.bytes, policy, BigInt(unsigned.issuedAt), 'baseline');
  validatePreviousTimeV2(previous, policy, now);
  if (previous.payload.release.version !== tag.slice(1) || previous.payload.release.platform !== 'win32'
    || previous.payload.release.architecture !== 'x64' || previous.payload.release.distribution !== 'windows-nsis') refuse();
  for (const kind of ['artifact', 'provenance']) {
    const declared = previous.payload.release[kind];
    const actual = await download(kind === 'artifact' ? declared.name : 'PROVENANCE-win32-x64.json', declared.name, BigInt(declared.sizeBytes));
    if (actual.sizeBytes !== declared.sizeBytes || actual.sha256 !== declared.sha256) refuse();
  }
  await readSignedPredecessor(directory, policy, now);
  return envelope.sha256;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const selection = signingPurposeSelection(process.env);
    if (process.argv.length !== 2 || selection.purpose !== 'update' || !selection.previousTag) refuse();
    const root = process.env.GITHUB_WORKSPACE;
    if (!path.isAbsolute(root ?? '') || await realpath(root) !== root) refuse();
    await fetchPublishedPredecessor({ tag: selection.previousTag, directory: path.join(root, '_predecessor'),
      policy: loadProductionPolicy(), now: BigInt(Math.floor(Date.now() / 1000)), expectedSha256: selection.previousEnvelope });
    process.stdout.write('PUBLISHED_PREDECESSOR_AUTHENTICATED\n');
  } catch { process.stderr.write('PUBLISHED_PREDECESSOR_REFUSED\n'); process.exitCode = 1; }
}
