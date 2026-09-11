# lnwjud Release Process

This document is the canonical release sequence for lnwjud maintainers and
coding agents. If another planning note, old handoff, or historical checklist
conflicts with this file, follow this file for release sequencing.

Canonical sequence: `dev -> PR -> main CI -> tag -> Release -> dev sync`.

The release is built once on the host that owns each target. Windows, macOS,
and Linux are separate trust boundaries: a green result on one operating
system is never evidence for another.

## Release invariants

1. Normal release work happens on `dev`; do not prepare a release by editing
   `main` directly.
2. Root/package versions, Desktop metadata, README current-version text,
   updater filenames, tool counts, and release-facing docs agree before merge.
3. A release tag points to the exact commit already present on `main`.
4. Never create or push the release tag before every required target-native CI
   job for that exact `main` SHA has succeeded.
5. The authoritative CI artifacts are named
   `windows-release-<main merge SHA>`,
   `native-darwin-arm64-<main merge SHA>`,
   `native-darwin-x64-<main merge SHA>`,
   `native-linux-x64-<main merge SHA>`, and
   `native-linux-arm64-<main merge SHA>`.
6. Every target artifact contains source provenance, packaged-runtime
   evidence, and SHA-256 coverage. The tag-triggered Release workflow verifies
   those files in artifact-only mode and does not rebuild or publish a
   replacement artifact.
7. Signing is truthful. Windows Authenticode is required when both Windows
   signing secrets are configured; macOS Developer ID/notarization is required
   when the protected macOS signing configuration is enabled; unsigned
   community artifacts are explicitly reported rather than mislabelled.
8. A failed gate is a stop condition. Fix the problem on `dev`, rerun the
   relevant checks, and repeat the merge/release sequence. Do not weaken tests,
   security settings, provenance checks, or branch protection.

## Why CI runs on both the PR and `main`

The pull-request run answers whether the proposed merge is safe to accept. The
`main` run answers whether the exact commit that will be tagged is verified and
produces the release artifacts. GitHub may create a merge commit whose SHA
differs from the `dev` head, so both checks are necessary.

PR and non-main CI run the full portable/test contract while allowing the
expensive Windows installer packaging to be skipped with
`-SkipWindowsPackaging`. The native platform contract runs on Windows, macOS,
and Linux. A protected push to `main` additionally runs Windows packaging and
the target-native macOS/Linux package matrix, including macOS arm64/x64 and
Linux x64/arm64. If the protected merge is performed by an automation credential
that does not emit a downstream Actions `push` event, explicitly dispatch
`ci.yml` on `main`; that exact-main `workflow_dispatch` must run the same full
Windows and target-native package gates before tagging.

The tag-triggered Release workflow is intentionally short: it prefers the
successful `ci.yml` push run for the exact tag SHA and falls back to a successful
exact-main `workflow_dispatch` run when merge automation suppressed the push
event. It downloads all five named artifacts, verifies each target's provenance
and hashes, merges the two macOS
update manifests, and uploads the resulting release assets. It never runs
`package:windows`, `package:macos`, `package:linux`, `electron-builder`, or the
full verification gate.

## 1. Prepare the release on `dev`

- Fetch current remote state and confirm the branch is based on the latest
  development line required by branch protection.
- Finish the code, native helper, packaging, and documentation changes.
- Set the release version with the repository version tooling rather than
  hand-editing one package. Do not reuse an existing public tag; this
  cross-platform target uses a new version when the prior Windows tag already
  exists.
- Update README `Current version` and the current release's `What's new`
  section. Historical release details stay in GitHub Release notes.
- Update tool-count and target-artifact assertions when the catalog or release
  matrix changes.
- Run `git diff --check` and keep source provenance clean before the
  authoritative build.

Useful local checks on the current Windows development host are:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 build
corepack pnpm@10.15.0 package:windows
```

macOS packaging must run on macOS and Linux packaging must run on Linux:

```bash
corepack pnpm@10.15.0 package:macos
corepack pnpm@10.15.0 package:linux
```

On Linux ARM64, install native Ruby development tools and FPM 1.16.0 first,
then set `USE_SYSTEM_FPM=true` for the packaging command. The pinned
electron-builder 26 bundles an x86 Ruby/FPM binary, which cannot execute on
an ARM64 host. CI installs the native packager explicitly; x64 hosts keep
using the bundled packager.

Those target-native commands use `--publish never`, write evidence locally,
and never create a GitHub release. The Windows local gate remains:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

## 2. Push `dev` and validate the PR

Push `dev` and open or update the `dev -> main` pull request. The required
Windows check keeps the stable name `Authoritative Release Verification
(Windows)` for branch-protection compatibility. On a pull request it invokes:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\verify-release.ps1 -SkipWindowsPackaging
```

Do not merge until the required PR check succeeds and GitHub reports the
branch as mergeable/up to date under the configured protection rules.

## 3. Merge to `main` and wait for authoritative CI

Merge through the protected-branch path and record the resulting exact `main`
SHA. The authoritative CI for that exact SHA normally comes from the `main`
push. If no push-event run is created because the protected merge credential
suppresses downstream Actions, manually dispatch `ci.yml` with `main` as the
ref and verify that the run's `headSha` is still the exact SHA being prepared
for release. In either case, the run must complete all of these target boundaries:

- `Authoritative Release Verification (Windows)` completes the full Windows
  gate and uploads `windows-release-<main merge SHA>`.
- `Native Platform Contract` passes on Windows, macOS, and Linux, including
  Swift protocol tests on macOS and locked Cargo tests on Linux.
- `Native Package Verification` passes on macOS 14 arm64, macOS 13 x64,
  Ubuntu 24.04 x64, and Ubuntu 24.04 arm64, and uploads the four
  `native-<platform>-<arch>-<main merge SHA>` artifacts.

Each target artifact must contain its matching versioned package, update
metadata, `SHA256SUMS.txt`, and `PROVENANCE.json`. The expected update files
are:

| Target | Release packages | Update metadata |
| --- | --- | --- |
| Windows x64 | Setup `.exe`, Portable `.exe`, blockmap | `latest.yml`, `portable.yml` |
| macOS arm64/x64 | matching `.dmg`, `.zip` | `latest-mac.yml` in each source artifact; merged at release |
| Linux x64 | matching `.AppImage`, `.deb` | `latest-linux.yml` |
| Linux arm64 | matching `.AppImage`, `.deb` | `latest-linux-arm64.yml` |

Do not tag while any required run is queued, in progress, cancelled, or
failed. A native package that cannot be built on its target host is a blocker,
not evidence for a foreign host.

## 4. Create and push the version tag

After all exact-SHA `main` jobs succeed, verify that the intended `vX.Y.Z` tag
does not already exist. Create the tag at that exact `main` SHA and push it.
Never force-replace an existing public release tag.

The Release workflow checks the package-version/tag match, locates the
successful exact-SHA `ci.yml` push run or, when necessary, the successful
exact-main `workflow_dispatch` fallback, downloads every target artifact,
and invokes `apps/desktop/scripts/verify-release-evidence.mjs` with an explicit
installer directory for each target. `scripts/collect-release-assets.mjs`
then produces:

- target packages and updater metadata;
- `PROVENANCE-<platform>-<arch>.json` and
  `SHA256SUMS-<platform>-<arch>.txt` evidence;
- merged `latest-mac.yml` containing both macOS zip entries;
- `latest-linux.yml` and `latest-linux-arm64.yml` for the Linux updater;
- `RELEASE_MANIFEST.json` and aggregate `SHA256SUMS.txt`.

## 5. Verify the GitHub Release

Wait for the tag-triggered `Release` workflow to finish successfully. Confirm:

- the release tag resolves to the intended `main` SHA;
- all five target packages are present and match the target evidence;
- macOS `latest-mac.yml` contains both arm64 and x64 zip entries;
- Linux x64 and arm64 feeds are separate and point to their matching
  AppImages;
- Windows `latest.yml` points to Setup and `portable.yml` points to Portable;
- `RELEASE_MANIFEST.json`, per-target provenance, and aggregate SHA-256
  verification succeed;
- signing status matches the configured Windows/macOS credentials;
- clean-machine smoke is recorded separately for Windows, macOS, and Linux.

Do not claim macOS/Linux runtime acceptance from a Windows package test. The
macOS and Linux install guides define the required permission, session, secure
storage, launcher, tunnel, and updater checks.

If the Release workflow fails, do not retag a different commit with the same
version. Diagnose the exact-SHA artifact, tag/version match, provenance,
hashes, permissions, or signing configuration first. Source or packaging fixes
require a new commit/version as appropriate rather than rewriting a published
release tag.

## 6. Synchronize branches and close release work

Synchronize branches after a successful public release: synchronize `dev` with
the released `main`
so the next development cycle starts from the public source state. Then close
issues fixed by the release with a concise comment naming the version and the
behavior that changed. Do not close an issue merely because a fix exists on an
unpublished branch when the reporter needs a public binary.

## Failure handling

- PR CI fails: fix on `dev`, push, and let the PR gate rerun.
- `main` CI fails after merge: repair on `dev`, validate it, merge a new PR,
  and wait for a new successful exact-SHA artifact. Do not tag the failed SHA.
- A target-native package fails: preserve the complete host error and repair
  that platform's helper/dependency/packaging contract. Do not replace it with
  a foreign-host build or an unverified system runtime.
- Release fails before publication: preserve the existing tag if it is public;
  prefer a corrected patch version after the fix. Never force-replace a public
  release tag.
- Windows signing secrets `WINDOWS_CSC_LINK` and
  `WINDOWS_CSC_KEY_PASSWORD` must either both exist or both be absent. macOS
  signing/notarization secrets follow the same paired/protected-CI rule. The
  workflows report unsigned community artifacts explicitly when credentials
  are absent.

## Related release documents

- `.github/RELEASE_CHECKLIST.md` — current-version automated/manual evidence.
- `docs/development/PACKAGING_WINDOWS.md` — Windows packaging details.
- `docs/INSTALL_MACOS.md` and `docs/INSTALL_LINUX.md` — target install and
  clean-machine evidence.
- `docs/architecture/PLATFORM_SUPPORT.md` — platform disposition source of
  truth.
- `CONTRIBUTING.md` — contributor verification and pull-request expectations.
