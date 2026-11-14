import { Buffer } from 'node:buffer';
import { appendFile, cp, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadProductionPolicy, parseStrictJson } from './release-envelope.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';
import { verifySignedOutput } from './signed-release-output.mjs';

const repository = 'engasnm111/lnwjud';
const refuse = () => { throw new Error('SIGNED_RELEASE_ARTIFACTS_REFUSED'); };
const identifier = value => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
function requireKeyFree() {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
}

export function selectSignedArtifacts(runs, listings, sourceSha, sourceRunId) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[1-9][0-9]{0,19}$/.test(sourceRunId) || !Array.isArray(runs)
    || runs.length > 100 || !Array.isArray(listings) || listings.length !== runs.length) refuse();
  const selected = {};
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index], listing = listings[index];
    if (identifier(run.id) === '' || run.head_sha !== sourceSha || run.head_branch !== 'main'
      || run.path !== '.github/workflows/update-signing.yml' || run.event !== 'workflow_dispatch'
      || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== 1
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || !Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length || listing.total_count > 100) refuse();
    for (const purpose of ['baseline', 'update']) {
      const name = `update-signed-${purpose}-${sourceRunId}-${run.id}-1`;
      const matches = listing.artifacts.filter(item => item.name === name);
      if (matches.length > 1) refuse();
      if (matches.length === 0) continue;
      const artifact = matches[0];
      if (identifier(artifact.id) === '' || artifact.expired !== false || artifact.workflow_run?.id !== run.id
        || artifact.workflow_run.head_sha !== sourceSha || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')) refuse();
      if (!selected[purpose] || BigInt(run.id) > BigInt(selected[purpose].runId))
        selected[purpose] = { runId: String(run.id), artifactId: String(artifact.id), name };
    }
  }
  if (!selected.baseline) refuse();
  return selected;
}

async function api(resource) {
  requireKeyFree();
  const token = process.env.GH_TOKEN;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) refuse();
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/${resource}`, {
    redirect: 'error', signal: globalThis.AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok || response.body === null) refuse();
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) refuse();
    chunks.push(Buffer.from(chunk));
  }
  return parseStrictJson(Buffer.concat(chunks), 4 * 1024 * 1024, 64);
}

export async function stageSignedArtifacts({ workspace, policy, now, sourceSha, sourceRunId }) {
  requireKeyFree();
  if (!path.isAbsolute(workspace) || await realpath(workspace) !== workspace) refuse();
  const baselineDirectory = path.join(workspace, '_release-baseline');
  const baseline = await verifySignedOutput({ directory: baselineDirectory, policy, now, sourceSha, sourceRunId, purpose: 'baseline' });
  const sidecars = path.join(workspace, '_release-sidecars'); await mkdir(sidecars);
  for (const name of await readdir(path.join(baselineDirectory, 'public')))
    await cp(path.join(baselineDirectory, 'public', name), path.join(sidecars, name), { errorOnExist: true, force: false });
  if (process.env.LNWJUD_SIGNED_UPDATE_RUN_ID) {
    const updateDirectory = path.join(workspace, '_release-update');
    const update = await verifySignedOutput({ directory: updateDirectory, policy, now, sourceSha, sourceRunId, purpose: 'update' });
    if (update.identitySha256 !== baseline.identitySha256) refuse();
    await cp(path.join(updateDirectory, 'public/RELEASE-win32-x64.json'), path.join(sidecars, 'RELEASE-win32-x64.json'), { errorOnExist: true, force: false });
  }
  const expectedVersion = JSON.parse((await readBoundedFile(path.join(workspace, 'package.json'), 1048576n)).bytes).version;
  if (baseline.payload.release.version !== expectedVersion) refuse();
  const windows = path.join(workspace, 'release-staging/win32-x64');
  if ((await readdir(windows)).length !== 0) refuse();
  for (const name of await readdir(path.join(baselineDirectory, 'windows')))
    await cp(path.join(baselineDirectory, 'windows', name), path.join(windows, name), { errorOnExist: true, force: false });
  requireKeyFree();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const operation = process.argv[2];
    if (process.argv.length !== 3 || process.env.GITHUB_REPOSITORY !== repository) refuse();
    if (operation === 'select') {
      const listing = await api(`actions/workflows/update-signing.yml/runs?head_sha=${process.env.GITHUB_SHA}&event=workflow_dispatch&status=success&per_page=100`);
      if (!Array.isArray(listing.workflow_runs) || listing.total_count > 100) refuse();
      const runs = listing.workflow_runs;
      const artifacts = [];
      for (const run of runs) {
        if (identifier(run.id) === '') refuse();
        artifacts.push(await api(`actions/runs/${run.id}/artifacts?per_page=100`));
      }
      const selected = selectSignedArtifacts(runs, artifacts, process.env.GITHUB_SHA, process.env.LNWJUD_RELEASE_CI_RUN_ID);
      if (!path.isAbsolute(process.env.GITHUB_ENV ?? '')) refuse();
      for (const [purpose, value] of Object.entries(selected))
        await appendFile(process.env.GITHUB_ENV, `LNWJUD_SIGNED_${purpose.toUpperCase()}_RUN_ID=${value.runId}\nLNWJUD_SIGNED_${purpose.toUpperCase()}_ARTIFACT=${value.name}\n`);
      process.stdout.write('SIGNED_RELEASE_ARTIFACTS_SELECTED\n');
    } else if (operation === 'stage') {
      await stageSignedArtifacts({ workspace: process.env.GITHUB_WORKSPACE, policy: loadProductionPolicy(),
        now: BigInt(Math.floor(Date.now() / 1000)), sourceSha: process.env.GITHUB_SHA, sourceRunId: process.env.LNWJUD_RELEASE_CI_RUN_ID });
      process.stdout.write('SIGNED_RELEASE_ARTIFACTS_STAGED\n');
    } else refuse();
  } catch { process.stderr.write('SIGNED_RELEASE_ARTIFACTS_REFUSED\n'); process.exitCode = 1; }
}
