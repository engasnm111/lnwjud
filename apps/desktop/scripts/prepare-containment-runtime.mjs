import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const stageDirectory = path.join(desktopRoot, 'build/native-containment');
const generatedPath = path.join(repositoryRoot, 'packages/capabilities/src/containment-integrity.generated.ts');
const execute = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareContainmentRuntime() {
  await mkdir(stageDirectory, { recursive: true });
  const runtimePath = path.join(stageDirectory, 'process-runtime.mjs');
  await build({
    entryPoints: [path.join(repositoryRoot, 'packages/process/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['development'],
    outfile: runtimePath,
    banner: { js: "import { createRequire as __lnwjudCreateRequire } from 'node:module'; const require = __lnwjudCreateRequire(import.meta.url);" },
  });
  let helperSha256 = '0'.repeat(64);
  let pinSha256 = '0'.repeat(64);
  if (process.platform === 'win32') {
    const sourceDirectory = path.join(repositoryRoot, 'native/windows-containment-helper');
    const outputDirectory = path.join(sourceDirectory, 'artifacts/win-x64');
    await execute('dotnet', ['publish', path.join(sourceDirectory, 'WindowsContainmentHelper.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', outputDirectory, '--disable-build-servers', '-p:UseSharedCompilation=false'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' },
    });
    await execute(process.execPath, [path.join(sourceDirectory, 'pin/build.mjs'), outputDirectory], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const source = path.join(outputDirectory, 'lnwjud-containment.exe');
    const bytes = await readFile(source);
    helperSha256 = digest(bytes);
    await copyFile(source, path.join(stageDirectory, 'lnwjud-containment.exe'));
    const pinSource = path.join(outputDirectory, 'lnwjud-containment-pin.node');
    pinSha256 = digest(await readFile(pinSource));
    await copyFile(pinSource, path.join(stageDirectory, 'lnwjud-containment-pin.node'));
    const manifest = JSON.stringify({
      schemaVersion: 2,
      buildId: 'lnwjud-containment-v2',
      platform: 'win32',
      architecture: 'x64',
      filename: 'lnwjud-containment.exe',
      sha256: helperSha256,
      pinFilename: 'lnwjud-containment-pin.node',
      pinSha256,
    }) + '\n';
    await writeFile(path.join(outputDirectory, 'manifest.json'), manifest);
    await writeFile(path.join(stageDirectory, 'manifest.json'), manifest);
  }
  const runtimeSha256 = digest(await readFile(runtimePath));
  await writeFile(generatedPath, [
    `export const CONTAINMENT_HELPER_SHA256 = '${helperSha256}' as const;`,
    `export const CONTAINMENT_PIN_SHA256 = '${pinSha256}' as const;`,
    `export const CONTAINMENT_RUNTIME_SHA256 = '${runtimeSha256}' as const;`,
    '',
  ].join('\n'));
  return { helperSha256, pinSha256, runtimeSha256 };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await prepareContainmentRuntime()) + '\n');
}
