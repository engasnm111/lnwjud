import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(desktopRoot, 'build');
const cmdPath = path.join(buildDir, 'lnwjud-mcp-stdio.cmd');
const shPath = path.join(buildDir, 'lnwjud-mcp-stdio');
const isWin = process.platform === 'win32';
const targetNodeBinName = isWin ? 'lnwjud-node.exe' : 'lnwjud-node';
const bundledNodePath = path.join(buildDir, targetNodeBinName);
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

// The packaged stdio bundle must be generated from a real Node runtime. Builds are
// expected on Node 24 LTS; anything at or above 20 still produces a working bundle
// so development machines on other runtimes are not blocked.
if (nodeMajor !== 24 && nodeMajor < 20) {
  throw new Error(`lnwjud packaged stdio requires Node.js 20+ (recommended 24.x); got ${process.versions.node}`);
}

const cmdContents = `@echo off
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

// POSIX/macOS launcher mirrors the Windows one so packaged DMG/ZIP builds ship an
// executable stdio entry point without requiring a system-wide Node.js install.
const shContents = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/lnwjud-mcp-stdio.cjs"
NODE_EXE="$DIR/lnwjud-node"

for candidate in "$DIR/../Resources/resources" "$DIR/resources"; do
  if [ ! -f "$SCRIPT" ] && [ -f "$candidate/lnwjud-mcp-stdio.cjs" ]; then
    SCRIPT="$candidate/lnwjud-mcp-stdio.cjs"
  fi
  if [ ! -x "$NODE_EXE" ] && [ -x "$candidate/lnwjud-node" ]; then
    NODE_EXE="$candidate/lnwjud-node"
  fi
done

RIPGREP_BIN="$(find "$DIR/runtime-tools" "$DIR/../Resources/resources" "$DIR/resources" -type f -name rg 2>/dev/null | head -1)"
if [ -n "$RIPGREP_BIN" ]; then
  case ":$PATH:" in
    *"$(dirname "$RIPGREP_BIN")":*) ;;
    *) PATH="$(dirname "$RIPGREP_BIN"):$PATH" && export PATH ;;
  esac
fi

if [ ! -f "$SCRIPT" ]; then
  echo "lnwjud-mcp-stdio: launcher script missing: $SCRIPT" >&2
  exit 1
fi

if [ ! -x "$NODE_EXE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_EXE="node"
  else
    echo "lnwjud-mcp-stdio: bundled Node runtime missing: $NODE_EXE" >&2
    exit 1
  fi
fi

exec "$NODE_EXE" "$SCRIPT" "$@"
`;

mkdirSync(buildDir, { recursive: true });

writeFileSync(cmdPath, cmdContents.replace(/\r?\n/g, '\r\n'), 'utf8');
writeFileSync(shPath, shContents.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o755 });
try { chmodSync(shPath, 0o755); } catch { /* chmod is best effort outside POSIX filesystems */ }

// Ship both runtime binary spellings so each platform's installer finds its file even
// when the bundle was produced by a different host OS.
copyFileSync(process.execPath, bundledNodePath);
try { chmodSync(bundledNodePath, 0o755); } catch { /* ignore on windows */ }
copyFileSync(process.execPath, path.join(buildDir, isWin ? 'lnwjud-node' : 'lnwjud-node.exe'));

process.stdout.write(`Bundled private Node runtime ${process.versions.node} -> ${bundledNodePath}\n`);
