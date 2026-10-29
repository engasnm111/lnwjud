import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { canonicalBase64, expectedArtifactName, hash, parseStrictJson, refuse, requireConfigured, rootKey, validateShape } from './release-envelope.mjs';
import { releaseIdentity } from './release-identity.mjs';

const domain = Buffer.from('lnwjud-update-release-v2\0', 'ascii');
const schemaHash = 'ad9d956016199f1519bf0b4ff0e784991ddd49ca239614021882b064eb802ab6';
let schemaText;
try {
  schemaText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(new URL('../../config/update-release-authorization-v2.json', import.meta.url))).replace(/\r\n/g, '\n');
} catch { refuse('RELEASE_AUTHORIZATION_SCHEMA_VERSION_MISMATCH'); }
const schemaBytes = Buffer.from(schemaText, 'utf8');
if (hash(schemaBytes) !== schemaHash) refuse('RELEASE_AUTHORIZATION_SCHEMA_VERSION_MISMATCH');
const schema = parseStrictJson(schemaBytes, 65536, 12);

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function inspectAuthorizationPayloadV2(payloadBytes, policy, now, purpose, keyId) {
  requireConfigured(policy);
  if (!['baseline', 'update'].includes(purpose)) refuse('RELEASE_AUTHORIZATION_PURPOSE_INVALID');
  if (typeof now !== 'bigint' || now < 0n || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  const { root } = rootKey(policy, keyId, now);
  const payload = validateShape(parseStrictJson(payloadBytes, schema.limits.payloadBytes, schema.limits.maxDepth),
    purpose === 'baseline' ? 'baselinePayload' : 'updatePayload', schema);
  const issued = BigInt(payload.issuedAt);
  const expiry = BigInt(payload.expiresAt);
  if (payload.policyRevision !== policy.revision) refuse('RELEASE_POLICY_MISMATCH');
  if (issued !== BigInt(payload.notBefore) || expiry <= issued || now < issued || now >= expiry
    || issued > now + BigInt(policy.limits.maximumFutureSkewSeconds)
    || expiry - issued > BigInt(policy.limits.maximumValiditySeconds)) refuse('RELEASE_TIME_INVALID');
  if (issued < BigInt(root.notBefore) || issued >= BigInt(root.expiresAt)) refuse('RELEASE_KEY_UNTRUSTED');
  const release = payload.release;
  if (!policy.authorities.some(authority => authority.repository === release.source.repository
    && authority.workflow === release.source.workflow && authority.ref === release.source.ref)) refuse('RELEASE_SOURCE_UNTRUSTED');
  if (release.artifact.name !== expectedArtifactName(release.platform, release.architecture, release.distribution, release.version)
    || release.provenance.name !== 'PROVENANCE.json'
    || BigInt(release.artifact.sizeBytes) > BigInt(policy.limits.maximumPackageBytes)
    || BigInt(release.provenance.sizeBytes) > BigInt(policy.limits.maximumProvenanceBytes)) refuse('RELEASE_ARTIFACT_INVALID');
  return Object.freeze({ payload: freeze(payload), identitySha256: releaseIdentity(Buffer.from(JSON.stringify(release), 'utf8')) });
}

export function authenticateAuthorizationV2(envelopeBytes, policy, now, purpose) {
  requireConfigured(policy);
  if (!['baseline', 'update'].includes(purpose)) refuse('RELEASE_AUTHORIZATION_PURPOSE_INVALID');
  if (typeof now !== 'bigint' || now < 0n || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  if (!Buffer.isBuffer(envelopeBytes) || envelopeBytes.length > schema.limits.envelopeBytes) refuse('RELEASE_JSON_INVALID');
  const snapshot = Buffer.from(envelopeBytes);
  const envelope = validateShape(parseStrictJson(snapshot, schema.limits.envelopeBytes, schema.limits.maxDepth), 'envelope', schema);
  const payloadBytes = canonicalBase64(envelope.payload, schema.limits.payloadBytes);
  const signature = canonicalBase64(envelope.signature, 64);
  const { key } = rootKey(policy, envelope.keyId, now);
  if (signature.length !== 64 || !verify('sha256', Buffer.concat([domain, payloadBytes]), { key, dsaEncoding: 'ieee-p1363' }, signature))
    refuse('RELEASE_SIGNATURE_INVALID');
  const inspected = inspectAuthorizationPayloadV2(payloadBytes, policy, now, purpose, envelope.keyId);
  return Object.freeze({ ...inspected, keyId: envelope.keyId, envelopeSha256: hash(snapshot), payloadSha256: hash(payloadBytes) });
}
