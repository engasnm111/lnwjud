import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { inspectProtectedSourceContext, inspectProtectedSourceRun, inspectProtectedSourceArtifact } from './protected-source-run.mjs';

const commit = 'a'.repeat(40);
const env = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'engasnm111/lnwjud',
  GITHUB_REPOSITORY_ID: '1329830515', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true',
  GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: commit, GITHUB_SHA: commit, GITHUB_RUN_ID: '900',
  GITHUB_RUN_ATTEMPT: '1', LNWJUD_SOURCE_RUN_ID: '500',
});
const required = {
  'Windows Workspace Release Tests': 'windows-latest',
  'Windows Release Build and Checks': 'windows-latest',
  'Authoritative Release Verification (Windows)': 'ubuntu-24.04',
  'Attested Windows Update Package / resolve-control': 'windows-latest',
  'Attested Windows Update Package / build-package': 'windows-latest',
  'Attested Windows Update Package / attest-package': 'windows-latest',
  'Attested Windows Update Package / prepare-signing-candidate': 'windows-latest',
};
const run = () => ({
  id: 500, run_attempt: 1, event: 'push', path: '.github/workflows/ci.yml',
  head_branch: 'main', head_sha: commit, status: 'completed', conclusion: 'success',
  repository: { id: 1329830515, full_name: 'engasnm111/lnwjud' },
  head_repository: { id: 1329830515 },
});
const jobs = () => ({
  total_count: 7,
  jobs: Object.entries(required).map(([name, label], i) => ({
    id: 200 + i, name, run_id: 500, head_sha: commit,
    status: 'completed', conclusion: 'success', runner_group_name: 'GitHub Actions',
    runner_name: `GitHub Actions ${2000 + i}`, labels: [label],
  })),
});
const observed = (e, r, j) => inspectProtectedSourceRun(inspectProtectedSourceContext(e),
  Buffer.from(JSON.stringify(r)), Buffer.from(JSON.stringify(j)));

test('protected main push source and all required successful hosted jobs are observed, never authorize signing', () => {
  const v = observed(env(), run(), jobs());
  assert.equal(v.status, 'source-ci-observed-only');
  assert.equal(v.sourceRunId, '500');
  assert.equal(v.sourceSha, commit);
  assert.equal(Object.keys(v.jobs).length, 7);
  assert.equal(Object.hasOwn(v, 'canSign'), false);
  assert.equal(Object.hasOwn(v, 'authorization'), false);
});

test('refuses unprotected or synthetic context and any secret in verifier environment', () => {
  for (const change of [
    e => { e.GITHUB_ACTIONS = 'false'; }, e => { e.GITHUB_REF_PROTECTED = 'false'; },
    e => { e.GITHUB_REF = 'refs/heads/dev'; }, e => { e.GITHUB_EVENT_NAME = 'push'; },
    e => { e.GITHUB_REPOSITORY_ID = '7'; }, e => { e.GITHUB_WORKFLOW_SHA = 'b'.repeat(40); },
    e => { e.GITHUB_RUN_ATTEMPT = '2'; }, e => { e.LNWJUD_SOURCE_RUN_ID = '900'; },
    e => { e.LNWJUD_SOURCE_RUN_ID = '0500'; }, e => { e.LNWJUD_SOURCE_RUN_ID = '0'; },
    e => { e.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = ''; },
    e => { e.lnwjud_update_release_private_key_pem = 'fixture-secret'; },
  ]) { const value = env(); change(value); assert.throws(() => inspectProtectedSourceContext(value)); }
});

test('refuses stale, substituted, rerun and incomplete protected CI', () => {
  const changes = [
    ({ r }) => { r.id = 501; }, ({ r }) => { r.run_attempt = 2; },
    ({ r }) => { r.event = 'pull_request'; }, ({ r }) => { r.path = '.github/workflows/other.yml'; },
    ({ r }) => { r.head_branch = 'dev'; }, ({ r }) => { r.head_sha = 'b'.repeat(40); },
    ({ r }) => { r.conclusion = 'cancelled'; }, ({ r }) => { r.status = 'in_progress'; },
    ({ r }) => { r.repository.id = 2; }, ({ r }) => { r.repository.full_name = 'other/repo'; },
    ({ r }) => { r.head_repository.id = 2; },
    ({ j }) => { j.total_count = 8; }, ({ j }) => { j.jobs.pop(); j.total_count--; },
    ({ j }) => { j.jobs.push({ ...j.jobs[0] }); j.total_count++; },
    ({ j }) => { j.jobs[0].run_id = 501; }, ({ j }) => { j.jobs[0].head_sha = 'b'.repeat(40); },
    ({ j }) => { j.jobs[0].conclusion = 'failure'; }, ({ j }) => { j.jobs[0].status = 'in_progress'; },
    ({ j }) => { j.jobs[0].runner_name = 'self-hosted'; },
    ({ j }) => { j.jobs[0].runner_group_name = 'Default'; },
    ({ j }) => { j.jobs[0].labels.push('self-hosted'); },
    ({ j }) => { j.jobs[0].labels = ['ubuntu-latest']; },
    ({ j }) => { j.jobs[0].id = null; },
  ];
  for (const change of changes) {
    const r = run(), j = jobs(); change({ r, j });
    assert.throws(() => observed(env(), r, j));
  }
});


const artifactListing = () => ({
  total_count: 1, artifacts: [{
    id: 700, name: 'update-package-attested-500-1', expired: false, size_in_bytes: 4096,
    digest: `sha256:${'c'.repeat(64)}`,
    workflow_run: { id: 500, repository_id: 1329830515, head_repository_id: 1329830515, head_sha: commit },
  }],
});

test('exact attested package artifact belongs to selected protected run but is not signing authority', () => {
  const result = inspectProtectedSourceArtifact(inspectProtectedSourceContext(env()), Buffer.from(JSON.stringify(artifactListing())));
  assert.deepEqual(result, { artifactId: '700', artifactName: 'update-package-attested-500-1',
    archiveSha256: 'c'.repeat(64), archiveSizeBytes: 4096 });
  assert.equal(Object.hasOwn(result, 'verified'), false);
  assert.equal(Object.hasOwn(result, 'canSign'), false);
});

test('missing, duplicated, expired, substituted and malformed artifact metadata are refused', () => {
  for (const change of [
    value => { value.total_count = 2; },
    value => { value.artifacts.push({ ...value.artifacts[0] }); value.total_count = 2; },
    value => { value.artifacts[0].name = 'update-package-subjects-500-1'; },
    value => { value.artifacts[0].name = 'update-package-attested-501-1'; },
    value => { value.artifacts[0].id = null; },
    value => { value.artifacts[0].expired = true; },
    value => { value.artifacts[0].size_in_bytes = 0; },
    value => { value.artifacts[0].size_in_bytes = 5 * 1024 * 1024 * 1024 + 1; },
    value => { value.artifacts[0].digest = 'sha256:' + 'X'.repeat(64); },
    value => { value.artifacts[0].workflow_run.id = 502; },
    value => { value.artifacts[0].workflow_run.repository_id = 1; },
    value => { value.artifacts[0].workflow_run.head_repository_id = 1; },
    value => { value.artifacts[0].workflow_run.head_sha = 'd'.repeat(40); },
  ]) {
    const value = artifactListing(); change(value);
    assert.throws(() => inspectProtectedSourceArtifact(inspectProtectedSourceContext(env()), Buffer.from(JSON.stringify(value))));
  }
});

test('rejects duplicate JSON fields in source metadata', () => {
  const original = JSON.stringify(run());
  const modified = original.replace('"id":500,', '"id":500,"id":500,');
  assert.throws(() => inspectProtectedSourceRun(inspectProtectedSourceContext(env()),
    Buffer.from(modified), Buffer.from(JSON.stringify(jobs()))));
});
