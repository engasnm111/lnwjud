import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import vm from 'node:vm';
import { TextDecoder } from 'node:util';
import { assertGeneratedChanges, builderContext, inspectSubjectDirectory, validateGeneratedIdentitySources, validateProvenance,
  windowsPowerShell51Environment } from './builder-control.mjs';

const workflow = (await readFile(new URL('../../.github/workflows/update-package-builder.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const mainWorkflow = (await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const bootstrap = workflow.split("node --input-type=module -e @'\n")[1]?.split("\n          '@")[0];
const environment = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'engasnm111/lnwjud', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', LNWJUD_BUILDER_SHA: 'b'.repeat(40),
  UPDATE_RESOLVER_GITHUB_TOKEN: 'fixture-resolver-token' });

test('Windows PowerShell child hashes a fixture with the builder module path', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-builder-powershell-'));
  try {
    const fixture = Buffer.from('hash through the Windows PowerShell 5.1 module path');
    const fixturePath = path.join(directory, 'fixture.bin');
    await writeFile(fixturePath, fixture);
    const parentEnvironment = { ...process.env, LNWJUD_HASH_FIXTURE: fixturePath };
    const inheritedModulePath = parentEnvironment.PSModulePath;
    const childEnvironment = windowsPowerShell51Environment(parentEnvironment, process.cwd());
    assert.equal(parentEnvironment.PSModulePath, inheritedModulePath);
    assert.equal(childEnvironment.PSModulePath, path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
    assert.equal(childEnvironment.LNWJUD_HASH_FIXTURE, fixturePath);
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-FileHash -LiteralPath $env:LNWJUD_HASH_FIXTURE -Algorithm SHA256).Hash.ToLowerInvariant()'], {
      encoding: 'utf8', env: childEnvironment, windowsHide: true, shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), createHash('sha256').update(fixture).digest('hex'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const runMetadata = () => ({ id: 123, run_attempt: 2, event: 'push', head_sha: 'a'.repeat(40), head_branch: 'main', status: 'in_progress',
  path: '.github/workflows/ci.yml', repository: { full_name: 'engasnm111/lnwjud' },
  referenced_workflows: [{ path: `engasnm111/lnwjud/.github/workflows/update-package-builder.yml@${'b'.repeat(40)}`, ref: 'refs/heads/main', sha: 'b'.repeat(40) }] });

async function resolve(environmentOverride = {}, metadata = runMetadata(), responseOverride = {}) {
  const observed = { output: '', error: '', fetches: 0 }; const process = { env: { ...environment(), ...environmentOverride },
    stdout: { write: text => { observed.output += text; } }, stderr: { write: text => { observed.error += text; } }, exitCode: 0 };
  await vm.runInNewContext(bootstrap, { process, Buffer, TextDecoder, AbortSignal: globalThis.AbortSignal,
    fetch: async (url, options) => {
      observed.fetches++; assert.equal(url, 'https://api.github.com/repos/engasnm111/lnwjud/actions/runs/123/attempts/2');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer fixture-resolver-token');
      return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify(metadata)); })(), ...responseOverride };
    } }, { timeout: 1000 });
  return { ...observed, exitCode: process.exitCode };
}

test('protected main CI requires successful update package attestations before release verification', () => {
  const jobStart = mainWorkflow.indexOf('\n  update-package-attestation:');
  const verifyStart = mainWorkflow.indexOf('\n  verify:');
  assert.ok(jobStart >= 0 && verifyStart > jobStart);
  const attestationJob = mainWorkflow.slice(jobStart, verifyStart);
  const verifyJob = mainWorkflow.slice(verifyStart);
  const verificationCommand = verifyJob.match(/run: >-\r?\n\s+node --input-type=module -e '([^'\r\n]+)'/)?.[1];
  assert.match(attestationJob, /if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'push'/);
  assert.match(attestationJob, /uses: \.\/\.github\/workflows\/update-package-builder\.yml/);
  assert.match(attestationJob, /id-token: write[\s\S]*attestations: write/);
  assert.match(verifyJob, /needs: \[windows-release-tests, windows-release-build, update-package-attestation\]/);
  assert.match(verifyJob, /UPDATE_PACKAGE_REQUIRED: \$\{\{ github\.ref == 'refs\/heads\/main' && github\.event_name == 'push' \}\}/);
  assert.match(verifyJob, /UPDATE_PACKAGE_RESULT: \$\{\{ needs\.update-package-attestation\.result \}\}/);
  assert.match(verifyJob, /node-version: '24\.22\.2'/);
  assert.equal(typeof verificationCommand, 'string');
  for (const [required, result, workspace, build, expected] of [
    ['true', 'success', 'success', 'success', 0], ['true', 'failure', 'success', 'success', 1],
    ['true', 'cancelled', 'success', 'success', 1], ['true', 'skipped', 'success', 'success', 1],
    ['false', 'skipped', 'success', 'success', 0], ['false', 'success', 'success', 'success', 1],
    ['false', 'failure', 'success', 'success', 1], ['false', 'cancelled', 'success', 'success', 1],
    ['true', 'success', 'failure', 'success', 1], ['true', 'success', 'success', 'failure', 1],
  ]) {
    const actual = spawnSync(process.execPath, ['--input-type=module', '-e', verificationCommand], {
      encoding: 'utf8', env: { ...process.env, WORKSPACE_TESTS_RESULT: workspace, BUILD_RESULT: build, UPDATE_PACKAGE_REQUIRED: required, UPDATE_PACKAGE_RESULT: result },
    });
    assert.equal(actual.status, expected, `required=${required}, result=${result}, workspace=${workspace}, build=${build}`);
  }
});

test('Windows update builder uses a Node release with the libuv short-path watcher fix', () => {
  const versions = [...workflow.matchAll(/node-version: '([^']+)'/g)].map(([, version]) => version);
  assert.equal(versions.length, 3);
  assert.deepEqual(versions, ['24.22.2', '24.22.2', '24.22.2']);
});

test('Windows update builder installs ripgrep before release verification', () => {
  const buildStart = workflow.indexOf('\n  build-package:');
  const attestStart = workflow.indexOf('\n  attest-package:', buildStart);
  assert.ok(buildStart >= 0 && attestStart > buildStart);
  const buildJob = workflow.slice(buildStart, attestStart);
  const installStart = buildJob.indexOf('- name: Install ripgrep for release verification');
  const buildCommand = buildJob.indexOf('node _trusted-builder/scripts/update-trust/builder-control.mjs build');
  assert.ok(installStart >= 0 && buildCommand > installStart);
  assert.match(buildJob.slice(installStart, buildCommand), /rg --version/);
  assert.match(buildJob.slice(installStart, buildCommand), /GITHUB_PATH/);
});

test('actual inline resolver accepts a SHA-pinned builder with separate branch ref metadata', async () => {
  assert.equal(typeof bootstrap, 'string');
  const result = await resolve(); assert.equal(result.exitCode, 0); assert.equal(result.output, `builder_sha=${'b'.repeat(40)}\n`);
  assert.equal(result.fetches, 1);
  const exact = runMetadata(); exact.referenced_workflows[0].ref = 'b'.repeat(40);
  assert.equal((await resolve({}, exact)).exitCode, 0);
  const omitted = runMetadata(); delete omitted.referenced_workflows[0].ref;
  assert.equal((await resolve({}, omitted)).exitCode, 0);
});

for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: 'other/repository', GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REF: 'refs/heads/dev', GITHUB_REF_PROTECTED: 'false', GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/release.yml@refs/heads/main', GITHUB_SHA: 'bad', GITHUB_RUN_ID: '../123', GITHUB_RUN_ATTEMPT: '02', UPDATE_RESOLVER_GITHUB_TOKEN: '' })) {
  test(`actual inline resolver refuses untrusted ${key} before network`, async () => {
    const result = await resolve({ [key]: value }); assert.equal(result.exitCode, 1); assert.equal(result.fetches, 0); assert.equal(result.output, '');
  });
}

test('actual inline resolver refuses wrong actual run, mutable references, ambiguity and HTTP failure', async () => {
  for (const change of [run => { run.head_sha = 'c'.repeat(40); }, run => { run.run_attempt = 1; }, run => { run.id = 124; },
    run => { run.event = 'workflow_dispatch'; }, run => { run.path = '.github/workflows/dev-installer.yml'; }, run => { run.repository.full_name = 'other/repository'; },
    run => { run.referenced_workflows[0].path = 'engasnm111/lnwjud/.github/workflows/update-package-builder.yml@main'; },
    run => { run.referenced_workflows[0].sha = 'c'.repeat(40); },
    run => { run.referenced_workflows[0].ref = 'refs/heads/dev'; },
    run => { run.referenced_workflows[0].ref = 'refs/tags/v5.9.1'; },
    run => { run.referenced_workflows.push(run.referenced_workflows[0]); }, run => { run.referenced_workflows = []; }]) {
    const metadata = runMetadata(); change(metadata); const result = await resolve({}, metadata);
    assert.equal(result.exitCode, 1); assert.equal(result.output, '');
  }
  assert.equal((await resolve({}, runMetadata(), { ok: false })).exitCode, 1);
  assert.equal((await resolve({}, runMetadata(), { body: (async function* () { yield Buffer.alloc(1048577); })() })).exitCode, 1);
});

test('build control refuses publisher/envelope secrets and credential-bearing build OIDC environment', () => {
  assert.equal(builderContext(environment(), true).commit, 'a'.repeat(40));
  assert.throws(() => builderContext({ ...environment(), GITHUB_REF_PROTECTED: undefined }, true));
  assert.throws(() => builderContext({ ...environment(), GITHUB_REF_PROTECTED: 'false' }, true));
  for (const name of ['CSC_LINK', 'csc_key_password', 'WINDOWS_CSC_LINK', 'WINDOWS_CSC_KEY_PASSWORD', 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) assert.throws(() => builderContext({ ...environment(), [name]: 'untrusted' }, true));
  assert.throws(() => builderContext({ ...environment(), LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM: '' }, true));
  assert.equal(builderContext({ ...environment(), ACTIONS_ID_TOKEN_REQUEST_URL: 'allowed-only-in-attestation-job' }).runId, '123');
});

test('post-build source changes permit only enumerated unstaged generated identities', () => {
  assertGeneratedChanges('');
  assertGeneratedChanges(' M packages/capabilities/src/containment-integrity.generated.ts\0 M apps/desktop/src/main/update-worker-integrity.generated.ts\0');
  for (const status of [' M package.json\0', '?? untrusted.js\0', ' D packages/capabilities/src/containment-integrity.generated.ts\0',
    'M  packages/capabilities/src/containment-integrity.generated.ts\0', ' R old\0new\0']) assert.throws(() => assertGeneratedChanges(status));
});

test('generated source allowance requires exact independent derivation and cannot hide executable source injection', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-builder-generated-')));
  try {
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const files = ['apps/desktop/build/native-containment/lnwjud-containment.exe', 'apps/desktop/build/native-containment/lnwjud-containment-pin.node',
      'apps/desktop/build/native-containment/process-runtime.mjs', 'apps/desktop/build/update-worker/lnwjud-update-worker.exe', 'packages/capabilities/src/windows-capability-bridge.ps1'];
    for (const filename of files) { await mkdir(path.dirname(path.join(directory, filename)), { recursive: true }); await writeFile(path.join(directory, filename), filename); }
    const digest = index => hash(files[index]);
    const generated = {
      'packages/capabilities/src/containment-integrity.generated.ts': `export const CONTAINMENT_HELPER_SHA256 = '${digest(0)}' as const;\nexport const CONTAINMENT_PIN_SHA256 = '${digest(1)}' as const;\nexport const CONTAINMENT_RUNTIME_SHA256 = '${digest(2)}' as const;\n`,
      'apps/desktop/src/main/update-worker-integrity.generated.ts': `export const UPDATE_WORKER_SHA256 = '${digest(3)}' as const;\nexport const UPDATE_WORKER_PIN_SHA256 = '${digest(1)}' as const;\nexport const UPDATE_WORKER_BUILD_ID = 'lnwjud-update-worker-bootstrap-v1' as const;\nexport const UPDATE_WORKER_PROTOCOL = 1 as const;\n`,
      'packages/capabilities/src/windows-capability-integrity.generated.ts': `// Generated by apps/desktop/scripts/write-capability-integrity.mjs.\nexport const WINDOWS_CAPABILITY_BRIDGE_SHA256 = '${digest(4)}' as const;\nexport const WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES = ${files[4].length} as const;\n`,
    };
    for (const [filename, text] of Object.entries(generated)) { await mkdir(path.dirname(path.join(directory, filename)), { recursive: true }); await writeFile(path.join(directory, filename), text); }
    await validateGeneratedIdentitySources(directory);
    for (const [filename, text] of Object.entries(generated)) {
      await writeFile(path.join(directory, filename), text + 'process.exit(0);\n');
      await assert.rejects(validateGeneratedIdentitySources(directory)); await writeFile(path.join(directory, filename), text);
    }
    await writeFile(path.join(directory, files[0]), 'changed stage identity'); await assert.rejects(validateGeneratedIdentitySources(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function provenance(bytes) {
  return { schemaVersion: 1, product: 'lnwjud', version: '5.9.0', platform: 'win32', arch: 'x64',
    source: { repository: 'https://github.com/engasnm111/lnwjud', commit: 'a'.repeat(40), dirty: false },
    build: { environment: 'github-actions', runId: '123', runAttempt: '2', ref: 'refs/heads/main', signingCredentialConfigured: false },
    artifacts: [{ name: 'lnwjud-Setup-5.9.0.exe', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }] };
}

test('immutable inspector hashes unexecuted subjects and refuses mutation, extra files, links and forged context', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-builder-')));
  try {
    const bytes = Buffer.from('data only: this file must never be executed'); const data = provenance(bytes);
    const artifact = path.join(directory, data.artifacts[0].name); const metadata = path.join(directory, 'PROVENANCE.json');
    await writeFile(artifact, bytes); await writeFile(metadata, JSON.stringify(data));
    assert.equal((await inspectSubjectDirectory(directory, builderContext(environment()))).artifact.sha256, data.artifacts[0].sha256);
    await writeFile(artifact, 'changed'); await assert.rejects(inspectSubjectDirectory(directory, builderContext(environment()))); await writeFile(artifact, bytes);
    await writeFile(path.join(directory, 'untrusted.cmd'), 'malicious'); await assert.rejects(inspectSubjectDirectory(directory, builderContext(environment()))); await rm(path.join(directory, 'untrusted.cmd'));
    await mkdir(path.join(directory, 'nested')); await assert.rejects(inspectSubjectDirectory(directory, builderContext(environment()))); await rm(path.join(directory, 'nested'), { recursive: true });
    await link(artifact, path.join(directory, 'hardlinked')); await assert.rejects(inspectSubjectDirectory(directory, builderContext(environment()))); await rm(path.join(directory, 'hardlinked'));
    for (const change of [value => { value.source.dirty = true; }, value => { value.source.commit = 'c'.repeat(40); },
      value => { value.build.runAttempt = '1'; }, value => { value.build.signingCredentialConfigured = true; },
      value => { value.version = '../5.9.0'; }, value => { value.artifacts.push(value.artifacts[0]); }]) {
      const changed = globalThis.structuredClone(data); change(changed); assert.throws(() => validateProvenance(changed, builderContext(environment())));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workflow has no activation/input/secrets surface and isolates build credentials from data-only attestation', () => {
  assert.match(workflow, /on:\n {2}workflow_call:\n\npermissions: \{\}/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|pull_request:|^\s+inputs:|^\s+secrets:|secrets\./m);
  for (const match of workflow.matchAll(/^\s*- uses: ([^\s]+)$/gm)) assert.match(match[1], /^[A-Za-z0-9/_-]+@[a-f0-9]{40}$/);
  const build = workflow.split('  build-package:')[1].split('  attest-package:')[0];
  const attest = workflow.split('  attest-package:')[1];
  assert.doesNotMatch(build, /id-token:|attestations:|CSC_LINK|PRIVATE_KEY/);
  assert.match(attest, /id-token: write/); assert.match(attest, /attestations: write/);
  assert.doesNotMatch(attest, /_source|pnpm|npm install|dotnet|powershell\.exe|run-id:|repository:.*\$\{\{/);
  assert.match(attest, /artifact-ids: \$\{\{ needs\.build-package\.outputs\.artifact_id \}\}/);
  for (const command of attest.matchAll(/^\s*run: (.+)$/gm)) assert.match(command[1], /^node _trusted-builder\/scripts\/update-trust\/builder-control\.mjs (?:inspect|bundles)$/);
});
