import { Buffer } from 'node:buffer';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { hash, parseStrictJson, rootKey } from './release-envelope.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

const repository = 'engasnm111/lnwjud';
const repositoryId = '1329830515';
const ownerId = '58149374';
const issuer = 'https://token.actions.githubusercontent.com';
const workflowRef = `${repository}/.github/workflows/update-signing.yml@refs/heads/main`;
const bindingFields = ['schema', 'purpose', 'sourceSha', 'sourceRunId', 'sourceRunAttempt', 'builderSha', 'policySha256',
  'candidateSha256', 'manifestSha256', 'recipientSpkiSha256', 'challenge', 'signerRunId', 'signerRunAttempt',
  'signerWorkflowSha', 'previousEnvelopeSha256'];
const contextFields = ['workflowSha', 'runId', 'runAttempt', 'verifierCheckRunId'];
const receiptFields = ['schema', 'status', 'sourceSha', 'sourceRunId', 'builderSha', 'policySha256', 'candidateSha256', 'manifestSha256'];
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function refuse() { throw new Error('SIGNER_RECEIPT_REFUSED'); }

function strings(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length) refuse();
  for (const field of fields)
    if (!Object.hasOwn(descriptors, field) || !Object.hasOwn(descriptors[field], 'value')
      || typeof descriptors[field].value !== 'string' || descriptors[field].value.length > 256) refuse();
  return Object.freeze(Object.fromEntries(fields.map(field => [field, descriptors[field].value])));
}

export function signerBinding(value) {
  const binding = strings(value, bindingFields);
  if (binding.schema !== 'lnwjud.signer-request/v1' || !['baseline', 'update'].includes(binding.purpose)
    || !hex(binding.sourceSha, 40) || !hex(binding.builderSha, 40) || !hex(binding.signerWorkflowSha, 40)
    || !decimal(binding.sourceRunId) || binding.sourceRunAttempt !== '1'
    || !decimal(binding.signerRunId) || !decimal(binding.signerRunAttempt)
    || binding.sourceRunId === binding.signerRunId || binding.sourceSha !== binding.signerWorkflowSha) refuse();
  for (const field of ['policySha256', 'candidateSha256', 'manifestSha256', 'recipientSpkiSha256', 'challenge'])
    if (!hex(binding[field], 64)) refuse();
  if (binding.purpose === 'baseline' ? binding.previousEnvelopeSha256 !== 'none' : !hex(binding.previousEnvelopeSha256, 64)) refuse();
  return binding;
}

export function signerReceiptAudience(value) {
  return `urn:lnwjud:update-signer:v1:${hash(Buffer.from(JSON.stringify(signerBinding(value))))}`;
}

function workflowContext(environment, job) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== repository
    || environment.GITHUB_REPOSITORY_ID !== repositoryId || environment.GITHUB_REPOSITORY_OWNER_ID !== ownerId
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REF_PROTECTED !== 'true' || environment.GITHUB_WORKFLOW_REF !== workflowRef
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA || !hex(environment.GITHUB_SHA, 40)
    || !decimal(environment.GITHUB_RUN_ID) || !decimal(environment.GITHUB_RUN_ATTEMPT)
    || environment.RUNNER_ENVIRONMENT !== 'github-hosted' || environment.GITHUB_JOB !== job) refuse();
  return strings({ workflowSha: environment.GITHUB_WORKFLOW_SHA, runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT }, contextFields.slice(0, 3));
}

export function signerHostContext(environment, job) {
  const context = workflowContext(environment, job);
  if (!decimal(environment.LNWJUD_VERIFIER_CHECK_RUN_ID)) refuse();
  return strings({ ...context, verifierCheckRunId: environment.LNWJUD_VERIFIER_CHECK_RUN_ID }, contextFields);
}

export function signerBindingFromReceipt(value, context, challenge, recipientSpkiSha256, purpose, previousEnvelopeSha256) {
  const receipt = strings(value, receiptFields);
  if (receipt.schema !== 'lnwjud.keyfree-evidence/v1' || receipt.status !== 'key-free-attestations-observed-only') refuse();
  return signerBinding({ schema: 'lnwjud.signer-request/v1', purpose, sourceSha: receipt.sourceSha,
    sourceRunId: receipt.sourceRunId, sourceRunAttempt: '1', builderSha: receipt.builderSha,
    policySha256: receipt.policySha256, candidateSha256: receipt.candidateSha256, manifestSha256: receipt.manifestSha256,
    recipientSpkiSha256, challenge, signerRunId: context.runId, signerRunAttempt: context.runAttempt,
    signerWorkflowSha: context.workflowSha, previousEnvelopeSha256 });
}

function base64url(text, maximum) {
  if (typeof text !== 'string' || text.length === 0 || text.length > maximum * 2 || !/^[A-Za-z0-9_-]+$/.test(text)) refuse();
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length > maximum || bytes.toString('base64url') !== text) refuse();
  return bytes;
}

// Issuer rotation requires a reviewed public-key pin update, never a signer-side download.
export function trustedSignerOidcKeys(now = Math.floor(Date.now() / 1000)) {
  const pins = parseStrictJson(readFileSync(new URL('./github-oidc-pins.json', import.meta.url)), 16384, 4);
  if (pins.issuer !== issuer || !Number.isSafeInteger(pins.notBefore) || !Number.isSafeInteger(pins.expiresAt)
    || !Number.isSafeInteger(now) || pins.notBefore < 0 || pins.expiresAt <= pins.notBefore
    || pins.expiresAt - pins.notBefore > 604800 || now < pins.notBefore || now >= pins.expiresAt
    || !Array.isArray(pins.keys) || pins.keys.length === 0 || pins.keys.length > 16) refuse();
  return pins.keys;
}

export function verifySignerReceipt(token, request, expectedContext, keys, now) {
  const binding = signerBinding(request), context = strings(expectedContext, contextFields);
  if (!hex(context.workflowSha, 40) || !decimal(context.runId) || !decimal(context.runAttempt)
    || !decimal(context.verifierCheckRunId) || binding.signerWorkflowSha !== context.workflowSha
    || binding.signerRunId !== context.runId || binding.signerRunAttempt !== context.runAttempt
    || !Number.isSafeInteger(now) || now < 0 || typeof token !== 'string' || token.length > 32768) refuse();
  const parts = token.split('.');
  if (parts.length !== 3) refuse();
  const header = parseStrictJson(base64url(parts[0], 1024), 1024, 3);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 128
    || Object.keys(header).some(field => !['alg', 'typ', 'kid', 'x5t'].includes(field))) refuse();
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 16) refuse();
  const matches = keys.filter(key => key.kid === header.kid);
  if (matches.length !== 1) refuse();
  const jwk = matches[0];
  if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || jwk.e !== 'AQAB') refuse();
  base64url(jwk.n, 512);
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const bits = key.asymmetricKeyDetails?.modulusLength;
  const signature = base64url(parts[2], 512);
  if (![2048, 3072, 4096].includes(bits) || signature.length !== bits / 8
    || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, signature)) refuse();
  const claims = parseStrictJson(base64url(parts[1], 16384), 16384, 5);
  const expected = { iss: issuer, aud: signerReceiptAudience(binding),
    sub: `repo:engasnm111@${ownerId}/lnwjud@${repositoryId}:ref:refs/heads/main`,
    repository, repository_id: repositoryId, repository_owner: 'engasnm111', repository_owner_id: ownerId,
    repository_visibility: 'public', ref: 'refs/heads/main', ref_type: 'branch', event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted', sha: context.workflowSha, workflow_sha: context.workflowSha,
    workflow_ref: workflowRef, run_id: context.runId, run_attempt: context.runAttempt, check_run_id: context.verifierCheckRunId };
  if (Object.entries(expected).some(([name, value]) => claims[name] !== value)
    || ![true, 'true'].includes(claims.ref_protected) || (claims.environment ?? '') !== ''
    || (claims.head_ref ?? '') !== '' || (claims.base_ref ?? '') !== ''
    || typeof claims.jti !== 'string' || !/^[!-~]{1,128}$/.test(claims.jti)) refuse();
  for (const field of ['iat', 'nbf', 'exp'])
    if (!Number.isSafeInteger(claims[field]) || claims[field] < 0) refuse();
  if (claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 600
    || claims.iat > now + 30 || claims.iat < now - 600 || claims.nbf > now + 30
    || claims.nbf > claims.iat || claims.iat - claims.nbf > 600) refuse();
  return Object.freeze({ tokenSha256: hash(Buffer.from(token)), bindingSha256: hash(Buffer.from(JSON.stringify(binding))),
    challenge: binding.challenge, recipientSpkiSha256: binding.recipientSpkiSha256,
    runId: context.runId, runAttempt: context.runAttempt, jti: claims.jti, expiresAt: claims.exp });
}

async function consumeProof(proof, parent) {
  if (!path.isAbsolute(parent) || await realpath(parent) !== path.resolve(parent)) refuse();
  const directory = path.join(parent, 'lnwjud-signer-receipts');
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) refuse();
  const marker = hash(Buffer.from([proof.runId, proof.runAttempt, proof.challenge, proof.recipientSpkiSha256].join('\0')));
  let file;
  try { file = await open(path.join(directory, marker), 'wx', 0o600); } catch { refuse(); }
  try { await file.writeFile(proof.tokenSha256 + '\n'); await file.sync(); } finally { await file.close(); }
  if (await realpath(directory) !== directory) refuse();
}

export async function withAuthenticatedSignerReceipt(options, action) {
  if (Reflect.ownKeys(options).some(field => !['token', 'request', 'context', 'replayDirectory'].includes(field))) refuse();
  const request = signerBinding(options.request), context = strings(options.context, contextFields);
  const token = options.token;
  const keys = trustedSignerOidcKeys();
  const proof = verifySignerReceipt(token, request, context, keys, Math.floor(Date.now() / 1000));
  await consumeProof(proof, options.replayDirectory);
  verifySignerReceipt(token, request, context, trustedSignerOidcKeys(), Math.floor(Date.now() / 1000));
  return action(proof);
}

export function inspectSignerVerifierJob(run, jobs, expected) {
  const context = strings(expected, contextFields.slice(0, 3));
  if (String(run?.id) !== context.runId || String(run.run_attempt) !== context.runAttempt
    || run.head_sha !== context.workflowSha || run.path !== '.github/workflows/update-signing.yml'
    || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.status !== 'in_progress'
    || run.repository?.id !== Number(repositoryId) || run.head_repository?.id !== Number(repositoryId)
    || !Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length || jobs.jobs.length > 100) refuse();
  const matches = jobs.jobs.filter(job => job.name === 'Verify signing evidence (key-free diagnostic)');
  if (matches.length !== 1) refuse();
  const job = matches[0];
  const prefix = `https://api.github.com/repos/${repository}/check-runs/`;
  if (String(job.run_id) !== context.runId || job.head_sha !== context.workflowSha
    || job.status !== 'completed' || job.conclusion !== 'success'
    || job.runner_group_name !== 'GitHub Actions' || !/^GitHub Actions \d+$/.test(job.runner_name ?? '')
    || !Array.isArray(job.labels) || !job.labels.includes('windows-latest') || job.labels.includes('self-hosted')
    || typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(prefix)) refuse();
  const checkRunId = job.check_run_url.slice(prefix.length);
  if (!decimal(checkRunId)) refuse();
  return checkRunId;
}

function requireKeyFree() {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
}

async function responseJson(response, maximum) {
  if (!response.ok || response.redirected || response.body === null) refuse();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) refuse();
    chunks.push(Buffer.from(chunk));
  }
  return parseStrictJson(Buffer.concat(chunks), maximum, 32);
}

async function githubApi(resource) {
  requireKeyFree();
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) refuse();
  const result = await responseJson(await globalThis.fetch(`https://api.github.com/repos/${repository}/${resource}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lnwjud-signer-receipt' }, redirect: 'error', signal: globalThis.AbortSignal.timeout(20000),
  }), 4 * 1024 * 1024);
  requireKeyFree();
  return result;
}

async function requestProof(audience) {
  requireKeyFree();
  const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.actions.githubusercontent.com')
    || endpoint.username || endpoint.password || endpoint.hash || typeof token !== 'string' || token.length === 0 || token.length > 16384) refuse();
  endpoint.searchParams.set('audience', audience);
  const result = await responseJson(await globalThis.fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    signal: globalThis.AbortSignal.timeout(20000) }), 32768);
  requireKeyFree();
  if (typeof result.value !== 'string' || result.value.length > 32768) refuse();
  return result.value;
}

async function handoffInputs(context) {
  const root = process.env.GITHUB_WORKSPACE;
  if (typeof root !== 'string' || !path.isAbsolute(root) || await realpath(root) !== path.resolve(root)) refuse();
  const policyFile = await readBoundedFile(path.join(root, 'config/update-release-policy.json'), 65536n);
  const policy = parseStrictJson(policyFile.bytes, 65536);
  const { root: recipient } = rootKey(policy, process.env.LNWJUD_SIGNING_KEY_ID, BigInt(Math.floor(Date.now() / 1000)));
  const directory = path.join(root, '_verified-evidence');
  const receiptFile = await readBoundedFile(path.join(directory, 'receipt.json'), 4096n);
  const receipt = parseStrictJson(receiptFile.bytes, 4096);
  const request = signerBindingFromReceipt(receipt, context, process.env.LNWJUD_SIGNER_CHALLENGE, recipient.spkiSha256, 'baseline', 'none');
  if (request.policySha256 !== policyFile.sha256 || request.sourceRunId !== process.env.LNWJUD_SOURCE_RUN_ID) refuse();
  return { request, directory };
}

async function main() {
  if (process.argv.length !== 3) refuse();
  requireKeyFree();
  const operation = process.argv[2];
  if (operation === 'inspect-verifier-job') {
    const context = workflowContext(process.env, 'inspect-verifier-job');
    const run = await githubApi(`actions/runs/${context.runId}/attempts/${context.runAttempt}`);
    const jobs = await githubApi(`actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs?per_page=100`);
    const id = inspectSignerVerifierJob(run, jobs, context);
    if (typeof process.env.GITHUB_OUTPUT !== 'string' || !path.isAbsolute(process.env.GITHUB_OUTPUT)) refuse();
    await appendFile(process.env.GITHUB_OUTPUT, `verifier_check_run_id=${id}\n`);
    process.stdout.write(JSON.stringify({ status: 'verifier-job-observed-only', verifierCheckRunId: id }) + '\n');
    return;
  }
  if (operation === 'mint-proof') {
    const context = workflowContext(process.env, 'verify-candidate-evidence');
    const { request, directory } = await handoffInputs(context);
    const token = await requestProof(signerReceiptAudience(request));
    const claims = parseStrictJson(base64url(token.split('.')[1], 16384), 16384, 5);
    verifySignerReceipt(token, request, { ...context, verifierCheckRunId: claims.check_run_id }, trustedSignerOidcKeys(), Math.floor(Date.now() / 1000));
    await writeFile(path.join(directory, 'signer-request.json'), JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'signer-proof.jwt'), token, { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: 'signer-proof-minted-only', requestSha256: hash(Buffer.from(JSON.stringify(request))) }) + '\n');
    return;
  }
  if (operation === 'receive-proof') {
    const context = signerHostContext(process.env, 'receive-signing-evidence');
    const { request, directory } = await handoffInputs(context);
    const offered = parseStrictJson((await readBoundedFile(path.join(directory, 'signer-request.json'), 4096n)).bytes, 4096);
    if (signerReceiptAudience(offered) !== signerReceiptAudience(request)) refuse();
    const token = (await readBoundedFile(path.join(directory, 'signer-proof.jwt'), 32768n)).bytes.toString('utf8');
    await withAuthenticatedSignerReceipt({ token, request, context, replayDirectory: process.env.RUNNER_TEMP }, proof => {
      process.stdout.write(JSON.stringify({ status: 'authenticated-signer-receiver-validation-only', requestSha256: proof.bindingSha256 }) + '\n');
    });
    return;
  }
  refuse();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { process.stderr.write('SIGNER_RECEIPT_REFUSED\n'); process.exitCode = 1; });
