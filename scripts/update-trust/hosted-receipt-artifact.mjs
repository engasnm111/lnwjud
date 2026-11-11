import { Buffer } from 'node:buffer';
import { parseStrictJson } from './release-envelope.mjs';
import { withDownloadedSigningArchive } from './signing-archive-spool.mjs';
import { inspectHostedReceiptZip } from './hosted-receipt-zip.mjs';

// Read-only GitHub API metadata selector for a future authenticated receipt fetch.
// This does NOT download or authenticate archive bytes, verify the OIDC receipt,
// establish a signer identity, or grant release/installation permission.
const refuse = () => { throw new Error('HOSTED_RECEIPT_ARTIFACT_REFUSED'); };
const repo = 'engasnm111/lnwjud';
const workflowPath = '.github/workflows/update-signing.yml';
const sha1 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function snapshotExpected(value) {
  if (!plain(value)) refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).sort().join(',') !== 'runId,sourceSha'
    || !Object.prototype.hasOwnProperty.call(fields.runId, 'value') || !Object.prototype.hasOwnProperty.call(fields.sourceSha, 'value')
    || !positiveId(fields.runId.value) || !sha1(fields.sourceSha.value)) refuse();
  return Object.freeze({ runId: fields.runId.value, sourceSha: fields.sourceSha.value });
}

/**
 * Select one completed, protected-main, first-attempt receipt artifact by exact
 * run identity. The caller MUST obtain both JSON responses from authenticated
 * GitHub API endpoints for this exact run, exhaust pagination, then independently
 * authenticate the downloaded ZIP digest and the receipt OIDC attestation.
 */
export function selectHostedReceiptArtifact(run, listing, expected) {
  const bound = snapshotExpected(expected);
  if (!plain(run) || !plain(listing) || !Array.isArray(listing.artifacts)
    || !Number.isSafeInteger(listing.total_count)
    || listing.total_count !== listing.artifacts.length
    || run.id !== bound.runId || run.run_attempt !== 1
    || run.event !== 'workflow_dispatch' || run.status !== 'completed'
    || run.conclusion !== 'success' || run.head_sha !== bound.sourceSha
    || run.head_branch !== 'main' || run.path !== workflowPath
    || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo)
    refuse();

  const name = `update-keyfree-evidence-${bound.runId}-1`;
  const matches = listing.artifacts.filter(item => item?.name === name);
  if (matches.length !== 1) refuse();
  const artifact = matches[0];
  if (!positiveId(artifact.id) || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes)
    || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 32 * 1024 * 1024
    || typeof artifact.digest !== 'string' || !artifact.digest.startsWith('sha256:')
    || !sha256(artifact.digest.slice(7))
    || artifact.workflow_run?.id !== bound.runId
    || artifact.workflow_run?.head_sha !== bound.sourceSha)
    refuse();
  return Object.freeze({
    schema: 'lnwjud.hosted-receipt-artifact/v1',
    status: 'github-artifact-metadata-observed-only',
    runId: String(bound.runId), sourceSha: bound.sourceSha,
    artifactId: String(artifact.id), archiveSha256: artifact.digest.slice(7),
    archiveSizeBytes: String(artifact.size_in_bytes),
    archiveApiPath: `repos/${repo}/actions/artifacts/${artifact.id}/zip`,
  });
}

const apiMaximum = 4 * 1024 * 1024;

async function readAuthenticatedGithubJson(relative, token) {
  const response = await globalThis.fetch(`https://api.github.com/repos/${repo}/${relative}`, {
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(30000),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lnwjud-receipt-metadata-reader',
    },
  });
  const body = response.body;
  if (response.status !== 200 || response.headers.get('link') !== null
    || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    refuse();
  if (!body) throw new Error('HOSTED_RECEIPT_ARTIFACT_REFUSED');
  const chunks = [Buffer.alloc(0)];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.byteLength;
    if (length > apiMaximum) refuse();
    chunks.push(Buffer.from(chunk));
  }
  return parseStrictJson(Buffer.concat(chunks), apiMaximum, 64);
}

/**
 * Fetch the exact run and complete artifact listing from GitHub's authenticated
 * API without accepting redirects or caller-provided URLs. This authenticates
 * only the API transport and metadata, NOT archive bytes, receipt attestation,
 * independent signing authority or installation permission.
 */
export async function fetchHostedReceiptMetadata(expected, token) {
  const bound = snapshotExpected(expected);
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096
    || !/^[A-Za-z0-9_]+$/.test(token)) refuse();
  try {
    const [run, listing] = await Promise.all([
      readAuthenticatedGithubJson(`actions/runs/${bound.runId}/attempts/1`, token),
      readAuthenticatedGithubJson(`actions/runs/${bound.runId}/artifacts?per_page=100`, token),
    ]);
    if (listing.total_count > 100) refuse();
    return selectHostedReceiptArtifact(run, listing, bound);
  } catch {
    refuse();
  }
}

/**
 * Acquire one hosted receipt ZIP using authenticated run/artifact metadata,
 * exact archive SHA-256 and a native quarantined spool limited to 32 MiB.
 * The consumer receives digest-checked ZIP bytes only; it MUST independently
 * inspect receipt.json and verify receipt.bundle.json with the pinned OIDC
 * verifier before any signing or production authorization decision.
 */
export async function withDigestCheckedHostedReceiptArchive({ expected, token, addon, filename, fetchImpl }, consume) {
  if (typeof consume !== 'function') refuse();
  const selected = await fetchHostedReceiptMetadata(expected, token);
  return withDownloadedSigningArchive({
    addon, filename, token, maxArchiveBytes: 32 * 1024 * 1024,
    artifact: {
      artifactId: selected.artifactId,
      archiveSha256: selected.archiveSha256,
      archiveSizeBytes: Number(selected.archiveSizeBytes),
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }, reader => consume(reader, selected));
}

/** Expose only the two bounded receipt ZIP members after archive digest validation. */
export function withInspectedHostedReceiptArchive(options, consume) {
  if (typeof consume !== 'function') refuse();
  return withDigestCheckedHostedReceiptArchive(options, (reader, selected) =>
    consume(inspectHostedReceiptZip(reader), selected));
}
