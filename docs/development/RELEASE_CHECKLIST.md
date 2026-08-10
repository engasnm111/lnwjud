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
