import test from 'node:test';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash } from './release-envelope.mjs';
import { inspectManifestCandidate, parseSigningVerificationManifest } from './signing-verification-manifest.mjs';

const item = name => ({ name, sizeBytes: '1', sha256: 'a'.repeat(64) });
const baseline = () => ({ schema: 'lnwjud.signing-verification/v1', verification: { repositoryId: '1', runId: '2', runAttempt: 1 },
  policySha256: 'b'.repeat(64), purpose: 'baseline', candidate: { candidate: item('CANDIDATE.json'),
    artifact: item('lnwjud-Setup.exe'), provenance: item('PROVENANCE.json'), artifactBundle: item('artifact.bundle.json'),
    provenanceBundle: item('provenance.bundle.json') } });
const bytes = value => Buffer.from(JSON.stringify(value));

test('parses exact baseline and update manifest roles', () => {
  const value = baseline();
  const parsed = parseSigningVerificationManifest(bytes(value));
  assert.equal(JSON.stringify(parsed), JSON.stringify(value));
  assert.throws(() => { parsed.candidate.artifact.sha256 = 'c'.repeat(64); }, TypeError);
  value.purpose = 'update';
  value.predecessor = { envelope: item('RELEASE.json'), artifact: item('old-setup.exe'), provenance: item('PROVENANCE.json') };
  assert.equal(JSON.stringify(parseSigningVerificationManifest(bytes(value))), JSON.stringify(value));
});

test('rejects missing, extra, ambiguous and noncanonical bindings', () => {
  for (const change of [
    value => { value.verified = true; }, value => { delete value.candidate.artifact; },
    value => { value.purpose = 'update'; }, value => { value.predecessor = {}; },
    value => { value.verification.runAttempt = 0; }, value => { value.verification.runId = '02'; },
    value => { value.policySha256 = 'A'.repeat(64); }, value => { value.candidate.artifact.name = '../setup.exe'; },
    value => { value.candidate.artifact.name = 'con.exe'; },
    value => { value.candidate.artifact.name = 'NUL'; }, value => { value.candidate.artifact.name = 'COM1.json'; },
    value => { value.candidate.artifact.name = 'lpt9'; },
    value => { value.candidate.artifact.name = 'PROVENANCE.json'; }, value => { value.candidate.artifact.sizeBytes = '0'; },
    value => { value.candidate.artifact.sizeBytes = '2147483649'; }, value => { value.candidate.candidate.extra = 1; }
  ]) {
    const value = baseline(); change(value);
    assert.throws(() => parseSigningVerificationManifest(bytes(value)));
  }
  assert.throws(() => parseSigningVerificationManifest(Buffer.from('{"schema":"x","schema":"y"}')));
  assert.throws(() => parseSigningVerificationManifest(Buffer.alloc(32769, 32)));
});

test('binds exact candidate and policy bytes to declared subjects without authorizing files', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/authorization-v2.json', import.meta.url), 'utf8'));
  const outer = JSON.parse(Buffer.from(fixture.baselineEnvelope, 'base64'));
  const candidate = Buffer.from(outer.payload, 'base64');
  const payload = JSON.parse(candidate);
  const policy = Buffer.from(JSON.stringify(fixture.policy));
  const manifest = baseline();
  manifest.policySha256 = hash(policy);
  manifest.candidate.candidate = { name: 'CANDIDATE.json', sizeBytes: String(candidate.length), sha256: hash(candidate) };
  manifest.candidate.artifact = globalThis.structuredClone(payload.release.artifact);
  manifest.candidate.provenance = globalThis.structuredClone(payload.release.provenance);
  manifest.candidate.artifactBundle.sha256 = payload.release.buildEvidence.artifactAttestationSha256;
  manifest.candidate.provenanceBundle.sha256 = payload.release.buildEvidence.provenanceAttestationSha256;
  const inspect = value => inspectManifestCandidate(bytes(value), candidate, policy, BigInt(fixture.now), outer.keyId);
  assert.equal(inspect(manifest).identitySha256, fixture.identitySha256);
  for (const change of [
    value => { value.policySha256 = 'f'.repeat(64); }, value => { value.candidate.candidate.sha256 = 'f'.repeat(64); },
    value => { value.candidate.candidate.sizeBytes = String(candidate.length + 1); }, value => { value.candidate.artifact.name = 'other.exe'; },
    value => { value.candidate.artifact.sizeBytes = '1'; }, value => { value.candidate.provenance.sha256 = 'f'.repeat(64); },
    value => { value.candidate.artifactBundle.sha256 = 'f'.repeat(64); }, value => { value.candidate.provenanceBundle.sha256 = 'f'.repeat(64); }
  ]) { const changed = globalThis.structuredClone(manifest); change(changed); assert.throws(() => inspect(changed)); }
  assert.throws(() => inspectManifestCandidate(bytes(manifest), candidate, Buffer.from('{}'), BigInt(fixture.now), outer.keyId));
});
