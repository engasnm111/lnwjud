# Windows packaging

**v5.9.0 acceptance:** Local packaging does not publish a release or prove the
automatic updater. Unattended installation is currently unavailable on every
distribution. The normal `latest.yml`/`portable.yml` feeds below preserve
distribution selection for checking, downloading and user-requested installs;
they do not establish package authority, global drain, health or trusted
rollback. A fresh final-source installer/service matrix and real signed updater
acceptance are required before release. Earlier installed candidates and
checks are recorded in the [acceptance ledger](../codebase/2026-10-20-v5.9.0-issues-213-217-acceptance.md).

The lnwjud desktop package is built with Electron and packaged for **Windows 10/11 x64** as both an NSIS installer and a single-file portable executable. The graphical Electron application carries its own Electron runtime; a separate system Node installation is not required merely to open the dashboard.

The packaged MCP stdio launcher is self-contained: `lnwjud-mcp-stdio.cmd` launches the packaged Electron host with `--mcp-stdio`. No private Node executable or generated CJS bundle is shipped, and installed users do not need a separate system Node.js installation for stdio MCP or OpenAI Secure MCP Tunnel.

Core text/file search is also self-contained. Packaging downloads the pinned official Windows x64 ripgrep archive, verifies its SHA-256, preserves its license notices, and ships `resources/runtime-tools/ripgrep/rg.exe` in both Setup and Portable builds. Desktop and `lnwjud-mcp-stdio.cmd` prepend that private directory to the child runtime PATH, so users do not need to install ripgrep themselves.

OpenAI Secure MCP Tunnel is self-contained as well. Packaging pins official `tunnel-client v0.0.16` for Windows amd64 and verifies the archive SHA-256 before extraction. The target-native payload is preserved under `resources/tunnel-client/` with the executable, license/notice inventory, SPDX metadata, and Sigstore provenance; lnwjud also records the archive/runtime hashes used for provenance. The bundled client is selected only when the override is empty, and a missing or invalid custom override fails closed instead of silently falling back.

On the first launch of each lnwjud version, Desktop runs the core Doctor checks automatically before tunnel onboarding. Only core failures (supported Windows x64, database, bundled ripgrep, workspace initialization, and local MCP readiness) interrupt startup and keep navigation on Doctor. Git and optional capabilities such as Codex, WSL, Python, FFmpeg, and Windows OCR may report warnings or feature-specific unavailable states but do not block first-run.

The current release target is x64 only. Windows 7/8/8.1 and 32-bit Windows are not supported release targets.

Windows 10 and Windows 11 use different renderer compatibility defaults. `platform-compatibility.ts` recognizes NT build 10240+ as Windows 10 and build 22000+ as Windows 11. Windows 10 disables Electron hardware acceleration before `app.whenReady()` so older Intel/AMD/NVIDIA drivers use software rendering; Windows 11 keeps hardware acceleration enabled. This does not weaken `sandbox`, `contextIsolation`, or `webSecurity`.

Product-internal Windows plumbing uses built-in `powershell.exe` where required, without requiring PowerShell 7. Managed process containment uses the protected native service rather than a PowerShell launcher. Runtime child launches use `windowsHide: true`. Durable shell has a default 16-job budget shared through its disk index. Managed-writer reservations have a separate budget while retaining the same exclusive import fence. `ProcessManager` has a default cap of 24 active managed processes. Task-list admission counts describe held reservations, not process liveness.

## Build

From the repository root in PowerShell:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 package:windows
```

For an installable **validation candidate only** when the currently installed Native Service is broken, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-v590-test-installer.ps1` on the Windows developer machine. This builds Setup/Portable and runs local native/unit/typecheck checks but **defers**, not passes, installed-service tests. After installing the candidate as **all users**, run the script with `-RequireInstalledService` and independently verify Native Service shell/process launch plus authenticated zero-active Job termination. A local `RUNNING` service state and matching image SHA256 do not establish that acceptance. On 2026-10-21, an installed candidate recovered Writer Lease generation 42 but `shell` hit `PIPE_LAUNCH_SESSION_CHANGE_FAILED` during token session normalization, while `process_start` returned `INTERNAL_ERROR`. The rebuilt candidate was installed, and its installed `manifest.json` matches workspace SHA256 declarations (helper `35b88b51e7572bd0b27ca862fe1ee01580731fc05c1316e406989e524a146aae`); independent executable-byte hashing was unavailable. Fresh `shell` launches still exit `-1` without output and `process_start` returns `INTERNAL_ERROR`. Numeric Win32 diagnostics and pre-dispatch abort handling are present in source, but installed native launch and authenticated termination have not passed. Do not change PowerShell policy, force-clear reservation markers, claim a green gate or publish v5.9.0 on this evidence alone.

The package script rebuilds the workspace, prepares the first-party Windows containment helper, pin module, manifest and runtime bundle, and updates the compiled integrity pins before the application build. It prepares the target-native stdio launcher, writes both Windows executables to `apps/desktop/dist/installers/`, writes update metadata for both distribution channels, and finishes by generating and verifying `SHA256SUMS.txt` plus `PROVENANCE.json`. Provenance records the exact Git commit, tracked-tree dirty state, release artifact hashes, and critical packaged runtime hashes without storing signing secrets.

For Windows x64 Native Pin compilation, `pin/build.mjs` uses installed LLVM `clang-cl.exe` with `lld-link.exe` when both are present under `C:/Program Files/LLVM/bin`; otherwise it retains the MSVC compiler fallback. Both paths keep `/Brepro` and the pinned Node N-API headers, and the produced addon and helper are always SHA-256 bound in `manifest.json` and the generated TypeScript integrity constants. This is a build-tool choice, not an exception to native Job Object zero-active-process proof: MSVC 14.51 can leave a `vctip.exe` telemetry process active after linking even with `VSCMD_SKIP_SENDTELEMETRY=1`, so a `timed_out` native wrapper is not a passing build gate. On 2026-10-22, the LLVM path reproducibly produced Pin SHA-256 `2bce3428ad0e69b4fd28ff7c827ee45296f4ac7d5b520a7cc17ecb7da0d39e5c` in two builds; a separate process loaded its Node N-API export, and the scoped native wrapper completed with exit code zero. Hosted CI and official release evidence must still be established independently.

## Current electron-builder contract

`apps/desktop/electron-builder.yml` is the source of truth. The current v5.9.0 packaging contract is:

- `asar: true`.
- Windows x64 targets: NSIS installer + portable executable.
- NSIS defaults to all-users installation (`selectPerMachineByDefault: true`) while keeping the install-mode page available for users who need per-user mode.
- All-users installs register the LocalSystem Windows containment service from `resources/native-containment/lnwjud-containment.exe` with `service-install`; the service is stopped and removed before its installed image is removed. Its image, `manifest.json`, and `lnwjud-containment-pin.node` are hash-checked and protected from user writes.
- ACL validation distinguishes read/execute grants from mutation grants. Normal Program Files and Authenticated Users read/execute permissions are permitted; untrusted effective write, delete, permission-change and ownership grants remain refused. Installer and service-store regressions exercise this distinction. An early local 5.9.0 test installer incorrectly treated read/execute as write and failed service installation with exit125. Replace that test installer with the rebuilt package; changing Program Files permissions or PowerShell policy is not a repair.
- A fresh service store is created with its protected SYSTEM and Administrators ACL already applied. It does not inherit ProgramData's user-write grants before validation. An existing store with untrusted mutation rights, including descendant-only grants, is refused before its permissions or persisted state can be changed.
- Per-user and Portable builds do not register that machine service. They require an installed protected service with the exact matching package hash. Without one, native managed operations fail closed.
- To migrate an existing per-user installation, run Setup and select all-users. If the installer retains the previous per-user scope, uninstall that copy while choosing to keep user data, then install again and select all-users. This does not change PowerShell Execution Policy.
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
- `resources/native-containment/` carries the trusted runtime bundle `process-runtime.mjs`; Windows additionally packages the self-contained `lnwjud-containment.exe`, hash-pinned `lnwjud-containment-pin.node`, and schema-versioned `manifest.json`. The desktop package runs `prepare-containment-runtime.mjs` before compiling the app so these hashes are embedded in the host bundle and verified again against packaged files.
- The generated `lnwjud-mcp-stdio.cmd` has one canonical packaged copy beside `lnwjud.exe` for local stdio use. POSIX packages use the matching executable shell launcher. The package also includes the hash-bound native Windows secret migrator for one-time legacy data migration; no PowerShell secret runtime is shipped.
- Pinned ripgrep is shipped under `resources/runtime-tools/ripgrep`; both Desktop and the stdio launcher resolve this private `rg.exe` before any system PATH copy.
- The six pinned Ponytail skills are sourced from upstream stable `v5.3.2` (tag commit `16352ac229eb08a9598dcae48fe9f2b342567d86`); each skill ships an MIT `LICENSE` and `SOURCE.md` and must pass the exact packaged-binary inventory and provenance checks in [Ponytail integration](../PONYTAIL.md). Older static source checks do not prove a newly installed helper or package works.
- The repository's `lnwjud-scheduled-continuation` skill plus the six pinned Ponytail skills (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`) are shipped as sibling directories under `resources/agent-skills` in both Setup/NSIS and Portable. Their source-qualified bundled identities remain distinct from same-name machine-global or active-workspace Cursor, Claude, Agents, Codex, Codex-plugin, GitHub workspace, or configured skill roots; Native Ponytail activation accepts only the exact bundled primary/review identities.
- The launcher never falls back to a system Node runtime; a missing packaged Electron executable fails closed.
- Generated stdio runtime files are ignored by Git and must be regenerated from source for each build/release.

`signAndEditExecutable: true` does not by itself mean the release is Authenticode-signed with a publisher certificate. lnwjud does not require a paid signing credential to publish a community release: when production signing secrets are absent, Windows artifacts may remain `NotSigned` after the same SHA-256/provenance checks; when signing is configured, Setup and Portable must verify as Authenticode `Valid`. Production publisher trust is therefore optional release metadata, not something the package config can manufacture.

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

For v5.9.0:

```text
apps/desktop/dist/installers/lnwjud-Setup-5.9.0.exe
apps/desktop/dist/installers/lnwjud-Setup-5.9.0.exe.blockmap
apps/desktop/dist/installers/lnwjud-Portable-5.9.0.exe
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
8. Call `skills_list` and confirm it includes bundled `lnwjud-scheduled-continuation` plus all six sibling Ponytail skills, a test machine-global skill, and a test active-workspace skill; call `skills_read` with each source-qualified ID. With Ponytail FULL enabled, also verify code mutation is blocked before exact bundled primary load, succeeds after `bundled:agent-skills/ponytail` loads even when matching returns no result, and rejects a same-name workspace skill as activation evidence. Verify the same contract through Desktop HTTP MCP and the packaged stdio launcher.
9. Close the app, uninstall it from Windows Settings, and confirm the application binaries are removed while user data remains according to `deleteAppDataOnUninstall: false`.
10. Launch `lnwjud-Portable-*.exe` without installing it and repeat dashboard/workspace/Doctor/tunnel/skill smoke checks.
11. Confirm no visible CMD/PowerShell window flashes during normal internal operations. Short-lived hidden `conhost.exe` processes are acceptable; sustained high CPU is not.
12. From an installed build, verify an available update resolves through `latest.yml` to the next Setup executable; from a Portable build, verify it resolves through `portable.yml` to the next Portable executable and never switches distribution type.
13. For Portable replacement, verify the same outer EXE path restarts after update and that a forced replacement failure restores the backup instead of leaving the app missing.

Record artifact path, OS architecture, launch result, database creation, workspace add, Doctor result, stdio/tunnel result when tested, and uninstall/portable result. Do not record credentials, environment-variable values, runtime API keys, or full terminal history.
