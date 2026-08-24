import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(desktopRoot, 'build');
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (nodeMajor !== 24) {
  // Allow Node 20+ in development/build environments if nodeMajor is not strictly 24, but warn
  if (nodeMajor < 20) {
    throw new Error(`lnwjud packaged stdio requires Node.js 20+ (recommended 24.x); got ${process.versions.node}`);
  }
}

mkdirSync(buildDir, { recursive: true });

// 1. Windows .cmd launcher
const cmdPath = path.join(buildDir, 'lnwjud-mcp-stdio.cmd');
const cmdContents = `@echo off
setlocal
set "BASE=%~dp0"
set "SCRIPT=%BASE%lnwjud-mcp-stdio.cjs"
set "NODE_EXE=%BASE%lnwjud-node.exe"
if not exist "%SCRIPT%" set "SCRIPT=%BASE%resources\\lnwjud-mcp-stdio.cjs"
if not exist "%NODE_EXE%" set "NODE_EXE=%BASE%resources\\lnwjud-node.exe"
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
writeFileSync(cmdPath, cmdContents.replace(/\r?\n/g, '\r\n'), 'utf8');

// 2. POSIX / macOS shell launcher
const shPath = path.join(buildDir, 'lnwjud-mcp-stdio');
const shContents = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/lnwjud-mcp-stdio.cjs"
NODE_EXE="$DIR/lnwjud-node"

if [ ! -f "$SCRIPT" ]; then
  SCRIPT="$DIR/../Resources/lnwjud-mcp-stdio.cjs"
fi
if [ ! -f "$SCRIPT" ]; then
  SCRIPT="$DIR/resources/lnwjud-mcp-stdio.cjs"
fi

if [ ! -f "$NODE_EXE" ]; then
  NODE_EXE="$DIR/../Resources/lnwjud-node"
fi
if [ ! -f "$NODE_EXE" ]; then
  NODE_EXE="$DIR/resources/lnwjud-node"
fi

if [ ! -f "$SCRIPT" ]; then
  echo "lnwjud-mcp-stdio: launcher script missing: $SCRIPT" >&2
  exit 1
fi

if [ ! -f "$NODE_EXE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_EXE="node"
  else
    echo "lnwjud-mcp-stdio: bundled Node runtime missing: $NODE_EXE" >&2
    exit 1
  fi
fi

exec "$NODE_EXE" "$SCRIPT" "$@"
`;
writeFileSync(shPath, shContents.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o755 });
try { chmodSync(shPath, 0o755); } catch { /* ignore on windows */ }

// 3. Copy bundled Node binary
const isWin = process.platform === 'win32';
const targetNodeBinName = isWin ? 'lnwjud-node.exe' : 'lnwjud-node';
const bundledNodePath = path.join(buildDir, targetNodeBinName);
copyFileSync(process.execPath, bundledNodePath);
try { chmodSync(bundledNodePath, 0o755); } catch { /* ignore on windows */ }

if (isWin) {
  // Also create non-exe symlink/copy if needed
} else {
  // Also create lnwjud-node.exe dummy or copy if cross-packaging
  const winNodePath = path.join(buildDir, 'lnwjud-node.exe');
  if (bundledNodePath !== winNodePath) {
    try { copyFileSync(process.execPath, winNodePath); } catch { /* ignore */ }
  }
}

process.stdout.write(`Bundled private Node runtime ${process.versions.node} -> ${bundledNodePath}\n`);
