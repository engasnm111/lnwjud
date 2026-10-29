import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import process from 'node:process';
import { Readable, Transform, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { refuse } from './release-envelope.mjs';

const repository = 'engasnm111/lnwjud';
const maximumArchiveBytes = 5 * 1024 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function storageUrl(value, base) {
  if (typeof value !== 'string' || value.length === 0) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
  let url;
  try { url = new URL(value, base); } catch { refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED'); }
  if (url.protocol !== 'https:' || url.hostname !== 'productionresultssa8.blob.core.windows.net'
    || url.port || url.username || url.password || url.hash) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
  return url.href;
}

export async function downloadSigningArtifactArchive({ artifactId, expectedSha256, token, destination, fetchImpl = globalThis.fetch }) {
  if (!(destination instanceof Writable)) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
  const controller = new globalThis.AbortController();
  const stopped = finished(destination, { cleanup: true }).catch(() => controller.abort());
  const timer = globalThis.setTimeout(() => controller.abort(), 120000);
  const signal = controller.signal;
  let activeBody;
  try {
    if (typeof artifactId !== 'string' || !/^[1-9][0-9]{0,14}$/.test(artifactId)
      || !Number.isSafeInteger(Number(artifactId)) || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)
      || typeof token !== 'string' || token.length < 1 || token.length > 4096 || typeof fetchImpl !== 'function'
      || process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28', 'user-agent': 'lnwjud-signing-diagnostic' }, redirect: 'manual', signal,
    });
    activeBody = response.body;
    if (response.status !== 302) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
    let url = storageUrl(response.headers.get('location'));
    if (response.body) await response.body.cancel();
    let archive;
    for (let redirects = 0; redirects <= 3; redirects++) {
      archive = await fetchImpl(url, { headers: { 'accept-encoding': 'identity' }, redirect: 'manual', signal });
      activeBody = archive.body;
      if (!redirectStatuses.has(archive.status)) break;
      if (redirects === 3) refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
      url = storageUrl(archive.headers.get('location'), url);
      if (archive.body) await archive.body.cancel();
    }
    if (!archive || archive.status !== 200 || !archive.body
      || (archive.headers.get('content-encoding') || 'identity').toLowerCase() !== 'identity') refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
    const declared = archive.headers.get('content-length');
    if (declared !== null && (!/^(?:0|[1-9][0-9]{0,15})$/.test(declared) || Number(declared) > maximumArchiveBytes))
      refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
    const hash = createHash('sha256'); let length = 0;
    const limitAndHash = new Transform({ transform(chunk, _encoding, callback) {
      length += chunk.length;
      if (length > maximumArchiveBytes) { callback(new Error('SIGNING_ARCHIVE_DOWNLOAD_REFUSED')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(archive.body), limitAndHash, destination, { signal });
    if (length === 0 || declared !== null && length !== Number(declared) || hash.digest('hex') !== expectedSha256)
      refuse('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
    return Object.freeze({ sizeBytes: length, sha256: expectedSha256 });
  } catch {
    destination.destroy();
    await stopped;
    throw new Error('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
  } finally {
    globalThis.clearTimeout(timer);
    controller.abort();
    if (activeBody && !activeBody.locked) await activeBody.cancel().catch(() => undefined);
  }
}
