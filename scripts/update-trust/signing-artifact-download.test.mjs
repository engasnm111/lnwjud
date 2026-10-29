import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import process from 'node:process';
import { downloadSigningArtifactArchive } from './signing-artifact-download.mjs';

const bytes = Buffer.from('fixture archive');
const sha256 = createHash('sha256').update(bytes).digest('hex');
function sink() {
  const chunks = [];
  return { chunks, output: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) };
}
function request(fetchImpl, changes = {}) {
  const target = sink();
  return { ...target, promise: downloadSigningArtifactArchive({ artifactId: '12', expectedSha256: sha256,
    token: 'fixture-token', destination: target.output, fetchImpl, ...changes }) };
}
const redirected = (location = 'https://productionresultssa8.blob.core.windows.net/archive') => new globalThis.Response(null, { status: 302, headers: { location } });

test('downloads the exact artifact and never forwards its token to redirected hosts', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return redirected();
    if (calls.length === 2) return redirected('https://productionresultssa8.blob.core.windows.net/archive');
    return new globalThis.Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const result = request(fetchImpl);
  assert.deepEqual(await result.promise, { sizeBytes: bytes.length, sha256 });
  assert.deepEqual(Buffer.concat(result.chunks), bytes);
  assert.equal(calls[0].url, 'https://api.github.com/repos/engasnm111/lnwjud/actions/artifacts/12/zip');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token');
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers.cookie, undefined);
    assert.equal(call.options.redirect, 'manual');
  }
});

test('rejects wrong archive digest, unsafe redirects and unbounded or altered content', async () => {
  for (const fetchImpl of [
    async (url) => url.startsWith('https://api.github.com/') ? redirected('https://127.0.0.1/a') : new globalThis.Response(bytes),
    async (url) => url.startsWith('https://api.github.com/') ? redirected('http://productionresultssa8.blob.core.windows.net/a') : new globalThis.Response(bytes),
    async (url) => url.startsWith('https://api.github.com/') ? redirected('https://user:password@productionresultssa8.blob.core.windows.net/a') : new globalThis.Response(bytes),
    async (url) => url.startsWith('https://api.github.com/') ? redirected() : new globalThis.Response(bytes, { headers: { 'content-length': '5368709121' } }),
    async (url) => url.startsWith('https://api.github.com/') ? redirected() : new globalThis.Response(bytes, { headers: { 'content-encoding': 'gzip' } }),
    async (url) => url.startsWith('https://api.github.com/') ? redirected() : new globalThis.Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
    async (url) => url.startsWith('https://api.github.com/') ? redirected() : new globalThis.Response('changed'),
    async () => redirected(),
  ]) {
    const result = request(fetchImpl);
    await assert.rejects(result.promise, { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
  }
});

test('refuses a storage redirect without Location before issuing another request', async () => {
  let calls = 0;
  const result = request(async () => {
    calls++;
    return calls === 1 ? redirected() : new globalThis.Response(null, { status: 302 });
  });
  await assert.rejects(result.promise, { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
  assert.equal(calls, 2);
});

test('rejects a supplied artifact identity that is not a positive safe integer', async () => {
  let calls = 0;
  const target = request(async () => { calls++; throw new Error('must not fetch'); }, { artifactId: '01' });
  await assert.rejects(target.promise, { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
  assert.equal(calls, 0);
});

test('refuses to download while the signing key is present in the environment', async () => {
  const name = 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM';
  const original = process.env[name];
  try {
    process.env[name] = 'fixture-only';
    let calls = 0;
    const result = request(async () => { calls++; throw new Error('must not fetch'); });
    await assert.rejects(result.promise, { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
    assert.equal(calls, 0);
  } finally {
    if (original === undefined) delete process.env[name]; else process.env[name] = original;
  }
});

test('waits for asynchronous destination shutdown before rejecting a failed request', async () => {
  let closed = false;
  const destination = new Writable({
    write(_chunk, _encoding, done) { done(); },
    destroy(_error, done) { globalThis.setTimeout(() => { closed = true; done(); }, 20); },
  });
  await assert.rejects(downloadSigningArtifactArchive({ artifactId: '12', expectedSha256: sha256, token: 'fixture',
    destination, fetchImpl: async () => new globalThis.Response(null, { status: 403 }) }),
  { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
  assert.equal(closed, true);
});

test('aborts a pending request and waits when destination fails before the response', async () => {
  let closed = false, aborted = false;
  const destination = new Writable({
    write(_chunk, _encoding, done) { done(); },
    destroy(error, done) { globalThis.setTimeout(() => { closed = true; done(error); }, 20); },
  });
  const pending = downloadSigningArtifactArchive({ artifactId: '12', expectedSha256: sha256, token: 'fixture', destination,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
  destination.destroy(new Error('fixture write error'));
  await assert.rejects(pending, { message: 'SIGNING_ARCHIVE_DOWNLOAD_REFUSED' });
  assert.equal(aborted, true);
  assert.equal(closed, true);
});
