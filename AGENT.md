# AGENT.md — Operating guide for the lnwjud repo

Cross-platform (macOS + Windows) Electron desktop MCP gateway for ChatGPT.
pnpm monorepo (~20 workspace projects), Electron 43.4.1, electron-builder 26,
TypeScript (strict, `explicit-function-return-type` enforced by ESLint),
vitest 3. Branch `feat/macos-support` adds first-class macOS support on top of
the Windows-first upstream.

Git layout on this machine:

- `origin`  → `misternay/lnwjud` (our fork)
- `upstream`→ `engasnm111/lnwjud` (source of truth for Windows; merge, don't rebase)
- Working branch: `feat/macos-support`

## 1. Environment rules (non-negotiable)

**Always use nvm Node 24.1.0.** Engines is `>=24 <25`; `.nvmrc` says `24`.

```sh
export PATH="/Users/ar677005/.nvm/versions/node/v24.1.0/bin:$PATH"
node -v   # must print v24.1.0
```

Why this is strict — two distinct Homebrew-Node failure modes both hit here:

1. Homebrew Node 26.7.0 has a `node:sqlite` `backup()` hang bug: tests stall
   ~30s deterministically. Node 24.1.0 does not.
2. Homebrew Node is dynamically linked (`libnode.*.dylib`). If it ever gets
   copied into the app bundle as `lnwjud-node`, the packaged app dies with
   `dyld: libnode.147.dylib not found`. `apps/desktop/scripts/write-stdio-launcher.mjs`
   now refuses the build via an `otool -L` guard — build with nvm Node and the
   guard never fires.

Use `corepack pnpm@10.15.0` (the scripts already do). Install only with
`pnpm install --frozen-lockfile`; a `--no-frozen-lockfile` install once
produced node_modules drift that crashed the app at startup
(`Named export 'autoUpdater' not found ... CommonJS module`).

## 2. Everyday commands

Run everything from the repo root, with Node 24 active.

```sh
pnpm install --frozen-lockfile          # after checkout / upstream merge
pnpm typecheck                          # tsc --build (whole monorepo)
pnpm lint                               # eslint . — return-type rule WILL bite
pnpm test                               # all workspace unit tests
pnpm test:release                       # same, serialized (workspace-concurrency=1)
pnpm test:acceptance                    # desktop acceptance suites
pnpm test:integration                   # mcp-development-flow + codex-review-flow
pnpm test:packaging                     # packaging contract tests (read electron-builder.yml)
pnpm test:release-gate                  # release gate
```

### The gate battery (run before declaring anything done)

```sh
pnpm typecheck             # TC
pnpm lint                  # LINT
pnpm test:packaging        # PKG
pnpm test:release          # UNIT/REL
pnpm test:release-gate     # GATE
pnpm test:acceptance       # ACC
pnpm test:integration      # INT
```

All must be green on macOS. Windows-only suites are gated with
`describe.runIf(...)`, `it.runIf(process.platform === 'win32')`, or
`--platform` guards — **if a merge strips those guards, macOS runs Windows-native
suites and fails** (this happened during the upstream merge). If you see
tunnel-controller / tunnel-lock / bridge-integrity suites executing on macOS,
the `runIf(win32)` gating has been lost.

Flake note: `durable-shell` timing test was widened (autoWaitSeconds 1→8 with
completion-poll fallback). If it ever flakes, look there first before blaming
your change.

## 3. macOS packaging runbook

```sh
export PATH="/Users/ar677005/.nvm/versions/node/v24.1.0/bin:$PATH"
export CSC_IDENTITY_AUTO_DISCOVERY=false    # unsigned build; skip codesign discovery hang
pnpm package:macos                         # root script → desktop package:mac
```

`package:mac` = `prepare-ripgrep.mjs` + `prepare-tunnel-client.mjs` (pinned
downloads, SHA-verified, `lipo` universal) → monorepo `build` →
`electron-builder --mac` (dmg + zip, x64 + arm64).

Artifacts land in `apps/desktop/dist/installers/` (≈215MB dmg / 207MB zip on
arm64; x64 ≈2MB larger). First run of a user-installed unsigned DMG needs
right-click → Open.

### electron-builder download corruption workaround

electron-builder's 8-part range downloader corrupts large downloads on this
network (550MB "zip" instead of 122MB; `app-builder unpack-electron` then hangs
at 0% CPU). The fix: single-stream curl into the electron cache.

```sh
curl -L -o ~/Library/Caches/electron/electron-v43.4.1-darwin-arm64.zip \
  https://github.com/electron/electron/releases/download/v43.4.1/electron-v43.4.1-darwin-arm64.zip
# same for -darwin-x64.zip; both zips are already cached as of 2026-08-26
```

Symptom to recognize: build hangs with 0% CPU right after "unpack-electron", or
`unzip -t` fails on the cached zip. Kill the build, re-curl, rebuild.

### Boot-verify a packaged app

```sh
hdiutil attach apps/desktop/dist/installers/*arm64*.dmg
cp -R "/Volumes/lnwjud*/lnwjud.app" /tmp/ && hdiutil detach "/Volumes/lnwjud*"
/tmp/lnwjud.app/Contents/MacOS/lnwjud &   # wait for tray; check no dyld errors
# stop: pkill -f '/tmp/lnwjud.app' ; rm -rf /tmp/lnwjud.app
```

Bundle cleanliness check: `Contents/Resources` should contain only
`tunnel-client/`, `runtime-tools/`, `icon.icns` — grep for `.exe|.cmd|bridge|ocr`
must come up empty (platform-scoped packaging keeps Windows payloads out).

## 4. Cross-platform rules (hard-won)

- **pgrep exit code 1 = "no match", not an error.** Swallow exactly code 1,
  rethrow everything else. Treating it as an error produced the user-facing
  bug "Tunnel process liveness is unverifiable; refusing to start a possible
  duplicate". See `findLnwjudTunnelProcessPidsPosix()` in
  `apps/desktop/src/main/tunnel-controller.ts` + regression test in
  `apps/desktop/tests/tunnel-platform.test.ts`.
- **macOS `pgrep -l` prints only the process name, no arguments.** To match on
  args, take the PIDs from pgrep then re-read each command line with
  `ps -p <pid> -o command=`.
- **POSIX process teardown** = SIGTERM → ~1.5s grace → SIGKILL
  (`terminatePosixProcessTree`); Windows keeps the PowerShell tree-kill.
  Dispatch on `process.platform === 'win32'`.
- **Never build Windows path literals on macOS.** Tests use helpers: `W()` for
  expected strings (`value.split('\\').join(path.sep)`) and
  `process.platform === 'win32' ? path.win32.normalize(...) : path.normalize(...)`
  ternaries in fixtures.
- **Workspace cwd arrives with host-native separators** after cross-host
  sessions; `shell-backend` `resolveCwd` self-heals via `repair()`, and
  `workspace-path-guard` returns host-native `fsRelative`.
- **electron-builder.yml is platform-scoped**: top-level `extraFiles` carries
  only the shared `lnwjud-mcp-stdio.cjs`; `win:` block carries `.cmd`,
  `lnwjud-node.exe`, bridge ps1, windows-ocr; `mac:` block carries the `sh`
  launcher + `lnwjud-node`. Contract tests in `tests/packaging/` pin this —
  update both together.
- **Universal Mach-O binaries** are made with `lipo -create` (ripgrep,
  tunnel-client). Verify with `lipo -info` / `file`.
- **Never bundle a dynamically-linked Node** — the `otool -L` guard in
  `write-stdio-launcher.mjs` enforces it; don't weaken it.

## 5. Tunnel-client contract (v0.0.13, pinned)

`prepare-tunnel-client.mjs` downloads plain-asset zips
`tunnel-client-v0.0.13-{darwin-arm64,darwin-amd64,windows-amd64}.zip`,
SHA-256-pins them, and lipo-merges darwin into
`apps/desktop/build/tunnel-client/tunnel-client` (+ `cloudflared`, +
`BUNDLED_TUNNEL_CLIENT.txt`). Bump = edit version + 3 SHAs (darwin in the .mjs,
windows in `prepare-tunnel-client.ps1`).

CLI surface the controller relies on:

```
tunnel-client doctor|init|run --profile lnwjud --profile-dir <dir> --explain
tunnel-client runtimes status <alias>      # global flags only, NO --profile-dir
```

- Config file: `<profile-dir>/lnwjud.yaml`; tunnel ids look like `tunnel_<32 chars>`.
- `control_plane.api_key` uses `env:CONTROL_PLANE_API_KEY` — a `run` without
  that env var fails fast with a parse error; that is expected behavior, not a bug.
- Profile dir per OS: `%APPDATA%` / `~/Library/Application Support` / `~/.config`
  (`profileDirectory()` in tunnel-controller).
- Secret envelope: Windows = DPAPI; non-Windows = `raw:v1:` + base64 of the
  plain secret (injectable `encryptSecret`/`decryptSecret` providers).

## 6. Key files map

| Area | File |
| --- | --- |
| Tunnel lifecycle, process probes, POSIX teardown | `apps/desktop/src/main/tunnel-controller.ts` |
| Bundled binary paths, secret injection, doctor probes | `apps/desktop/src/main/desktop-services.ts` |
| macOS capability backend (JXA/shortcuts one-liners) | `packages/capabilities/src/macos-native-backend.ts` |
| Scheduler: launchd on darwin, Task Scheduler on win32 | `packages/capabilities/src/scheduler-backend.ts` |
| Capability descriptors (availability tiers incl. `desktop`) | `packages/capabilities/src/capability-descriptors.ts` |
| OS compat matrix (generation `macos` on darwin) | `apps/desktop/src/main/windows-compatibility.ts` |
| Packaging config (platform-scoped) | `apps/desktop/electron-builder.yml` |
| stdio launcher + otool guard | `apps/desktop/scripts/write-stdio-launcher.mjs` |
| ripgrep / tunnel-client pinned fetchers | `apps/desktop/scripts/prepare-ripgrep.mjs`, `prepare-tunnel-client.mjs` |
| Cross-platform tunnel tests | `apps/desktop/tests/tunnel-platform.test.ts` |
| Packaging contract tests | `tests/packaging/desktop-packaging.test.ts`, `tests/packaging/tunnel-stdio-layout.test.ts` |
| CI (authoritative Windows gate + `verify-macos` job) | `.github/workflows/ci.yml` |

## 7. macOS branch state (as of 2026-08-26)

Commit chain on `feat/macos-support` (newest first):

```
81f667f feat(mac): native capability backend, launchd scheduler, platform-scoped packaging
1a9ff46 fix(tunnel): treat pgrep no-match as 'no tunnel running' instead of unverifiable
02acb67 feat(tunnel): support OpenAI tunnel-client v0.0.13 on macOS (and Windows)
c1fd8e0 feat(mac): make macOS a first-class desktop target
3d0f525 merge: integrate upstream/main (v4.12.0) preserving native macOS support
0d3b7aa fix: harden durable shell timing test, add macOS packaging parity
```

Full gate battery green on macOS; DMG+ZIP built and boot-verified for arm64 and
x64 with clean (Windows-payload-free) bundles. Resource footprint measured at
~385MB RAM idle, ~0–1% CPU.

Known follow-ups (not done):

- Branch not yet pushed — CI (`verify-macos` + Windows lanes) has never run on it.
- DMG is unsigned (needs Apple Developer ID for signed installs + auto-update).
- Real control-plane tunnel round-trip (with a live `CONTROL_PLANE_API_KEY`)
  still untested end-to-end.
- Tray-hidden renderer keeps ~120MB (`mainWindow.hide()`); destroying it
  instead would reclaim that, at the cost of slower tray-window reopen.

## 8. Upstream sync procedure

```sh
git fetch upstream
git merge upstream/main          # on feat/macos-support; do NOT rebase (shared history)
```

Expect heavy conflicts around tunnel-controller, desktop-services,
electron-builder.yml, and every packaging test. After resolving:

1. Re-audit for stripped `runIf(win32)` guards and lost POSIX-side test cases
   (bulk "take theirs" silently deletes them — restore and re-gate).
2. `pnpm install --frozen-lockfile` (never `--no-frozen-lockfile`).
3. Re-run the full gate battery + `pnpm package:macos` before committing.
