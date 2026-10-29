import test from 'node:test';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { encodeReleaseIdentity, releaseIdentity } from './release-identity.mjs';
import { schema } from './release-envelope.mjs';

const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/release-identity-v1.json', import.meta.url), 'utf8'));
const identitySchemaText = (await readFile(new URL('../../config/update-release-identity-v1.json', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const identitySchema = JSON.parse(identitySchemaText);
const bytes = value => Buffer.from(JSON.stringify(value), 'utf8');

async function removeFixtureDirectory(directory, base) {
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('lnwjud-identity-schema-')) throw new Error('IDENTITY_TEST_DIRECTORY_INVALID');
  await rm(resolved, { recursive: true, force: true });
}

test('release identity matches the shared independent byte vector', () => {
  assert.equal(encodeReleaseIdentity(bytes(fixture.release)).toString('base64'), fixture.encodedBase64);
  assert.equal(releaseIdentity(bytes(fixture.release)), fixture.sha256);
});

test('property order and fresh authorization do not alter immutable identity', () => {
  const reorder = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const first = { release: fixture.release, issuedAt: '1800000000', expiresAt: '1800003600', signature: 'first' };
  const renewed = { release: reorder(fixture.release), issuedAt: '1800086400', expiresAt: '1800090000', signature: 'second' };
  assert.deepEqual(encodeReleaseIdentity(bytes(first.release)), encodeReleaseIdentity(bytes(renewed.release)));
});

test('identity binds immutable build, artifact, target and contract fields', () => {
  for (const change of [
    value => { value.source.commit = 'b'.repeat(40); },
    value => { value.source.runAttempt = '3'; },
    value => { value.buildEvidence.artifactAttestationSha256 = '8'.repeat(64); },
    value => { value.artifact.sha256 = '8'.repeat(64); },
    value => { value.provenance.sizeBytes = '1235'; },
    value => { value.compatibility.serviceContractSha256 = '8'.repeat(64); },
    value => { value.version = '5.9.1'; },
    value => { value.releaseSequence = '101'; },
    value => { value.architecture = 'arm64'; },
  ]) {
    const altered = globalThis.structuredClone(fixture.release);
    change(altered);
    assert.notEqual(releaseIdentity(bytes(altered)), fixture.sha256);
  }
});

test('identity refuses extra, missing and noncanonical immutable fields', () => {
  for (const change of [
    value => { value.extra = 'untrusted'; },
    value => { delete value.source.commit; },
    value => { value.source.runAttempt = '02'; },
    value => { value.releaseSequence = '0100'; },
    value => { value.version = '05.9.0'; },
    value => { value.artifact.sha256 = 'Z'.repeat(64); },
    value => { value.buildEvidence.sourceTree = 'dirty'; },
  ]) {
    const altered = globalThis.structuredClone(fixture.release);
    change(altered);
    assert.throws(() => encodeReleaseIdentity(bytes(altered)), /RELEASE_SCHEMA_INVALID/);
  }
});

test('identity accepts strict JSON bytes and never reads object getters', () => {
  let reads = 0;
  const release = globalThis.structuredClone(fixture.release);
  Object.defineProperty(release.source, 'commit', { enumerable: true, get() { reads++; return 'a'.repeat(40); } });
  assert.throws(() => encodeReleaseIdentity(release), /RELEASE_JSON_INVALID/);
  assert.equal(reads, 0);
  assert.throws(() => encodeReleaseIdentity(Buffer.from('{"product":"lnwjud","product":"lnwjud"}')), /RELEASE_JSON_INVALID/);
});

test('immutable release fields use the same descriptors as the current signed payload', () => {
  const expected = ['product', 'releaseId', 'channel', 'platform', 'architecture', 'distribution', 'version', 'releaseSequence',
    'source', 'buildEvidence', 'artifact', 'provenance', 'compatibility'].sort();
  assert.deepEqual(Object.keys(identitySchema.objects.release.fields).sort(), expected);
  for (const key of expected) assert.deepEqual(identitySchema.objects.release.fields[key], schema.objects.payload.fields[key]);
  for (const name of ['source', 'buildEvidence', 'identity', 'compatibility'])
    assert.deepEqual(identitySchema.objects[name], schema.objects[name]);
});

test('identity schema pin accepts CRLF but rejects changed schema semantics', async () => {
  const base = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'lnwjud-identity-schema-'));
  try {
    await mkdir(path.join(directory, 'config'));
    await mkdir(path.join(directory, 'scripts', 'update-trust'), { recursive: true });
    await copyFile(new URL('./release-envelope.mjs', import.meta.url), path.join(directory, 'scripts', 'update-trust', 'release-envelope.mjs'));
    await copyFile(new URL('./release-identity.mjs', import.meta.url), path.join(directory, 'scripts', 'update-trust', 'release-identity.mjs'));
    await copyFile(new URL('../../config/update-release-schema.json', import.meta.url), path.join(directory, 'config', 'update-release-schema.json'));
    const identityPath = path.join(directory, 'config', 'update-release-identity-v1.json');
    const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', "import './scripts/update-trust/release-identity.mjs';"], {
      cwd: directory, encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '' },
    });
    await writeFile(identityPath, identitySchemaText.replace(/\n/g, '\r\n'));
    assert.equal(invoke().status, 0);
    const changed = globalThis.structuredClone(identitySchema);
    changed.objects.source.fields.commit.format = 'sha256';
    await writeFile(identityPath, JSON.stringify(changed));
    const refused = invoke();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /RELEASE_IDENTITY_SCHEMA_VERSION_MISMATCH/);
  } finally {
    await removeFixtureDirectory(directory, base);
  }
});

test('trusted schema cannot be mutated to relax identity validation in process', () => {
  assert.throws(() => { schema.objects.source.fields.commit.format = undefined; }, TypeError);
  const altered = globalThis.structuredClone(fixture.release);
  altered.source.commit = 'z'.repeat(40);
  assert.throws(() => encodeReleaseIdentity(bytes(altered)), /RELEASE_SCHEMA_INVALID/);
});
