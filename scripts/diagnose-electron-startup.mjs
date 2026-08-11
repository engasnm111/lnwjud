import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const timeoutMs = 10_000;
const outputLimit = 1024 * 1024;

await access(electronExecutable);
await access(mainEntry);

const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-electron-startup-'));
const child = spawn(electronExecutable, ['--enable-logging=stderr', '--v=1', mainEntry], {
  cwd: desktopRoot,
  shell: false,
  windowsHide: true,
  env: { ...process.env, LNWJUD_DATA_PATH: dataRoot },
});
let stdout = '';
let stderr = '';
let spawnErrorCode;
child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-outputLimit); });
child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-outputLimit); });
child.once('error', (error) => { spawnErrorCode = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'; });

try {
  const result = await waitForStartup(child, timeoutMs);
  if (result.timedOut) await terminateProcessTree(child);
  const combinedOutput = `${stdout}\n${stderr}`;
  const gpuExitCodes = [...combinedOutput.matchAll(/exit_code=(-?\d+)/g)].map((match) => Number(match[1]));
  log(`electronExecutable=${electronExecutable}`);
  log(`mainEntry=${mainEntry}`);
  log(`dataPath=${dataRoot}`);
  log(`startupStatus=${result.timedOut ? 'survived-timeout' : 'exited'}`);
  log(`childExitCode=${formatCode(result.exitCode)}`);
  log(`spawnErrorCode=${spawnErrorCode ?? 'none'}`);
  log(`gpuExitCodes=${gpuExitCodes.length === 0 ? 'none' : gpuExitCodes.map(formatCode).join(',')}`);
  log('--- stdout ---');
  log(stdout);
  log('--- stderr ---');
  log(stderr);
  if (!result.timedOut && (result.exitCode ?? 1) !== 0) process.exitCode = 1;
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}

async function waitForStartup(process, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, exitCode: process.exitCode });
    }, timeout);
    process.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ timedOut: false, exitCode });
    });
  });
}

async function terminateProcessTree(childProcess) {
  if (childProcess.exitCode !== null || childProcess.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(childProcess.pid), '/T', '/F'], { shell: false, windowsHide: true });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  childProcess.kill('SIGTERM');
}

function formatCode(value) {
  if (value === null || value === undefined) return 'none';
  const unsigned = value >>> 0;
  return `${value} (0x${unsigned.toString(16).padStart(8, '0').toUpperCase()})`;
}

function log(value = '') {
  process.stdout.write(`${value}\n`);
}
