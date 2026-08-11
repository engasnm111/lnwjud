# Local desktop workflow

lnwjud is a Windows-first local development gateway. It exposes an explicitly authorized workspace to an MCP client for bounded file, search, Git, project-process, and optional local Codex operations.

## Quick start

Requirements: Windows x64, Node.js 24 LTS, Git, and Corepack.

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
Set-Location apps\desktop
corepack pnpm@10.15.0 exec electron dist\main\main.js
```

In the dashboard:

1. Add a workspace directory and note its displayed workspace ID.
2. Select `Balanced` when the MCP client needs write or execute operations; `Safe` prompts for those operations.
3. Select `Start Connection`, then copy the `http://127.0.0.1:<port>/mcp` endpoint into the local MCP client.
4. Pass the workspace ID explicitly to MCP tools. Select `Stop Connection` when finished.

The MCP server is loopback-only and uses the same application services as the desktop UI. Renderer code has no direct filesystem or process access; Electron keeps `sandbox`, `contextIsolation`, and `webSecurity` enabled. Codex discovery checks only the executable, `--version`, and `--help`; it does not inspect credentials. Codex is optional and reports a degraded/unavailable state when absent.

## Verification

```powershell
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 --filter @lnwjud/desktop test:e2e
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

The release script also builds the x64 NSIS installer and fails on the first non-zero stage. It does not read credentials or weaken Electron security settings.
