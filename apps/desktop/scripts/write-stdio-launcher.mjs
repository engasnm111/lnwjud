import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(desktopRoot, 'build');
const cmdPath = path.join(buildDir, 'lnwjud-mcp-stdio.cmd');
const shellPath = path.join(buildDir, 'lnwjud-mcp-stdio.sh');
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (nodeMajor !== 24) throw new Error(`lnwjud packaged stdio requires the build runtime to be Node.js 24.x; got ${process.versions.node}`);

const windowsContents = `@echo off
setlocal
set "BASE=%~dp0"
set "APP=%BASE%lnwjud.exe"
if not exist "%APP%" (
  echo lnwjud-mcp-stdio: packaged Electron executable missing: %APP% 1>&2
  exit /b 1
)
"%APP%" --mcp-stdio %*
exit /b %ERRORLEVEL%
`;

const shellContents = `#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP=""
for candidate in \
  "$BASE/lnwjud" \
  "$BASE/lnwjud.app/Contents/MacOS/lnwjud" \
  "$BASE/MacOS/lnwjud" \
  "$BASE/../MacOS/lnwjud" \
  "$BASE/../lib/lnwjud/lnwjud" \
  "$BASE/../opt/lnwjud/lnwjud"; do
  if [ -x "$candidate" ]; then APP="$candidate"; break; fi
done
if [ -z "$APP" ]; then
  echo "lnwjud-mcp-stdio: packaged Electron executable was not found beside the launcher" >&2
  exit 1
fi
exec "$APP" --mcp-stdio "$@"
`;

mkdirSync(buildDir, { recursive: true });
writeFileSync(cmdPath, windowsContents.replace(/\n/g, '\r\n'), 'utf8');
writeFileSync(shellPath, shellContents, { encoding: 'utf8', mode: 0o755 });
try { chmodSync(shellPath, 0o755); } catch { /* Windows checkout does not expose POSIX mode bits. */ }
process.stdout.write(`Generated packaged Electron STDIO launchers: ${cmdPath}, ${shellPath}\n`);
