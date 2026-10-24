import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { TextDecoder } from 'node:util';

export const schema = JSON.parse(readFileSync(new URL('../../config/update-release-schema.json', import.meta.url), 'utf8'));
export const domain = Buffer.from('lnwjud-update-release-v1\0', 'ascii');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function refuse(code) { throw new Error(code); }

export function parseStrictJson(bytes, maximum, maxDepth = schema.limits.maxDepth) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum || bytes.length === 0
    || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) refuse('RELEASE_JSON_INVALID');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { refuse('RELEASE_JSON_INVALID'); }
  let offset = 0;
  function white() { while (offset < text.length && /[\t\r\n ]/.test(text[offset])) offset++; }
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') { offset++; continue; }
      if (character === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, offset)); } catch { refuse('RELEASE_JSON_INVALID'); }
        for (let index = 0; index < value.length; index++) {
          const code = value.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(++index);
            if (!(low >= 0xdc00 && low <= 0xdfff)) refuse('RELEASE_JSON_INVALID');
          } else if (code >= 0xdc00 && code <= 0xdfff) refuse('RELEASE_JSON_INVALID');
        }
        return value;
      }
    }
    refuse('RELEASE_JSON_INVALID');
  }
  function value(depth) {
    if (depth > maxDepth) refuse('RELEASE_JSON_INVALID');
    white();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++;
      const object = Object.create(null);
      white();
      if (text[offset] === '}') { offset++; return object; }
      while (true) {
        white();
        if (text[offset] !== '"') refuse('RELEASE_JSON_INVALID');
        const key = string();
        if (Object.hasOwn(object, key)) refuse('RELEASE_JSON_INVALID');
        white();
        if (text[offset++] !== ':') refuse('RELEASE_JSON_INVALID');
        object[key] = value(depth + 1);
        white();
        const next = text[offset++];
        if (next === '}') return object;
        if (next !== ',') refuse('RELEASE_JSON_INVALID');
      }
    }
    if (text[offset] === '[') {
      offset++;
      const array = [];
      white();
      if (text[offset] === ']') { offset++; return array; }
      while (true) {
        array.push(value(depth + 1));
        white();
        const next = text[offset++];
        if (next === ']') return array;
        if (next !== ',') refuse('RELEASE_JSON_INVALID');
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return parsed; }
    }
    const number = /^(?:0|[1-9][0-9]*)/.exec(text.slice(offset));
    if (number === null) refuse('RELEASE_JSON_INVALID');
    offset += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed)) refuse('RELEASE_JSON_INVALID');
    return parsed;
  }
  const parsed = value(0);
  white();
  if (offset !== text.length) refuse('RELEASE_JSON_INVALID');
  return parsed;
}

export function canonicalBase64(text, maximum) {
  if (typeof text !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) refuse('RELEASE_SCHEMA_INVALID');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== text) refuse('RELEASE_SCHEMA_INVALID');
  return bytes;
}

function decimal(text, maximum, positive = false) {
  if (typeof text !== 'string' || text.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(text)) return false;
  const number = BigInt(text);
  return number <= maximum && (!positive || number > 0n);
}

export function validateShape(value, name) {
  const descriptor = schema.objects[name];
  if (descriptor === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) refuse('RELEASE_SCHEMA_INVALID');
  const fields = descriptor.fields;
  if (Object.keys(value).length !== Object.keys(fields).length || Object.keys(value).some(key => !Object.hasOwn(fields, key))) refuse('RELEASE_SCHEMA_INVALID');
  for (const [key, rule] of Object.entries(fields)) {
    const item = value[key];
    if (rule.kind === 'object') { validateShape(item, rule.object); continue; }
    if (rule.kind === 'integer') {
      if (!Number.isSafeInteger(item) || rule.min !== undefined && item < rule.min || rule.max !== undefined && item > rule.max) refuse('RELEASE_SCHEMA_INVALID');
    } else if (rule.kind === 'string') {
      if (typeof item !== 'string' || /[^\x20-\x7e]/.test(item) || rule.maxLength !== undefined && item.length > rule.maxLength
        || rule.pattern !== undefined && !new RegExp(rule.pattern).test(item)) refuse('RELEASE_SCHEMA_INVALID');
      switch (rule.format) {
        case undefined: break;
        case 'base64': canonicalBase64(item, schema.limits.payloadBytes); break;
        case 'sha1': if (!/^[a-f0-9]{40}$/.test(item)) refuse('RELEASE_SCHEMA_INVALID'); break;
        case 'sha256': if (!/^[a-f0-9]{64}$/.test(item)) refuse('RELEASE_SCHEMA_INVALID'); break;
        case 'positive-uint64': if (!decimal(item, 18446744073709551615n, true)) refuse('RELEASE_SCHEMA_INVALID'); break;
        case 'unix-seconds': if (!decimal(item, 253402300799n)) refuse('RELEASE_SCHEMA_INVALID'); break;
        case 'semver': if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(item)
          || item.split('.').some(part => BigInt(part) > 2147483647n)) refuse('RELEASE_SCHEMA_INVALID'); break;
        default: refuse('RELEASE_SCHEMA_INVALID');
      }
    } else refuse('RELEASE_SCHEMA_INVALID');
    if (rule.constant !== undefined && item !== rule.constant) refuse('RELEASE_SCHEMA_INVALID');
  }
  return value;
}

export function loadProductionPolicy() {
  return parseStrictJson(readFileSync(new URL('../../config/update-release-policy.json', import.meta.url)), 65536);
}

export function requireConfigured(policy) {
  if (policy?.protocol !== 1 || policy.revision !== 1 || !Array.isArray(policy.roots) || policy.roots.length === 0
    || !Array.isArray(policy.authorities) || policy.authorities.length === 0 || policy.verifier === null || typeof policy.verifier !== 'object') {
    refuse('RELEASE_TRUST_UNCONFIGURED');
  }
  const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
  if (!exact(policy, 'protocol,revision,roots,authorities,verifier,limits') || policy.roots.length > 16 || policy.authorities.length > 16
    || !exact(policy.limits, 'maximumValiditySeconds,maximumFutureSkewSeconds,maximumPackageBytes,maximumProvenanceBytes')
    || Object.entries(policy.limits).some(([name, value]) => !decimal(value, ({ maximumValiditySeconds: 86400n, maximumFutureSkewSeconds: 300n,
      maximumPackageBytes: 2147483648n, maximumProvenanceBytes: 1048576n })[name], name !== 'maximumFutureSkewSeconds'))
    || !exact(policy.verifier, 'filename,version,sha256') || !['gh', 'gh.exe'].includes(policy.verifier.filename)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(policy.verifier.version) || !/^[a-f0-9]{64}$/.test(policy.verifier.sha256)) refuse('RELEASE_POLICY_INVALID');
  const ids = new Set();
  for (const root of policy.roots) {
    if (!exact(root, 'keyId,algorithm,spkiBase64,spkiSha256,roles,notBefore,expiresAt,revoked,allowHistoricalRecovery')
      || !/^[A-Za-z0-9._-]{1,64}$/.test(root.keyId) || ids.has(root.keyId) || root.algorithm !== 'ecdsa-p256-sha256-p1363'
      || typeof root.spkiBase64 !== 'string' || !/^[a-f0-9]{64}$/.test(root.spkiSha256)
      || !Array.isArray(root.roles) || root.roles.length === 0 || root.roles.length > 2 || new Set(root.roles).size !== root.roles.length
      || root.roles.some(role => !['release', 'recovery'].includes(role)) || typeof root.revoked !== 'boolean' || typeof root.allowHistoricalRecovery !== 'boolean'
      || !decimal(root.notBefore, 253402300799n) || !decimal(root.expiresAt, 253402300799n) || BigInt(root.notBefore) >= BigInt(root.expiresAt)) refuse('RELEASE_POLICY_INVALID');
    ids.add(root.keyId);
  }
  const authorities = new Set();
  for (const authority of policy.authorities) {
    if (!exact(authority, 'repository,workflow,ref,builderWorkflowUri,builderDigest,buildConfigUri,buildConfigDigestRule,issuer,runnerEnvironment')
      || authority.repository !== 'https://github.com/engasnm111/lnwjud' || authority.issuer !== 'https://token.actions.githubusercontent.com'
      || authority.runnerEnvironment !== 'github-hosted' || !/^[a-f0-9]{40}$/.test(authority.builderDigest) || authority.buildConfigDigestRule !== 'source-commit'
      || !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(authority.workflow) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(authority.ref)
      || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@[A-Za-z0-9._/-]+$/.test(authority.builderWorkflowUri)
      || authority.buildConfigUri !== `${authority.repository}/${authority.workflow}@${authority.ref}`) refuse('RELEASE_POLICY_INVALID');
    const identity = `${authority.repository}\0${authority.workflow}\0${authority.ref}`;
    if (authorities.has(identity)) refuse('RELEASE_POLICY_INVALID');
    authorities.add(identity);
  }
}

function rootKey(policy, keyId, now, historical = false) {
  const roots = policy.roots.filter(root => root.keyId === keyId);
  if (roots.length !== 1) refuse('RELEASE_KEY_UNTRUSTED');
  const root = roots[0];
  if (root.algorithm !== 'ecdsa-p256-sha256-p1363' || root.revoked !== false
    || !Array.isArray(root.roles) || !root.roles.includes('release') || (!historical && !root.roles.includes('recovery'))
    || (historical && root.allowHistoricalRecovery !== true)
    || !decimal(root.notBefore, 253402300799n) || !decimal(root.expiresAt, 253402300799n)
    || now < BigInt(root.notBefore) || now >= BigInt(root.expiresAt)) refuse('RELEASE_KEY_UNTRUSTED');
  const spki = canonicalBase64(root.spkiBase64, 1024);
  if (hash(spki) !== root.spkiSha256) refuse('RELEASE_KEY_UNTRUSTED');
  let key;
  try { key = createPublicKey({ key: spki, format: 'der', type: 'spki' }); }
  catch { refuse('RELEASE_KEY_UNTRUSTED'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !key.export({ format: 'der', type: 'spki' }).equals(spki)) refuse('RELEASE_KEY_UNTRUSTED');
  return { root, key, spki };
}

export function validateRelationships(payload, policy, now) {
  if (typeof now !== 'bigint' || now < 0n || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  validateShape(payload, 'payload');
  if (payload.policyRevision !== policy.revision) refuse('RELEASE_POLICY_MISMATCH');
  if (!policy.authorities.some(authority => authority.repository === payload.source.repository
    && authority.workflow === payload.source.workflow && authority.ref === payload.source.ref)) refuse('RELEASE_SOURCE_UNTRUSTED');
  const issued = BigInt(payload.issuedAt);
  const expiry = BigInt(payload.expiresAt);
  if (issued !== BigInt(payload.notBefore) || expiry <= issued || now < issued || now >= expiry
    || issued > now + BigInt(policy.limits.maximumFutureSkewSeconds)
    || expiry - issued > BigInt(policy.limits.maximumValiditySeconds)) refuse('RELEASE_TIME_INVALID');
  if (payload.artifact.name !== `lnwjud-Setup-${payload.version}.exe` || payload.provenance.name !== 'PROVENANCE.json'
    || payload.previous.artifact.name !== `lnwjud-Setup-${payload.previous.version}.exe` || payload.previous.provenance.name !== 'PROVENANCE.json'
    || [payload.artifact, payload.previous.artifact].some(identity => BigInt(identity.sizeBytes) > BigInt(policy.limits.maximumPackageBytes))
    || [payload.provenance, payload.previous.provenance].some(identity => BigInt(identity.sizeBytes) > BigInt(policy.limits.maximumProvenanceBytes))) refuse('RELEASE_ARTIFACT_INVALID');
  const currentVersion = payload.version.split('.').map(BigInt);
  const previousVersion = payload.previous.version.split('.').map(BigInt);
  const firstDifferent = currentVersion.findIndex((part, index) => part !== previousVersion[index]);
  if (BigInt(payload.releaseSequence) <= BigInt(payload.previous.releaseSequence) || firstDifferent < 0
    || currentVersion[firstDifferent] <= previousVersion[firstDifferent]) refuse('RELEASE_REPLAY');
  const recovery = payload.recoveryAuthorization;
  if (recovery.candidateArtifactSha256 !== payload.artifact.sha256 || recovery.candidateReleaseSequence !== payload.releaseSequence
    || recovery.previousEnvelopeSha256 !== payload.previous.envelopeSha256
    || recovery.previousArtifactSha256 !== payload.previous.artifact.sha256 || recovery.previousProvenanceSha256 !== payload.previous.provenance.sha256
    || BigInt(recovery.expiresAt) > expiry || BigInt(recovery.expiresAt) <= now) refuse('RELEASE_RECOVERY_INVALID');
}

export function authenticateEnvelope(bytes, policy, now) {
  requireConfigured(policy);
  if (typeof now !== 'bigint' || now < 0n || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  const envelope = validateShape(parseStrictJson(bytes, schema.limits.envelopeBytes), 'envelope');
  const payloadBytes = canonicalBase64(envelope.payload, schema.limits.payloadBytes);
  const signature = canonicalBase64(envelope.signature, 64);
  if (signature.length !== 64) refuse('RELEASE_SIGNATURE_INVALID');
  const { root, key } = rootKey(policy, envelope.keyId, now);
  if (!verify('sha256', Buffer.concat([domain, payloadBytes]), { key, dsaEncoding: 'ieee-p1363' }, signature)) refuse('RELEASE_SIGNATURE_INVALID');
  const payload = parseStrictJson(payloadBytes, schema.limits.payloadBytes);
  validateRelationships(payload, policy, now);
  if (BigInt(payload.issuedAt) < BigInt(root.notBefore) || BigInt(payload.issuedAt) >= BigInt(root.expiresAt)) refuse('RELEASE_KEY_UNTRUSTED');
  return { payload, envelopeSha256: hash(bytes) };
}

export function authenticateHistoricalEnvelope(bytes, policy, now) {
  requireConfigured(policy);
  if (typeof now !== 'bigint' || now < 0n || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  const envelope = validateShape(parseStrictJson(bytes, schema.limits.envelopeBytes), 'envelope');
  const payloadBytes = canonicalBase64(envelope.payload, schema.limits.payloadBytes);
  const payload = validateShape(parseStrictJson(payloadBytes, schema.limits.payloadBytes), 'payload');
  const originalIssue = BigInt(payload.issuedAt);
  if (originalIssue > now) refuse('RELEASE_TIME_INVALID');
  const { key } = rootKey(policy, envelope.keyId, originalIssue, true);
  const signature = canonicalBase64(envelope.signature, 64);
  if (signature.length !== 64 || !verify('sha256', Buffer.concat([domain, payloadBytes]), { key, dsaEncoding: 'ieee-p1363' }, signature)) refuse('RELEASE_SIGNATURE_INVALID');
  validateRelationships(payload, policy, originalIssue);
  return { payload, envelopeSha256: hash(bytes) };
}

export function signAuthenticatedPayload(payload, policy, keyId, privateKeyBytes, now) {
  requireConfigured(policy);
  validateRelationships(payload, policy, now);
  const { spki } = rootKey(policy, keyId, now);
  let key;
  try { key = createPrivateKey(privateKeyBytes); }
  catch { refuse('RELEASE_SIGNER_INVALID'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(spki)) refuse('RELEASE_SIGNER_INVALID');
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (payloadBytes.length > schema.limits.payloadBytes) refuse('RELEASE_SCHEMA_INVALID');
  const signature = sign('sha256', Buffer.concat([domain, payloadBytes]), { key, dsaEncoding: 'ieee-p1363' });
  const bytes = Buffer.from(JSON.stringify({ protocol: 1, keyId, payload: payloadBytes.toString('base64'), signature: signature.toString('base64') }));
  authenticateEnvelope(bytes, policy, now);
  return bytes;
}
