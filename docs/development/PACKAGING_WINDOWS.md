# Windows packaging

The lnwjud desktop package is built with Electron and packaged for **Windows 10/11 x64** as both an NSIS installer and a single-file portable executable. The graphical Electron application carries its own Electron runtime; a separate system Node installation is not required merely to open the dashboard.

The packaged MCP stdio launcher is self-contained: `lnwjud-mcp-stdio.cmd` launches the generated MCP bundle with a private `lnwjud-node.exe` copied from the pinned Node.js 24 build runtime. Installed and portable users do not need a separate system Node.js installation for stdio MCP or OpenAI Secure MCP Tunnel.

Core text/file search is also self-contained. Packaging downloads the pinned official Windows x64 ripgrep archive, verifies its SHA-256, preserves its license notices, and ships `resources/runtime-tools/ripgrep/rg.exe` in both Setup and Portable builds. Desktop and `lnwjud-mcp-stdio.cmd` prepend that private directory to the child runtime PATH, so users do not need to install ripgrep themselves.

On the first launch of each lnwjud version, Desktop runs the core Doctor checks automatically before tunnel onboarding. Only core failures (supported Windows x64, database, bundled ripgrep, workspace initialization, and local MCP readiness) interrupt startup and keep navigation on Doctor. Git and optional capabilities such as Codex, WSL, Python, FFmpeg, and Windows OCR may report warnings or feature-specific unavailable states but do not block first-run.

The current release target is x64 only. Windows 7/8/8.1 and 32-bit Windows are not supported release targets.

Windows 10 and Windows 11 use different renderer compatibility defaults. `windows-compatibility.ts` recognizes NT build 10240+ as Windows 10 and build 22000+ as Windows 11. Windows 10 disables Electron hardware acceleration before `app.whenReady()` so older Intel/AMD/NVIDIA drivers use software rendering; Windows 11 keeps hardware acceleration enabled. This does not weaken `sandbox`, `contextIsolation`, or `webSecurity`.

Product-internal Windows plumbing uses built-in `powershell.exe` rather than requiring PowerShell 7. Runtime child launches use `windowsHide: true`. Durable shell workers have a default global cap of 16 active tasks per runtime process and `ProcessManager` has a default cap of 24 active managed processes, preventing an unbounded child/conhost fan-out when multiple chats/projects submit work concurrently.

## Build

From the repository root in PowerShell:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 package:windows
```

The package script rebuilds the workspace, generates the current MCP stdio bundle/launcher, writes both Windows executables to `apps/desktop/dist/installers/`, writes update metadata for both distribution channels, and finishes by generating and verifying `SHA256SUMS.txt` plus `PROVENANCE.json`. Provenance records the exact Git commit, tracked-tree dirty state, release artifact hashes, and critical packaged runtime hashes without storing signing secrets.

## Current electron-builder contract

`apps/desktop/electron-builder.yml` is the source of truth. The current v4.31.0 packaging contract is:

- `asar: true`.
- Windows x64 targets: NSIS installer + portable executable.
- Installer is per-user (`perMachine: false`).
- User-selectable installer directory (`allowToChangeInstallationDirectory: true`).
- Branded `build/icon.ico` for the application, installer, and uninstaller.
- `signAndEditExecutable: true` for executable metadata/icon editing.
- `deleteAppDataOnUninstall: false`; uninstalling the application does **not** automatically remove lnwjud user data.
- NSIS renames electron-builder's generated uninstaller to the stable user-facing `uninstall.exe` and rewrites `UninstallString` / `QuietUninstallString` for the active per-user or per-machine install mode so Windows Settings and upgrades keep using the correct path.
- Portable mode launches without installation but intentionally uses the same per-user lnwjud data/settings location as the installed build. It is portable as an executable, not a "keep every setting beside the EXE" mode.
- Installer auto-update remains on electron-builder's normal `latest.yml` channel and installs `lnwjud-Setup-<version>.exe`.
- Portable auto-update uses a separate generated `portable.yml` channel and downloads only `lnwjud-Portable-<version>.exe`.
- Portable downloads are verified by electron-updater against the SHA-512/size in `portable.yml`, then replaced in place only after the running process exits. The helper keeps a rollback backup, restores it on replacement failure, restarts the exact outer Portable path, and cleans itself up.
- The updater never crosses distribution types: an installed user remains on Setup/NSIS updates and a Portable user remains on Portable EXE updates.
- Installer and Portable intentionally continue to share the same per-user lnwjud settings/data location.
- The Windows capability bridge is copied as an extra resource.
- The generated `lnwjud-mcp-stdio.cjs`, `lnwjud-mcp-stdio.cmd`, and private `lnwjud-node.exe` have one canonical packaged copy beside `lnwjud.exe` for tunnel/local stdio use. They are not duplicated under `resources`, reducing AV scan surface and keeping one runtime hash authoritative.
- Pinned ripgrep is shipped under `resources/runtime-tools/ripgrep`; both Desktop and the stdio launcher resolve this private `rg.exe` before any system PATH copy.
- The repository's `lnwjud-scheduled-continuation` skill is shipped under `resources/agent-skills` in both Setup/NSIS and Portable. The runtime adds that bundled root to `skills_list` without replacing machine-global or active-workspace Cursor, Claude, Agents, Codex, Codex-plugin, GitHub workspace, or configured skill roots.
- The launcher never falls back to Program Files, LocalAppData, or Node from PATH; a missing bundled Node runtime fails closed.
- Generated stdio runtime files are ignored by Git and must be regenerated from source for each build/release.

`signAndEditExecutable: true` does not by itself mean the release is Authenticode-signed with a publisher certificate. Production code-signing identity/certificate handling is a separate release/CI concern.

## Hidden console-process contract

Internal child processes launched by Desktop/process/capability code use `windowsHide: true` and do not intentionally display CMD/PowerShell windows. Windows can still create a hidden `conhost.exe` for a console-subsystem child such as Windows PowerShell; the presence of a short-lived Console Window Host process alone is normal. A visible flashing console window or a `conhost.exe` with sustained high CPU is not expected and should be treated as a regression/diagnostic signal.

The packaging/release tests include a source-level guard against changing the protected launch sites to `windowsHide: false`.

## Windows OCR helper (sparse package)

The WinRT OCR helper (`native/windows-ocr`) needs a signed sparse package for package identity. On the release machine:

1. `powershell -File scripts\build-windows-ocr.ps1` — publishes `lnwjud-windows-ocr.exe` to `native/windows-ocr/bin` (.NET SDK 8+ required; check with `scripts\check-wave-prereqs.ps1`).
2. `powershell -File scripts\register-windows-ocr.ps1` — signs and registers the sparse package with an external location. Dev mode creates and reuses a self-signed certificate (elevate once so it can be trusted in `LocalMachine\TrustedPeople`); release mode passes `-ReleaseCertPfx`/`-ReleaseCertPassword`.
3. `electron-builder.yml` ships `native/windows-ocr/bin` as the `windows-ocr` extra resource, so the helper is discovered at `%RESOURCES%\windows-ocr\lnwjud-windows-ocr.exe` on packaged machines. The host probes the helper (`{"op":"probe"}`) once and caches the identity result; without registration the `vision` OCR action reports a truthful unavailable state rather than failing.

The `makeappx.exe`/`signtool.exe` steps need the Windows SDK. No certificate or private key belongs in this repository.

## Expected Windows outputs

For v4.31.0:

```text
apps/desktop/dist/installers/lnwjud-Setup-4.31.0.exe
apps/desktop/dist/installers/lnwjud-Setup-4.31.0.exe.blockmap
apps/desktop/dist/installers/lnwjud-Portable-4.31.0.exe
apps/desktop/dist/installers/latest.yml
apps/desktop/dist/installers/portable.yml
apps/desktop/dist/installers/SHA256SUMS.txt
apps/desktop/dist/installers/PROVENANCE.json
```

Generic patterns:

```text
lnwjud-Setup-<version>.exe
lnwjud-Portable-<version>.exe
```

The NSIS installer produces its blockmap plus `latest.yml`. Portable has its own `portable.yml` and is an auto-updater target through the dedicated Portable channel; it is never installed through NSIS during a Portable update.

## Clean-machine smoke

Use a clean Windows 10/11 x64 account or VM with no repository checkout:

1. Install the generated `lnwjud-Setup-*.exe`.
2. Launch lnwjud and confirm the dashboard opens with Electron security settings intact.
3. Confirm the branded executable/tray/installer icon is present.
4. Add a disposable workspace and confirm its canonical path persists after restart.
5. Confirm the loopback MCP endpoint auto-starts and the displayed endpoint is usable by a local MCP client.
6. Run Doctor and confirm SQLite/platform dependency checks are reported truthfully.
7. If stdio/Secure Tunnel is part of the smoke test, verify `lnwjud-mcp-stdio.cmd` works on the clean machine **without** installing system Node.js.
8. Call `skills_list` and confirm it includes bundled `lnwjud-scheduled-continuation`, a test machine-global skill, and a test active-workspace skill; call `skills_read` with each source-qualified ID. Verify the same contract through Desktop HTTP MCP and the packaged stdio launcher.
9. Close the app, uninstall it from Windows Settings, and confirm the application binaries are removed while user data remains according to `deleteAppDataOnUninstall: false`.
10. Launch `lnwjud-Portable-*.exe` without installing it and repeat dashboard/workspace/Doctor/tunnel/skill smoke checks.
11. Confirm no visible CMD/PowerShell window flashes during normal internal operations. Short-lived hidden `conhost.exe` processes are acceptable; sustained high CPU is not.
12. From an installed build, verify an available update resolves through `latest.yml` to the next Setup executable; from a Portable build, verify it resolves through `portable.yml` to the next Portable executable and never switches distribution type.
13. For Portable replacement, verify the same outer EXE path restarts after update and that a forced replacement failure restores the backup instead of leaving the app missing.

Record artifact path, OS architecture, launch result, database creation, workspace add, Doctor result, stdio/tunnel result when tested, and uninstall/portable result. Do not record credentials, environment-variable values, runtime API keys, or full terminal history.
