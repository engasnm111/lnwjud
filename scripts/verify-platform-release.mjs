/* global process */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const target = process.env.LNWJUD_VERIFY_PLATFORM?.trim() || process.platform;
const architecture = process.env.LNWJUD_VERIFY_ARCH?.trim() || process.arch;
const packageRequested = process.argv.includes('--package');

if (!['win32', 'darwin', 'linux'].includes(target)) throw new Error(`Unsupported verification platform: ${target}`);
if (target !== process.platform) throw new Error(`Platform verification must run on ${target}; current host is ${process.platform}`);
if (!['x64', 'arm64'].includes(architecture)) throw new Error(`Unsupported verification architecture: ${architecture}`);

const checks = [
  ['typecheck', 'corepack', ['pnpm@10.15.0', 'typecheck']],
  ['lint', 'corepack', ['pnpm@10.15.0', 'lint']],
  ['platform-contract', 'corepack', ['pnpm@10.15.0', 'exec', 'vitest', 'run', 'tests/integration/platform-composition.test.ts', 'tests/release/platform-support-contract.test.ts', 'tests/release/platform-docs-contract.test.ts']],
  ['build', 'corepack', ['pnpm@10.15.0', 'build']],
  ['packaging-contract', 'corepack', ['pnpm@10.15.0', 'test:packaging']],
  ['diff-check', 'git', ['diff', '--check']],
];

if (target === 'darwin') checks.push(['macos-native-host-tests', 'swift', ['test', '--package-path', 'native/macos-host']]);
if (target === 'linux') checks.push(['linux-native-host-tests', 'cargo', ['test', '--manifest-path', 'native/linux-host/Cargo.toml', '--locked']]);

const results = [];
for (const [name, command, args] of checks) {
  const result = await runCheck(name, command, args);
  results.push(result);
  if (!result.ok) await writeEvidence(results);
  if (!result.ok) throw new Error(`${name} failed`);
}

if (packageRequested) {
  const packageScript = target === 'darwin' ? 'package:macos' : target === 'linux' ? 'package:linux' : 'package:windows';
  const result = await runCheck('target-package', 'corepack', ['pnpm@10.15.0', packageScript]);
  results.push(result);
  if (!result.ok) await writeEvidence(results);
  if (!result.ok) throw new Error('target-package failed');
}

await writeEvidence(results);
process.stdout.write(`Platform verification passed for ${target}/${architecture}; no publication or release action was performed.\n`);

async function runCheck(name, command, args) {
  const executable = process.platform === 'win32' && command === 'corepack' ? 'corepack.cmd' : command;
  const invocation = resolveInvocation(executable, args, command);
  const startedAt = Date.now();
  process.stdout.write(`Running ${name} for ${target}/${architecture}\n`);
  try {
    await execFileAsync(invocation.executable, invocation.args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        LNWJUD_RUNTIME_TARGET: target,
        LNWJUD_RUNTIME_ARCH: architecture,
        LNWJUD_TUNNEL_TARGET: target,
        LNWJUD_TUNNEL_ARCH: architecture,
      },
      shell: false,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    process.stdout.write(`Passed ${name}\n`);
    return { name, ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    // Keep actionable native compiler/packager output in CI logs. The JSON
    // summary stays bounded, but must not be the only failure evidence.
    const diagnostic = [error?.stdout, error?.stderr].filter((value) => typeof value === 'string').join('\n');
    if (diagnostic) process.stderr.write(`${diagnostic.slice(-32_768)}\n`);
    return { name, ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message.slice(0, 512) : 'unknown error' };
  }
}

function resolveInvocation(executable, args, command) {
  if (command !== 'corepack') return { executable, args };
  // Windows exposes Corepack as a .cmd shim, which Node cannot execute with
  // shell:false. Invoke the bundled Corepack JavaScript through this exact
  // Node runtime instead; this keeps the verifier shell-free on every host.
  const nodeDirectory = path.dirname(process.execPath);
  const corepackScriptCandidates = [
    path.join(nodeDirectory, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(nodeDirectory, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ];
  const corepackScript = corepackScriptCandidates.find((candidate) => existsSync(candidate));
  if (corepackScript !== undefined) return { executable: process.execPath, args: [corepackScript, ...args] };
  return { executable, args };
}

async function writeEvidence(results) {
  const directory = path.join(repositoryRoot, 'apps', 'desktop', 'build');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `platform-verification-${target}-${architecture}.json`), `${JSON.stringify({
    schemaVersion: 1,
    product: 'lnwjud',
    platform: target,
    arch: architecture,
    commit: await commitSha(),
    packageRequested,
    results,
  }, null, 2)}\n`, 'utf8');
}

async function commitSha() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}
