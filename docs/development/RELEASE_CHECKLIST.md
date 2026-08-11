# lnwjud MVP release checklist

Run the release gate from PowerShell at the repository root:

```powershell
corepack pnpm@10.15.0 test:release-gate
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1
```

The gate runs the pinned-lockfile install, lint, typecheck, package tests, integration tests, Electron E2E tests, build, packaging test, and Windows packaging in that order. It stops on the first non-zero command, checks `git diff --check`, and rejects secret-like paths from the tracked file list. It does not read credentials, environment values, or Codex authentication state.

## Evidence to capture

- Workspace traversal and junction/reparse-point tests pass; default secret-file policy remains denied.
- MCP local HTTP security suite passes, including loopback binding, Origin policy, body limits, and method/header validation.
- Process injection and process ownership tests pass, including bounded stdout/stderr output limit tests.
- The fake Codex review flow edits only the disposable fixture and produces a reviewable Git diff.
- The packaged-app smoke produces an x64 NSIS installer under `apps/desktop/dist/installers/` and the installer is tested on a clean Windows account or VM.
- On the clean Windows account or VM: launch the installed app, confirm the SQLite database is created, add a disposable workspace, run Doctor, close the app, uninstall it, and confirm the expected application/user-data removal.
- Manually run `codex doctor` and one low-impact real Codex delegation in a disposable Git fixture. Do not automate quota use or read credential files.
- `git diff --check` passes and the tracked tree contains no `.env` (other than `.env.example`), keys, certificates, SSH/AWS credential files, or local databases.

Record command names, pass/fail results, OS architecture, installer path, and relevant error codes only. Do not record credentials, tokens, environment variables, prompts, full terminal history, or full source/database contents.

## Known host limitation

If Electron cannot start a BrowserWindow because the test host's Chromium GPU process fails, preserve the failure output and rerun the launch/install/uninstall portion on a clean Windows account or VM. Do not add `--disable-gpu-sandbox`, disable `contextIsolation`, disable `sandbox`, or weaken `webSecurity` to make the gate pass.

## Verification record — 2026-08-11

- Windows process/runtime architecture: x64; Node `v24.16.0`; Electron `43.2.0`.
- `corepack pnpm@10.15.0 diagnose:electron`: exit `0`; the unpackaged app survived the diagnostic timeout with no Electron child exit and no GPU exit code.
- `corepack pnpm@10.15.0 lint`: exit `0`.
- `corepack pnpm@10.15.0 typecheck`: exit `0`.
- `corepack pnpm@10.15.0 test`: exit `0`.
- `corepack pnpm@10.15.0 test:integration`: exit `0`.
- `corepack pnpm@10.15.0 --filter @lnwjud/desktop test:e2e`: exit `0`; 3/3 tests passed, including the real local MCP client workflow and Electron security checks.
- Packaged workflow: `LNWJUD_PACKAGED_EXECUTABLE=apps/desktop/dist/installers/win-unpacked/lnwjud.exe corepack pnpm@10.15.0 exec playwright test --config playwright.config.ts e2e/desktop-mcp-client.e2e.ts`: exit `0`; packaged app launched, created isolated SQLite user data, served MCP, completed the client workflow, and stopped cleanly.
- `corepack pnpm@10.15.0 build`: exit `0`.
- `corepack pnpm@10.15.0 test:packaging`: exit `0`.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1`: exit `0`; the pinned install, all automated release checks, packaging, and `git diff --check` passed.
- Installer: `apps/desktop/dist/installers/lnwjud-Setup-0.1.0.exe`.
- No Electron security setting was weakened: `sandbox`, `contextIsolation`, and `webSecurity` remain enabled; no `--no-sandbox` or `--disable-gpu-sandbox` was committed.
- An earlier restricted-host diagnostic reported GPU `0xC0000135`; the normal Windows user-context diagnostic now passes without that failure.
- Normal-user Codex discovery: `codex.exe --version` and `codex.exe --help` both exit `0`; installed version `0.147.0`; discovery reports `exec` capability. No Codex credentials were read.
- Clean-account/VM installer install-uninstall and one real Codex delegation remain manual evidence not captured by this run. The automated fake Codex delegation/review flow passes; real provider execution is intentionally not automated because it may consume account quota.
