import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseStrictJson, refuse, requireConfigured } from './release-envelope.mjs';
import { inspectSigningFiles } from './signing-files-diagnostic.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

const repository = 'engasnm111/lnwjud';
const repositoryId = '1329830515';
const workflow = '.github/workflows/update-signing.yml';
const jobName = 'verify signing evidence';
const artifactName = 'lnwjud-signing-evidence';
const integer = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
const id = value => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function inspectSigningWorkflowContext(environment) {
  const value = { repository: environment.GITHUB_REPOSITORY, repositoryId: environment.GITHUB_REPOSITORY_ID,
    runId: environment.GITHUB_RUN_ID, attempt: environment.GITHUB_RUN_ATTEMPT, commit: environment.GITHUB_SHA,
    artifactId: environment.LNWJUD_VERIFY_ARTIFACT_ID, manifestSha256: environment.LNWJUD_VERIFY_MANIFEST_SHA256 };
  if (environment.GITHUB_ACTIONS !== 'true' || value.repository !== repository || value.repositoryId !== repositoryId
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REF_PROTECTED !== 'true' || environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main`
    || environment.GITHUB_WORKFLOW_SHA !== value.commit || !/^[a-f0-9]{40}$/.test(value.commit ?? '')
    || !integer(value.runId) || value.attempt !== '1' || !integer(value.artifactId) || !digest(value.manifestSha256)
    || environment.LNWJUD_VERIFY_RESULT !== 'success' || environment.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM) refuse('SIGNING_CONTEXT_REFUSED');
  return Object.freeze(value);
}

export function inspectSigningWorkflowObservations(context, runBytes, jobsBytes, artifactBytes) {
  const run = parseStrictJson(runBytes, 4 * 1024 * 1024, 64);
  const jobs = parseStrictJson(jobsBytes, 4 * 1024 * 1024, 64);
  const artifact = parseStrictJson(artifactBytes, 4 * 1024 * 1024, 64);
  if (id(run.id) !== context.runId || String(run.run_attempt) !== context.attempt || run.path !== workflow
    || run.event !== 'workflow_dispatch' || run.head_sha !== context.commit || run.head_branch !== 'main'
    || run.status !== 'in_progress' || run.conclusion !== null
    || id(run.repository?.id) !== repositoryId || id(run.head_repository?.id) !== repositoryId
    || !Array.isArray(jobs.jobs) || !Number.isSafeInteger(jobs.total_count) || jobs.total_count !== jobs.jobs.length
    || jobs.total_count > 100) refuse('SIGNING_RUN_REFUSED');
  const matching = jobs.jobs.filter(job => job?.name === jobName);
  if (matching.length !== 1 || id(matching[0].run_id) !== context.runId || matching[0].head_sha !== context.commit
    || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') refuse('SIGNING_JOB_REFUSED');
  const owner = artifact.workflow_run;
  if (id(artifact.id) !== context.artifactId || artifact.name !== artifactName || artifact.expired !== false
    || id(owner?.id) !== context.runId || id(owner?.repository_id) !== repositoryId
    || id(owner?.head_repository_id) !== repositoryId || owner?.head_sha !== context.commit
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 5 * 1024 * 1024 * 1024
    || typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) refuse('SIGNING_ARTIFACT_REFUSED');
  return Object.freeze({ artifactId: context.artifactId, archiveSha256: artifact.digest.slice(7), archiveSizeBytes: artifact.size_in_bytes });
}

async function getApi(pathname, token) {
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/${pathname}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
      'user-agent': 'lnwjud-signing-diagnostic' }, redirect: 'error', signal: globalThis.AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body) refuse('SIGNING_API_REFUSED');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 4 * 1024 * 1024) refuse('SIGNING_API_REFUSED');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) refuse('SIGNING_CONTEXT_REFUSED');
    const context = inspectSigningWorkflowContext(process.env);
    const token = process.env.GITHUB_TOKEN;
    const workspace = process.env.GITHUB_WORKSPACE, keyId = process.env.LNWJUD_SIGNING_KEY_ID;
    if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || typeof workspace !== 'string'
      || !path.isAbsolute(workspace) || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) refuse('SIGNING_CONTEXT_REFUSED');
    const policyBytes = (await readBoundedFile(fileURLToPath(new URL('../../config/update-release-policy.json', import.meta.url)), 65536n)).bytes;
    requireConfigured(parseStrictJson(policyBytes, 65536));
    const [run, jobs, artifact] = await Promise.all([
      getApi(`actions/runs/${context.runId}/attempts/${context.attempt}`, token),
      getApi(`actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100`, token),
      getApi(`actions/artifacts/${context.artifactId}`, token),
    ]);
    const observed = inspectSigningWorkflowObservations(context, run, jobs, artifact);
    const incoming = path.join(path.resolve(workspace), '_lnwjud-signing-input');
    const manifest = await readBoundedFile(path.join(incoming, 'manifest.json'), 32768n);
    const files = await inspectSigningFiles(path.join(incoming, 'files'), manifest.bytes, policyBytes,
      () => BigInt(Math.floor(Date.now() / 1000)), keyId, context.manifestSha256, context.repositoryId, context.runId, context.attempt);
    process.stdout.write(`${JSON.stringify({ status: 'diagnostic-only', ...observed, ...files })}\n`);
  } catch {
    process.stderr.write('SIGNING_DIAGNOSTIC_REFUSED\n');
    process.exitCode = 1;
  }
}
