import { Buffer } from 'node:buffer';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson, refuse } from './release-envelope.mjs';

const repository = 'engasnm111/lnwjud';
const repositoryId = '1329830515';
const workflow = '.github/workflows/update-signing.yml';
const ciWorkflow = '.github/workflows/ci.yml';
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
const identifier = value => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const requirements = Object.freeze({
  'Windows Workspace Release Tests': 'windows-latest',
  'Windows Release Build and Checks': 'windows-latest',
  'Authoritative Release Verification (Windows)': 'ubuntu-24.04',
  'Attested Windows Update Package / resolve-control': 'windows-latest',
  'Attested Windows Update Package / build-package': 'windows-latest',
  'Attested Windows Update Package / attest-package': 'windows-latest',
  'Attested Windows Update Package / prepare-signing-candidate': 'windows-latest',
});

export function inspectProtectedSourceContext(environment) {
  const current = environment.GITHUB_RUN_ID;
  const selected = environment.LNWJUD_SOURCE_RUN_ID;
  const commit = environment.GITHUB_SHA;
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== repository
    || environment.GITHUB_REPOSITORY_ID !== repositoryId || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_REF_PROTECTED !== 'true'
    || environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main`
    || environment.GITHUB_WORKFLOW_SHA !== commit || !/^[a-f0-9]{40}$/.test(commit ?? '')
    || environment.GITHUB_RUN_ATTEMPT !== '1' || !decimal(current) || !decimal(selected) || selected === current
    || Object.keys(environment).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM'))
    refuse('SIGNING_SOURCE_CONTEXT_REFUSED');
  return Object.freeze({ commit, sourceRunId: selected });
}

export function inspectProtectedSourceRun(context, runBytes, jobsBytes) {
  const run = parseStrictJson(runBytes, 4 * 1024 * 1024, 64);
  const response = parseStrictJson(jobsBytes, 4 * 1024 * 1024, 64);
  if (identifier(run?.id) !== context.sourceRunId || run.run_attempt !== 1
    || run.event !== 'push' || run.path !== ciWorkflow || run.head_branch !== 'main'
    || run.head_sha !== context.commit || run.status !== 'completed' || run.conclusion !== 'success'
    || identifier(run.repository?.id) !== repositoryId || run.repository?.full_name !== repository
    || identifier(run.head_repository?.id) !== repositoryId
    || !Array.isArray(response.jobs) || !Number.isSafeInteger(response.total_count)
    || response.total_count !== response.jobs.length || response.total_count > 100)
    refuse('SIGNING_SOURCE_RUN_REFUSED');
  const jobs = Object.create(null);
  for (const [name, label] of Object.entries(requirements)) {
    const candidates = response.jobs.filter(job => job?.name === name);
    if (candidates.length !== 1) refuse('SIGNING_SOURCE_JOB_REFUSED');
    const job = candidates[0];
    if (identifier(job.id) === '' || identifier(job.run_id) !== context.sourceRunId
      || job.head_sha !== context.commit || job.status !== 'completed' || job.conclusion !== 'success'
      || job.runner_group_name !== 'GitHub Actions'
      || typeof job.runner_name !== 'string' || !/^GitHub Actions [1-9][0-9]*$/.test(job.runner_name)
      || !Array.isArray(job.labels) || job.labels.length !== 1 || job.labels[0] !== label)
      refuse('SIGNING_SOURCE_JOB_REFUSED');
    jobs[name] = String(job.id);
  }
  return Object.freeze({ status: 'source-ci-observed-only', sourceRunId: context.sourceRunId,
    sourceSha: context.commit, jobs: Object.freeze(jobs) });
}

export function inspectProtectedSourceArtifact(context, artifactsBytes) {
  const listing = parseStrictJson(artifactsBytes, 4 * 1024 * 1024, 64);
  if (!Array.isArray(listing.artifacts) || !Number.isSafeInteger(listing.total_count)
    || listing.total_count !== listing.artifacts.length || listing.total_count > 100)
    refuse('SIGNING_SOURCE_ARTIFACT_REFUSED');
  const inspect = (prefix) => {
    const expectedName = `${prefix}-${context.sourceRunId}-1`;
    const matches = listing.artifacts.filter(item => item?.name === expectedName);
    if (matches.length !== 1) refuse('SIGNING_SOURCE_ARTIFACT_REFUSED');
    const item = matches[0], owner = item.workflow_run;
    if (identifier(item.id) === '' || item.expired !== false
      || !Number.isSafeInteger(item.size_in_bytes) || item.size_in_bytes < 1 || item.size_in_bytes > 5 * 1024 * 1024 * 1024
      || typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest)
      || identifier(owner?.id) !== context.sourceRunId
      || identifier(owner?.repository_id) !== repositoryId
      || identifier(owner?.head_repository_id) !== repositoryId
      || owner?.head_sha !== context.commit)
      refuse('SIGNING_SOURCE_ARTIFACT_REFUSED');
    return { artifactId: String(item.id), artifactName: expectedName,
      archiveSha256: item.digest.slice(7), archiveSizeBytes: item.size_in_bytes };
  };
  const attested = inspect('update-package-attested');
  const candidate = inspect('update-package-signing');
  if (attested.artifactId === candidate.artifactId) refuse('SIGNING_SOURCE_ARTIFACT_REFUSED');
  return Object.freeze({ ...attested, signingCandidateArtifactId: candidate.artifactId,
    signingCandidateArtifactName: candidate.artifactName,
    signingCandidateArchiveSha256: candidate.archiveSha256,
    signingCandidateArchiveSizeBytes: candidate.archiveSizeBytes });
}

async function api(relative, token) {
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/${relative}`, {
    redirect: 'error', signal: globalThis.AbortSignal.timeout(30000),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28', 'user-agent': 'lnwjud-signing-source-preflight' },
  });
  if (!response.ok || !response.body) refuse('SIGNING_SOURCE_API_REFUSED');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) refuse('SIGNING_SOURCE_API_REFUSED');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) refuse('SIGNING_SOURCE_CONTEXT_REFUSED');
    const context = inspectProtectedSourceContext(process.env);
    const token = process.env.GITHUB_TOKEN;
    if (typeof token !== 'string' || token.length < 10 || token.length > 4096)
      refuse('SIGNING_SOURCE_CONTEXT_REFUSED');
    const [run, jobs, artifacts] = await Promise.all([
      api(`actions/runs/${context.sourceRunId}/attempts/1`, token),
      api(`actions/runs/${context.sourceRunId}/attempts/1/jobs?per_page=100`, token),
      api(`actions/runs/${context.sourceRunId}/artifacts?per_page=100`, token),
    ]);
    process.stdout.write(`${JSON.stringify({ ...inspectProtectedSourceRun(context, run, jobs),
      ...inspectProtectedSourceArtifact(context, artifacts) })}\n`);
  } catch {
    process.stderr.write('SIGNING_SOURCE_PREFLIGHT_REFUSED\n');
    process.exitCode = 1;
  }
}
