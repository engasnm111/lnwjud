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
    || !Object.hasOwn(fields.runId, 'value') || !Object.hasOwn(fields.sourceSha, 'value')
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
