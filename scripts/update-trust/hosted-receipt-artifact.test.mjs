import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHostedReceiptMetadata, selectHostedReceiptArtifact } from './hosted-receipt-artifact.mjs';

const sourceSha = 'a'.repeat(40);
const expected = { runId: 987654321, sourceSha };
const run = {
  id: expected.runId, run_attempt: 1, event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', head_sha: sourceSha,
  head_branch: 'main', path: '.github/workflows/update-signing.yml',
  repository: { full_name: 'engasnm111/lnwjud' },
  head_repository: { full_name: 'engasnm111/lnwjud' },
};
const artifact = {
  id: 12345, name: 'update-keyfree-evidence-987654321-1', expired: false,
  size_in_bytes: 1200, digest: 'sha256:' + 'b'.repeat(64),
  workflow_run: { id: expected.runId, head_sha: sourceSha },
};
const listing = { total_count: 1, artifacts: [artifact] };
const reject = (r = run, a = listing, e = expected) =>
  assert.throws(() => selectHostedReceiptArtifact(r, a, e), /HOSTED_RECEIPT_ARTIFACT_REFUSED/);

test('selects exact hosted receipt archive metadata without claiming verified bytes', () => {
  assert.deepEqual(selectHostedReceiptArtifact(run, listing, expected), {
    schema: 'lnwjud.hosted-receipt-artifact/v1',
    status: 'github-artifact-metadata-observed-only',
    runId: '987654321', sourceSha,
    artifactId: '12345', archiveSha256: 'b'.repeat(64),
    archiveSizeBytes: '1200',
    archiveApiPath: 'repos/engasnm111/lnwjud/actions/artifacts/12345/zip',
  });
});

test('rejects wrong workflow, ref, repository, attempt, source and incomplete runs', () => {
  for (const change of [
    { path: '.github/workflows/update-signing.yml@refs/heads/dev' },
    { head_branch: 'dev' }, { run_attempt: 2 }, { conclusion: 'failure' },
    { status: 'in_progress' }, { event: 'pull_request' }, { head_sha: 'c'.repeat(40) },
    { repository: { full_name: 'attacker/lnwjud' } },
    { head_repository: { full_name: 'attacker/lnwjud' } },
  ]) reject({ ...run, ...change });
});

test('rejects missing, duplicate, expired, wrong-run, malformed and unpaged artifacts', () => {
  reject(run, { total_count: 0, artifacts: [] });
  reject(run, { total_count: 2, artifacts: [artifact, { ...artifact, id: 12346 }] });
  reject(run, { total_count: 2, artifacts: [artifact] });
  for (const change of [
    { expired: true }, { size_in_bytes: 0 }, { size_in_bytes: 40 * 1024 * 1024 },
    { digest: 'sha256:' + 'Z'.repeat(64) }, { digest: 'sha1:' + 'b'.repeat(64) },
    { workflow_run: { id: 42, head_sha: sourceSha } },
    { workflow_run: { id: expected.runId, head_sha: 'd'.repeat(40) } },
    { name: 'update-keyfree-evidence-987654321-2' },
  ]) reject(run, { total_count: 1, artifacts: [{ ...artifact, ...change }] });
});

test('rejects untrusted expected identity shape and unsafe numeric run ids', () => {
  reject(run, listing, { ...expected, extra: 'untrusted' });
  reject(run, listing, { ...expected, runId: Number.MAX_SAFE_INTEGER + 1 });
  reject(run, listing, { ...expected, sourceSha: 'A'.repeat(40) });
  const accessor = { ...expected };
  Object.defineProperty(accessor, 'sourceSha', { get() { throw new Error('GETTER_EXECUTED'); } });
  reject(run, listing, accessor);
});

const token = 'github_pat_example_token_for_metadata_only';
const json = (value, headers = {}) => new globalThis.Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json', ...headers },
});

test('fetches only the pinned authenticated GitHub API run and artifact listing', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(new globalThis.URL(url).origin, 'https://api.github.com');
    return json(url.includes('/attempts/1') ? run : listing);
  });
  const selected = await fetchHostedReceiptMetadata(expected, token);
  assert.equal(selected.status, 'github-artifact-metadata-observed-only');
  assert.equal(selected.archiveSha256, 'b'.repeat(64));
  assert.deepEqual(urls, [
    'https://api.github.com/repos/engasnm111/lnwjud/actions/runs/987654321/attempts/1',
    'https://api.github.com/repos/engasnm111/lnwjud/actions/runs/987654321/artifacts?per_page=100',
  ]);
});

test('rejects unauthenticated input, pagination, malformed and mismatched GitHub responses', async t => {
  await assert.rejects(fetchHostedReceiptMetadata(expected, ''), /HOSTED_RECEIPT_ARTIFACT_REFUSED/);
  await assert.rejects(fetchHostedReceiptMetadata(expected, 'bad\\ntoken'), /HOSTED_RECEIPT_ARTIFACT_REFUSED/);
  let mode = 'pagination';
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/attempts/1')) return json(run);
    if (mode === 'pagination') return json(listing, { link: '<https://api.github.com/next>; rel="next"' });
    if (mode === 'incomplete') return json({ total_count: 101, artifacts: [artifact] });
    if (mode === 'wrong-run') return json({ total_count: 1, artifacts: [{ ...artifact, workflow_run: { id: 42, head_sha: sourceSha } }] });
    if (mode === 'non-json') return new globalThis.Response('not-json', { headers: { 'content-type': 'text/plain' } });
    return json(listing);
  });
  for (const next of ['pagination', 'incomplete', 'wrong-run', 'non-json']) {
    mode = next;
    await assert.rejects(fetchHostedReceiptMetadata(expected, token), /HOSTED_RECEIPT_ARTIFACT_REFUSED/);
  }
});
