import { Buffer } from 'node:buffer';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { hash, parseStrictJson, refuse, requireConfigured } from './release-envelope.mjs';
import { acquirePinnedVerifier } from './pinned-verifier.mjs';

export async function readBoundedFile(filename, maximum) {
  const resolved = path.resolve(filename);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(resolved) !== resolved
    || BigInt(info.size) > maximum) refuse('RELEASE_INPUT_INVALID');
  const file = await open(resolved, 'r');
  try {
    const before = await file.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) refuse('RELEASE_INPUT_CHANGED');
    const digest = createHash('sha256');
    const retained = [];
    let length = 0n;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      length += BigInt(chunk.length);
      if (length > maximum) refuse('RELEASE_INPUT_INVALID');
      digest.update(chunk);
      if (maximum <= 16n * 1024n * 1024n) retained.push(chunk);
    }
    const after = await file.stat();
    const current = await lstat(resolved);
    if (length !== BigInt(before.size) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino) refuse('RELEASE_INPUT_CHANGED');
    return { sha256: digest.digest('hex'), sizeBytes: length.toString(), bytes: Buffer.concat(retained) };
  } finally { await file.close(); }
}

async function verifier(policy) {
  requireConfigured(policy);
  const configured = policy.verifier;
  if (!['gh', 'gh.exe'].includes(configured.filename) || !/^\d+\.\d+\.\d+$/.test(configured.version)
    || !/^[a-f0-9]{64}$/.test(configured.sha256)) refuse('RELEASE_VERIFIER_UNTRUSTED');
  const session = await acquirePinnedVerifier(configured);
  try {
    const version = (await session.run(['version'])).toString('utf8').split(/\r?\n/)[0];
    if (!version.startsWith(`gh version ${configured.version} `)) refuse('RELEASE_VERIFIER_UNTRUSTED');
    return session;
  } catch (error) { await session.close(); throw error; }
}

function verifiedTimestamp(record, issuedAt) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'timestamp,type,uri'
    || !['Tlog', 'TimestampAuthority'].includes(record.type) || typeof record.uri !== 'string' || record.uri.length > 2048
    || typeof record.timestamp !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(record.timestamp)) return false;
  let uri;
  try { uri = new URL(record.uri); } catch { return false; }
  const milliseconds = Date.parse(record.timestamp);
  return uri.protocol === 'https:' && uri.username === '' && uri.password === '' && uri.hash === ''
    && Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 253402300799000
    && new Date(milliseconds).toISOString().slice(0, 19) === record.timestamp.slice(0, 19)
    && BigInt(Math.floor(milliseconds / 1000)) <= BigInt(issuedAt) + 300n;
}

export function selectVerifiedAttestation(resultBytes, payload, identity, authority) {
  const results = parseStrictJson(resultBytes, 4 * 1024 * 1024, 64);
  if (!Array.isArray(results) || results.length === 0 || results.length > 64) refuse('RELEASE_ATTESTATION_REFUSED');
  const source = payload.source;
  const expectedRun = `${source.repository}/actions/runs/${source.runId}/attempts/${source.runAttempt}`;
  const matched = results.filter(result => {
    const verified = result?.verificationResult;
    const certificate = verified?.signature?.certificate;
    const statement = verified?.statement;
    return certificate?.issuer === authority.issuer && certificate.subjectAlternativeName === authority.builderWorkflowUri
      && certificate.sourceRepositoryURI === source.repository && certificate.sourceRepositoryDigest === source.commit
      && certificate.sourceRepositoryRef === source.ref && certificate.buildSignerURI === authority.builderWorkflowUri
      && certificate.buildSignerDigest === authority.builderDigest && certificate.buildConfigURI === authority.buildConfigUri
      && authority.buildConfigDigestRule === 'source-commit' && certificate.buildConfigDigest === source.commit && certificate.runnerEnvironment === 'github-hosted'
      && certificate.runInvocationURI === expectedRun && Array.isArray(verified.verifiedTimestamps)
      && verified.verifiedTimestamps.length > 0 && verified.verifiedTimestamps.length <= 16
      && verified.verifiedTimestamps.every(timestamp => verifiedTimestamp(timestamp, payload.issuedAt))
      && verified.verifiedTimestamps.some(timestamp => timestamp.type === 'Tlog')
      && statement?.predicateType === 'https://slsa.dev/provenance/v1' && Array.isArray(statement.subject)
      && statement.subject.some(subject => subject?.name === identity.name && subject.digest?.sha256 === identity.sha256);
  });
  if (matched.length === 0) refuse('RELEASE_ATTESTATION_REFUSED');
  return matched.length;
}

export async function authenticateBuildEvidence(payload, paths, policy) {
  requireConfigured(policy);
  const authorities = policy.authorities.filter(authority => authority.repository === payload.source.repository
    && authority.workflow === payload.source.workflow && authority.ref === payload.source.ref);
  if (authorities.length !== 1) refuse('RELEASE_SOURCE_UNTRUSTED');
  const authority = authorities[0];
  if (authority.issuer !== 'https://token.actions.githubusercontent.com' || authority.runnerEnvironment !== 'github-hosted'
    || !/^[a-f0-9]{40}$/.test(authority.builderDigest) || authority.buildConfigDigestRule !== 'source-commit'
    || typeof authority.builderWorkflowUri !== 'string' || typeof authority.buildConfigUri !== 'string') refuse('RELEASE_SOURCE_UNTRUSTED');
  const session = await verifier(policy);
  try {
    const run = args => session.run(args);
    const source = payload.source;
    const runBytes = await run(['api', `repos/engasnm111/lnwjud/actions/runs/${source.runId}/attempts/${source.runAttempt}`]);
    const actualRun = parseStrictJson(runBytes, 4 * 1024 * 1024, 64);
    if (actualRun.status !== 'completed' || actualRun.conclusion !== 'success' || actualRun.event !== 'push'
      || actualRun.head_sha !== source.commit || actualRun.head_branch !== source.ref.slice('refs/heads/'.length)
      || actualRun.path !== source.workflow || String(actualRun.id) !== source.runId || String(actualRun.run_attempt) !== source.runAttempt) refuse('RELEASE_BUILD_RUN_REFUSED');
    let provenanceBytes;
    for (const kind of ['artifact', 'provenance']) {
      const identity = payload[kind];
      await session.pinInputs([paths[kind], paths[`${kind}Bundle`]]);
      const actual = await readBoundedFile(paths[kind], BigInt(policy.limits[kind === 'artifact' ? 'maximumPackageBytes' : 'maximumProvenanceBytes']));
      if (actual.sha256 !== identity.sha256 || actual.sizeBytes !== identity.sizeBytes || path.basename(paths[kind]) !== identity.name) refuse('RELEASE_SUBJECT_CHANGED');
      const bundle = await readBoundedFile(paths[`${kind}Bundle`], 16n * 1024n * 1024n);
      if (bundle.sha256 !== payload.buildEvidence[`${kind}AttestationSha256`]) refuse('RELEASE_SUBJECT_CHANGED');
      const verified = await run(['attestation', 'verify', path.resolve(paths[kind]), '--repo', 'engasnm111/lnwjud',
        '--bundle', path.resolve(paths[`${kind}Bundle`]), '--cert-oidc-issuer', authority.issuer,
        '--signer-workflow', authority.builderWorkflowUri.replace('https://github.com/', '').split('@')[0],
        '--signer-digest', authority.builderDigest, '--source-digest', source.commit, '--source-ref', source.ref,
        '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json']);
      selectVerifiedAttestation(verified, payload, identity, authority);
      if ((await readBoundedFile(paths[kind], BigInt(identity.sizeBytes))).sha256 !== identity.sha256
        || (await readBoundedFile(paths[`${kind}Bundle`], 16n * 1024n * 1024n)).sha256 !== bundle.sha256) refuse('RELEASE_SUBJECT_CHANGED');
      if (kind === 'provenance') provenanceBytes = actual.bytes;
    }
    const provenance = parseStrictJson(provenanceBytes, Number(policy.limits.maximumProvenanceBytes), 64);
    const artifact = provenance.artifacts?.find(entry => entry?.name === payload.artifact.name);
    if (provenance.product !== payload.product || provenance.version !== payload.version || provenance.platform !== payload.platform
      || provenance.arch !== payload.architecture || provenance.source?.repository !== source.repository
      || provenance.source?.commit !== source.commit || provenance.source?.dirty !== false
      || provenance.build?.environment !== 'github-actions' || provenance.build.runId !== source.runId
      || provenance.build.runAttempt !== source.runAttempt || provenance.build.ref !== source.ref
      || artifact?.sha256 !== payload.artifact.sha256 || String(artifact?.sizeBytes) !== payload.artifact.sizeBytes) refuse('RELEASE_PROVENANCE_REFUSED');
    return { artifactSha256: payload.artifact.sha256, provenanceSha256: hash(provenanceBytes) };
  } finally { await session.close(); }
}
