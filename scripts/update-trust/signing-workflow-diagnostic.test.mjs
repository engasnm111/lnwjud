import test from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { inspectSigningWorkflowContext, inspectSigningWorkflowObservations } from './signing-workflow-diagnostic.mjs';

const commit = 'a'.repeat(40);
const env = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'engasnm111/lnwjud', GITHUB_REPOSITORY_ID: '1329830515',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true',
  GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: commit,
  GITHUB_SHA: commit, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', LNWJUD_VERIFY_RESULT: 'success',
  LNWJUD_VERIFY_ARTIFACT_ID: '12', LNWJUD_VERIFY_MANIFEST_SHA256: 'b'.repeat(64) });
const run = () => ({ id: 42, run_attempt: 1, path: '.github/workflows/update-signing.yml', event: 'workflow_dispatch',
  head_sha: commit, head_branch: 'main', status: 'in_progress', conclusion: null,
  repository: { id: 1329830515 }, head_repository: { id: 1329830515 } });
const jobs = () => ({ total_count: 1, jobs: [{ name: 'verify signing evidence', run_id: 42, head_sha: commit, status: 'completed', conclusion: 'success' }] });
const artifact = () => ({ id: 12, name: 'lnwjud-signing-evidence', expired: false, size_in_bytes: 1024, digest: `sha256:${'c'.repeat(64)}`,
  workflow_run: { id: 42, repository_id: 1329830515, head_repository_id: 1329830515, head_sha: commit } });
const bytes = value => Buffer.from(JSON.stringify(value));
const observe = (context, r, j, a) => inspectSigningWorkflowObservations(context, bytes(r), bytes(j), bytes(a));

test('diagnostic binds a current successful workflow attempt and artifact', () => {
  const result = observe(inspectSigningWorkflowContext(env()), run(), jobs(), artifact());
  assert.equal(result.artifactId, '12');
  assert.equal(result.archiveSha256, 'c'.repeat(64));
  assert.equal(result.archiveSizeBytes, 1024);
  assert.equal(Object.hasOwn(result, 'manifestSha256'), false);
});

test('untrusted workflow context and key-bearing diagnostic refuse', () => {
  for (const change of [
    e => { e.GITHUB_ACTIONS = 'false'; }, e => { e.GITHUB_REPOSITORY_ID = '3'; }, e => { e.GITHUB_REF = 'refs/heads/dev'; },
    e => { e.GITHUB_REF_PROTECTED = 'false'; }, e => { e.GITHUB_EVENT_NAME = 'push'; }, e => { e.GITHUB_WORKFLOW_SHA = 'b'.repeat(40); },
    e => { e.GITHUB_RUN_ATTEMPT = '02'; }, e => { e.GITHUB_RUN_ATTEMPT = '2'; }, e => { e.LNWJUD_VERIFY_RESULT = 'skipped'; },
    e => { e.LNWJUD_VERIFY_MANIFEST_SHA256 = 'A'.repeat(64); }, e => { e.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'fixture'; }
  ]) { const value = env(); change(value); assert.throws(() => inspectSigningWorkflowContext(value)); }
});

test('refuses wrong attempt, incomplete jobs and substituted artifact', () => {
  const context = inspectSigningWorkflowContext(env());
  for (const change of [
    ({ r }) => { r.run_attempt = 2; }, ({ r }) => { r.head_repository.id = 9; }, ({ r }) => { r.status = 'completed'; },
    ({ j }) => { j.total_count = 2; }, ({ j }) => { j.jobs[0].conclusion = 'failure'; },
    ({ j }) => { j.jobs[0].run_id = 41; }, ({ j }) => { j.jobs.push({ ...j.jobs[0] }); j.total_count = 2; },
    ({ a }) => { a.id = 13; }, ({ a }) => { a.expired = true; },
    ({ a }) => { a.workflow_run.id = 41; }, ({ a }) => { a.workflow_run.repository_id = 3; },
    ({ a }) => { a.digest = null; }, ({ a }) => { a.size_in_bytes = 0; }, ({ a }) => { a.size_in_bytes = 5368709121; }
  ]) { const r = run(), j = jobs(), a = artifact(); change({ r, j, a }); assert.throws(() => observe(context, r, j, a)); }
});

test('production diagnostic refuses empty policy before network or input files', () => {
  const cli = fileURLToPath(new URL('./signing-workflow-diagnostic.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [cli], { encoding: 'utf8', windowsHide: true,
    env: { ...env(), SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '', GITHUB_WORKSPACE: process.cwd(),
      GITHUB_TOKEN: 'disposable-fixture', LNWJUD_SIGNING_KEY_ID: 'fixture-only' } });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /^SIGNING_DIAGNOSTIC_REFUSED\r?\n$/);
});
