import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { acquirePinnedVerifier, loadVerifierPinModule } from './pinned-verifier.mjs';

const windows = process.platform === 'win32' && process.arch === 'x64';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('verifier executable path is fixed and rejects caller paths', async () => {
  await assert.rejects(acquirePinnedVerifier({ filename: process.execPath, sha256: '0'.repeat(64) }), /RELEASE_VERIFIER_UNTRUSTED/);
});

test('pinned verifier provisioning retries transport timeouts but refuses other download errors', { skip: !windows }, () => {
  for (const [failure, expectedAttempts] of [['timeout', 6], ['gateway-timeout', 6], ['forbidden', 1], ['unexpected', 1]]) {
    const script = `
      $global:attempts = 0
      $global:apiAttempts = 0
      function Invoke-WebRequest {
        [CmdletBinding()]
        param([string]$Uri, [string]$OutFile, [int]$MaximumRedirection, [int]$TimeoutSec, [switch]$UseBasicParsing, [hashtable]$Headers)
        $global:attempts++
        if ($Uri -eq 'https://api.github.com/repos/cli/cli/releases/assets/679195750') {
          $global:apiAttempts++
          if ($Headers.Accept -ne 'application/octet-stream') { throw 'Invalid fallback accept header' }
        } elseif ($Uri -notmatch '^https://github[.]com/cli/cli/releases/download/') { throw 'Unreviewed download URL' }
        if ('${failure}' -eq 'timeout') {
          throw [System.Net.WebException]::new('timeout', [System.Net.WebExceptionStatus]::Timeout)
        }
        if ('${failure}' -eq 'gateway-timeout') {
          throw [System.Net.WebException]::new('504 Gateway Time-out', [System.Net.WebExceptionStatus]::ProtocolError)
        }
        if ('${failure}' -eq 'forbidden') {
          throw [System.Net.WebException]::new('403 Forbidden', [System.Net.WebExceptionStatus]::ProtocolError)
        }
        throw [System.InvalidOperationException]::new('unexpected failure')
      }
      function Start-Sleep { param([int]$Seconds) }
      try { & './scripts/update-trust/provision-gh-verifier.ps1'; exit 10 }
      catch {
        if ($global:attempts -ne ${expectedAttempts}) { Write-Error "attempts=$global:attempts"; exit 11 }
        if ($global:apiAttempts -ne ${expectedAttempts > 3 ? 3 : 0}) { Write-Error "apiAttempts=$global:apiAttempts"; exit 12 }
        exit 0
      }
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${failure}: ${result.stdout}\n${result.stderr}`);
  }
});


test('Windows CI ripgrep pinned fallback handles CDN 502, refuses 403 and rejects corrupt archives', { skip: !windows }, async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  for (const destination of ['ripgrep-native-contract', 'ripgrep-workspace-tests', 'ripgrep-e2e']) {
    assert.ok(workflow.includes('./scripts/ci-install-ripgrep.ps1 -DestinationName ' + destination),
      'Windows ' + destination + ' must use the common pinned installer');
  }
  const script = await readFile(path.join(root, 'scripts/ci-install-ripgrep.ps1'), 'utf8');
  assert.match(script, /d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1/);
  assert.match(script, /releases\/assets\/191354245/);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ripgrep-ci-'));
  try {
    for (const [failure, attempts, apiAttempts, expectedError] of [
      ['gateway', 6, 3, '502 Bad Gateway'],
      ['forbidden', 1, 0, '403 Forbidden'],
      ['corrupt', 1, 0, 'RIPGREP_CI_ARCHIVE_DIGEST_MISMATCH'],
    ]) {
      const runnerTemp = path.join(temp, failure);
      await mkdir(runnerTemp);
      const fixture = [
        // Import before mocking Get-Command; a fresh hosted runner otherwise
        // cannot auto-load Get-FileHash from Microsoft.PowerShell.Utility.
        'Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop',
        '$global:attempts = 0',
        '$global:apiAttempts = 0',
        'function Get-Command { [CmdletBinding()] param([string]$Name) if ($Name -eq "rg") { return $null } else { throw "Unexpected Get-Command" } }',
        'function Invoke-WebRequest {',
        '  [CmdletBinding()]',
        '  param([string]$Uri, [string]$OutFile, [int]$MaximumRedirection, [int]$TimeoutSec, [switch]$UseBasicParsing, [hashtable]$Headers)',
        '  $global:attempts++',
        '  if ($Uri -eq "https://api.github.com/repos/BurntSushi/ripgrep/releases/assets/191354245") {',
        '    $global:apiAttempts++',
        '    if ($Headers.Accept -ne "application/octet-stream") { throw "Bad Accept header" }',
        '  } elseif ($Uri -notmatch "^https://github[.]com/BurntSushi/ripgrep/releases/download/") { throw "Unreviewed download URL" }',
        '  if ("' + failure + '" -eq "corrupt") { Set-Content -LiteralPath $OutFile -Value "not the official archive" -Encoding ascii; return }',
        '  if ("' + failure + '" -eq "gateway") {',
        '    throw [System.Net.WebException]::new("502 Bad Gateway", [System.Net.WebExceptionStatus]::ProtocolError)',
        '  }',
        '  throw [System.Net.WebException]::new("403 Forbidden", [System.Net.WebExceptionStatus]::ProtocolError)',
        '}',
        'function Start-Sleep { param([int]$Seconds) }',
        'try { & "./scripts/ci-install-ripgrep.ps1" -DestinationName "ripgrep-' + failure + '"; exit 10 }',
        'catch {',
        '  if ($global:attempts -ne ' + attempts + ' -or $global:apiAttempts -ne ' + apiAttempts + ') {',
        '    Write-Error "attempts=$global:attempts apiAttempts=$global:apiAttempts"; exit 11',
        '  }',
        '  if ($_.Exception.Message -notmatch "' + expectedError + '") {',
        '    Write-Error ("wrong refusal: " + $_.Exception.Message); exit 12',
        '  }',
        '  exit 0',
        '}',
      ].join('\n');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fixture], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, RUNNER_TEMP: runnerTemp },
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, failure + ': ' + result.stdout + '\n' + result.stderr);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Windows CI cosign fallback retries CDN 504 via its pinned official API asset, not HTTP 403', { skip: !windows }, async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const label = '      - name: Install checksum-pinned cosign fallback';
  const begin = workflow.indexOf(label);
  assert.ok(begin >= 0, 'missing checksum-pinned cosign step');
  const scriptStart = workflow.indexOf('        run: |', begin);
  const nextStep = workflow.indexOf('      - name: Verify cosign release verifier', scriptStart);
  assert.ok(scriptStart > begin && nextStep > scriptStart, 'unexpected CI step boundaries');
  const raw = workflow.slice(scriptStart + '        run: |'.length, nextStep).trimEnd();
  const script = raw.split(/\r?\n/).filter(Boolean).map(line => {
    assert.ok(line.startsWith('          '), 'unexpected CI script indentation');
    return line.slice(10);
  }).join('\n');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-cosign-ci-'));
  try {
    for (const [failure, expectedAttempts, expectedApi] of [['gateway-timeout', 8, 4], ['forbidden', 1, 0]]) {
      const fixture = `
        $global:attempts = 0
        $global:apiAttempts = 0
        function Invoke-WebRequest {
          [CmdletBinding()]
          param([string]$Uri, [string]$OutFile, [int]$MaximumRedirection,
                [int]$TimeoutSec, [switch]$UseBasicParsing, [hashtable]$Headers)
          $global:attempts++
          if ($Uri -eq 'https://api.github.com/repos/sigstore/cosign/releases/assets/503286236') {
            $global:apiAttempts++
            if ($Headers.Accept -ne 'application/octet-stream') { throw 'Invalid asset accept header' }
          } elseif ($Uri -notmatch '^https://github[.]com/sigstore/cosign/releases/download/') {
            throw 'Unreviewed asset URL'
          }
          if ('${failure}' -eq 'gateway-timeout') {
            throw [System.Net.WebException]::new('504 Gateway Time-out', [System.Net.WebExceptionStatus]::ProtocolError)
          }
          throw [System.Net.WebException]::new('403 Forbidden', [System.Net.WebExceptionStatus]::ProtocolError)
        }
        function Start-Sleep { param([int]$Seconds) }
        try {
          ${script}
          exit 10
        } catch {
          if ($global:attempts -ne ${expectedAttempts} -or $global:apiAttempts -ne ${expectedApi}) {
            Write-Error "attempts=$global:attempts apiAttempts=$global:apiAttempts"
            exit 11
          }
          exit 0
        }
      `;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fixture], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, RUNNER_TEMP: temp },
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${failure}: ${result.stdout}\n${result.stderr}`);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('actual native addon pins file and ancestors, rejecting writes/renames until release', { skip: !windows }, async () => {
  const addon = await loadVerifierPinModule();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-pin-'));
  const executable = path.join(directory, 'owned-copy.exe');
  await copyFile(process.execPath, executable);
  let pin;
  try {
    pin = addon.pinExecutable(executable);
    await assert.rejects(writeFile(executable, 'changed'));
    await assert.rejects(rename(executable, `${executable}.moved`));
    await assert.rejects(rename(directory, `${directory}.moved`));
    pin.close(); pin = undefined;
    await rename(executable, `${executable}.moved`);
    await writeFile(`${executable}.moved`, 'released');
  } finally { pin?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real pinned executor retains executable and exact input through child close, strips signer environment', { skip: !windows }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-executor-'));
  const directory = await realpath(temporaryRoot);
  try {
    const files = [
      'config/update-release-schema.json',
      'scripts/update-trust/pinned-verifier.mjs',
      'scripts/update-trust/release-envelope.mjs',
      'packages/capabilities/src/containment-integrity.generated.ts',
      'apps/desktop/build/native-containment/lnwjud-containment-pin.node',
    ];
    for (const relative of files) {
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, relative), destination);
    }
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const runner = path.join(directory, 'run-fixture.mjs');
    await writeFile(runner, `
      import assert from 'node:assert/strict';
      import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      import os from 'node:os';
      import path from 'node:path';
      import process from 'node:process';
      import { acquirePinnedVerifier } from './scripts/update-trust/pinned-verifier.mjs';
      const directory = path.join(process.cwd(), 'tools/update-attestation');
      const filename = path.join(directory, 'gh.exe');
      const inputDirectory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-input-'));
      const input = path.join(inputDirectory, 'bundle.json');
      let session;
      try {
        await (await import('node:fs/promises')).mkdir(directory, { recursive: true });
        await copyFile(process.execPath, filename, 1);
        const sha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256: '0'.repeat(64) }), /RELEASE_VERIFIER_UNTRUSTED/);
        const changingVerifier = { filename: 'gh.exe', sha256: '0'.repeat(64) };
        const checkedVerifier = acquirePinnedVerifier(changingVerifier); changingVerifier.sha256 = sha256;
        await assert.rejects(checkedVerifier, /RELEASE_VERIFIER_UNTRUSTED/);
        process.env.GH_TOKEN = 'disposable-test-token';
        process.env.GH_CONFIG_DIR = inputDirectory;
        process.env.HOME = inputDirectory;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const observed = JSON.parse((await session.run(['-e', 'const fs=require("fs"),p=require("path");process.stdout.write(JSON.stringify({config:process.env.GH_CONFIG_DIR,home:process.env.HOME,host:process.env.GH_HOST,tokenPresent:!!process.env.GH_TOKEN,configText:fs.readFileSync(p.join(process.env.GH_CONFIG_DIR,"config.yml"),"utf8"),hostsText:fs.readFileSync(p.join(process.env.GH_CONFIG_DIR,"hosts.yml"),"utf8")}))'])).toString());
        assert.notEqual(observed.config, inputDirectory); assert.equal(observed.home, observed.config);
        assert.equal(observed.host, 'github.com'); assert.equal(observed.tokenPresent, true);
        assert.equal(observed.configText, '{}\\n'); assert.equal(observed.hostsText, '{}\\n');
        await assert.rejects(writeFile(path.join(observed.config, 'hosts.yml'), 'redirect'));
        await writeFile(input, '{"bundle":"bound"}'); await session.pinInputs([input]);
        process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'sentinel-test-only';
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256 }), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = '';
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256 }), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'sentinel-test-only';
        assert.throws(() => session.run(['-e', 'process.stdout.write("unsafe")']), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        await assert.rejects(session.pinInputs([input]), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = '';
        assert.throws(() => session.run(['-e', 'process.stdout.write("unsafe")']), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
        const completion = session.run(['-e', 'setTimeout(() => process.stdout.write("SIGNER=" + String(process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM)), 150)']);
        const closing = session.close();
        await assert.rejects(writeFile(filename, 'changed')); await assert.rejects(rename(filename, filename + '.moved'));
        await assert.rejects(writeFile(input, 'swapped')); await assert.rejects(rename(input, input + '.moved'));
        assert.equal((await completion).toString(), 'SIGNER=undefined'); await closing;
        delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
        process.env.lnwjud_update_release_private_key_pem = '';
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256 }), /RELEASE_VERIFIER_SIGNER_ENVIRONMENT_REFUSED/);
        delete process.env.lnwjud_update_release_private_key_pem;
        await writeFile(input, 'released');
        await rename(filename, filename + '.moved'); await rename(filename + '.moved', filename);
        assert.throws(() => session.run(['version']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        await assert.rejects(session.run(['-e', 'process.stdout.write("x".repeat(5000000))']), /RELEASE_ATTESTATION_REFUSED/);
        await session.close(); session = undefined;
        const secondInput = path.join(inputDirectory, 'bundle-two.json');
        await writeFile(secondInput, '{"bundle":"two"}');
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const firstPins = session.pinInputs(Array(5).fill(input));
        await assert.rejects(session.pinInputs(Array(4).fill(secondInput)), /RELEASE_INPUT_INVALID/);
        await firstPins;
        await session.close(); session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const pinning = session.pinInputs([input, secondInput]);
        const closingPins = session.close();
        await Promise.allSettled([pinning, closingPins]);
        await writeFile(input, 'released'); await writeFile(secondInput, 'released');
        session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const changingInputs = [input];
        const pinnedSnapshot = session.pinInputs(changingInputs); changingInputs.push(...Array(8).fill(secondInput));
        assert.throws(() => session.run(['-e', '']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        await pinnedSnapshot;
        await session.pinInputs(Array(7).fill(secondInput));
        await assert.rejects(session.pinInputs([input]), /RELEASE_INPUT_INVALID/);
        let reads = 0; const accessor = [];
        Object.defineProperty(accessor, '0', { get() { reads++; return input; }, enumerable: true });
        await assert.rejects(session.pinInputs(accessor), /RELEASE_INPUT_INVALID/); assert.equal(reads, 0);
        const accessorArgs = [];
        Object.defineProperty(accessorArgs, '0', { get() { reads++; return '-e'; }, enumerable: true });
        assert.throws(() => session.run(accessorArgs), /RELEASE_VERIFIER_ARGUMENTS_INVALID/); assert.equal(reads, 0);
        const active = session.run(['-e', 'setTimeout(()=>process.stdout.write("done"),150)']);
        assert.throws(() => session.run(['-e', '']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        await assert.rejects(session.pinInputs([input]), /RELEASE_INPUT_INVALID/);
        assert.equal((await active).toString(), 'done');
        await session.close(); session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        let reentrantRefusals = 0; let nestedPin;
        const reentrantArgs = new Proxy(['-e', 'process.stdout.write("outer")'], {
          get(target, key, receiver) {
            if (key === 'length') {
              try { session.run(['-e', '']); } catch { reentrantRefusals++; }
              try { session.close(); } catch { reentrantRefusals++; }
              nestedPin = session.pinInputs([input]).then(() => false, () => true);
            }
            return Reflect.get(target, key, receiver);
          },
        });
        assert.equal((await session.run(reentrantArgs)).toString(), 'outer'); assert.equal(reentrantRefusals, 2); assert.equal(await nestedPin, true);
        const reentrantInputs = new Proxy([input], {
          get(target, key, receiver) {
            if (key === 'length') {
              try { session.run(['-e', '']); } catch { reentrantRefusals++; }
              try { session.close(); } catch { reentrantRefusals++; }
              nestedPin = session.pinInputs([input]).then(() => false, () => true);
            }
            return Reflect.get(target, key, receiver);
          },
        });
        await session.pinInputs(reentrantInputs); assert.equal(reentrantRefusals, 4); assert.equal(await nestedPin, true);
        await session.close(); session = undefined;
        delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256 }), /RELEASE_VERIFIER_CREDENTIAL_UNAVAILABLE/);
        await writeFile(filename, 'released');
      } finally {
        await session?.close();
        delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
        delete process.env.GH_TOKEN;
        await rm(inputDirectory, { recursive: true, force: true });
      }
    `);
    const allowedEnvironment = new Set(['systemroot', 'windir', 'path', 'home', 'userprofile', 'temp', 'tmp']);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedEnvironment.has(name.toLowerCase())));
    const result = spawnSync(process.execPath, [runner], { cwd: directory, encoding: 'utf8', env: environment, windowsHide: true, timeout: 30000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
