import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runtimeTargetKey } from './runtime-asset-manifest.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(desktopRoot, 'build');
const scriptPath = path.join(buildDir, 'lnwjud-mcp-stdio.cjs');
const windowsLauncherPath = path.join(buildDir, 'lnwjud-mcp-stdio.cmd');
const posixLauncherPath = path.join(buildDir, 'lnwjud-mcp-stdio');
const windowsNodePath = path.join(buildDir, 'lnwjud-node.exe');
const posixNodePath = path.join(buildDir, 'lnwjud-node');
const metadataPath = path.join(buildDir, 'BUNDLED_NODE.txt');
const target = runtimeTargetKey();
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (nodeMajor !== 24) throw new Error(`lnwjud packaged stdio requires the build runtime to be Node.js 24.x; got ${process.versions.node}`);
if (!existsSync(scriptPath)) throw new Error(`lnwjud packaged stdio bundle is missing: ${scriptPath}`);

mkdirSync(buildDir, { recursive: true });
const nodePath = process.platform === 'win32' ? windowsNodePath : posixNodePath;
const preparedMetadata = existsSync(metadataPath) ? readFileSync(metadataPath, 'utf8') : '';
const verifiedPreparedNode = preparedMetadata.includes('source=verified-download') && preparedMetadata.includes(`target=${target}`) && existsSync(nodePath);
if (!verifiedPreparedNode) {
  copyFileSync(process.execPath, nodePath);
  if (process.platform !== 'win32') chmodSync(nodePath, 0o755);
  const executableHash = createHash('sha256').update(readFileSync(nodePath)).digest('hex');
  writeFileSync(metadataPath, [
    'source=build-runtime',
    `target=${target}`,
    `version=${process.versions.node}`,
    `executable_sha256=${executableHash}`,
    '',
  ].join('\n'), 'utf8');
}

if (process.platform === 'win32') {
  rmSync(posixLauncherPath, { force: true });
  rmSync(posixNodePath, { force: true });
  const contents = `@echo off
setlocal
set "BASE=%~dp0"
set "SCRIPT=%BASE%lnwjud-mcp-stdio.cjs"
set "NODE_EXE=%BASE%lnwjud-node.exe"
set "RIPGREP_DIR=%BASE%runtime-tools\\ripgrep"
if not exist "%RIPGREP_DIR%\\rg.exe" set "RIPGREP_DIR=%BASE%resources\\runtime-tools\\ripgrep"
if exist "%RIPGREP_DIR%\\rg.exe" set "PATH=%RIPGREP_DIR%;%PATH%"
if not exist "%SCRIPT%" (
  echo lnwjud-mcp-stdio: launcher script missing: %SCRIPT% 1>&2
  exit /b 1
)
if not exist "%NODE_EXE%" (
  echo lnwjud-mcp-stdio: bundled Node runtime missing: %NODE_EXE% 1>&2
  exit /b 1
)
rem Use the private Node 24 runtime shipped with lnwjud; no system Node.js is required.
"%NODE_EXE%" "%SCRIPT%" %*
`;
  writeFileSync(windowsLauncherPath, contents.replace(/\n/g, '\r\n'), 'utf8');
  process.stdout.write(`Prepared Windows packaged stdio launcher for ${target}: ${windowsLauncherPath}\n`);
} else {
  rmSync(windowsLauncherPath, { force: true });
  rmSync(windowsNodePath, { force: true });
  const contents = `#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$BASE/lnwjud-mcp-stdio.cjs"
NODE_EXE="$BASE/lnwjud-node"
RIPGREP_DIR=""
for CANDIDATE in "$BASE/runtime-tools/ripgrep" "$BASE/resources/runtime-tools/ripgrep" "$BASE/Resources/runtime-tools/ripgrep"; do
  if [ -x "$CANDIDATE/rg" ]; then RIPGREP_DIR="$CANDIDATE"; break; fi
done
if [ -n "$RIPGREP_DIR" ]; then PATH="$RIPGREP_DIR\${PATH:+:$PATH}"; export PATH; fi
if [ ! -f "$SCRIPT" ]; then
  echo "lnwjud-mcp-stdio: launcher script missing: $SCRIPT" >&2
  exit 1
fi
if [ ! -x "$NODE_EXE" ]; then
  echo "lnwjud-mcp-stdio: bundled Node runtime missing or not executable: $NODE_EXE" >&2
  exit 1
fi
# Use the private Node 24 runtime shipped with lnwjud; no system Node.js is required.
exec "$NODE_EXE" "$SCRIPT" "$@"
`;
  writeFileSync(posixLauncherPath, contents, { encoding: 'utf8', mode: 0o755 });
  chmodSync(posixLauncherPath, 0o755);
  process.stdout.write(`Prepared POSIX packaged stdio launcher for ${target}: ${posixLauncherPath}\n`);
}
