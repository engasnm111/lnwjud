# lnwjud Release Process

This document is the canonical release sequence for lnwjud maintainers and
coding agents. If another planning note, old handoff, or historical checklist
conflicts with this file, follow this file for release sequencing.

Canonical sequence: `dev -> PR -> main CI -> tag -> Release -> dev sync`.

The release is built once on the host that owns each target. Windows, macOS,
and Linux are separate trust boundaries: a green result on one operating
system is never evidence for another.

## Release invariants

1. All development happens directly on `dev`; do not create another branch for
   routine changes or prepare a release by editing `main` directly. Merge the
   checked `dev -> main` pull request through branch protection.
2. Root/package versions, Desktop metadata, README current-version text,
   updater filenames, tool counts, and release-facing docs agree before merge.
3. A release tag points to the exact commit already present on `main`.
4. Never create or push the release tag before every required target-native CI
   job for that exact `main` SHA has succeeded. As a race-condition safeguard,
   the tag-triggered Release workflow also waits up to 60 minutes for the exact
   `main` SHA CI run to finish; it still refuses publication if that CI run fails.
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
7. Signing is truthful. Windows Authenticode is required when both production
   signing secrets are configured; unsigned community releases remain supported
   when they are absent, with the same SHA-256 and source-provenance checks and
   explicit `NotSigned` evidence. Community macOS artifacts are ad-hoc signed
   with hardened runtime and a scoped Electron library-validation exception;
   Developer ID builds require one Team ID, keep Library Validation enabled,
   and require notarization/stapling when configured. Wholly unsigned macOS
   distributables are rejected.
8. A failed gate is a stop condition. Fix the problem on `dev`, rerun the
   relevant checks, and repeat the merge/release sequence. Do not weaken tests,
   security settings, provenance checks, or branch protection.
9. Every public GitHub Release body begins with human-written, version-specific
   `## Highlights` from the matching README `What's new in vX.Y.Z` section.
   The generator adds factual Feature, Bug Fix, and Other Change entries from
   linked PRs and commits, then one `**Full Changelog**` link. It omits empty
   categories instead of publishing `- None.`. A release with no README bullets
   or no substantive change evidence fails before publication.
10. Every application release also has a non-empty, exact-version entry in
    the in-app What's New registry, with Thai and English text. README and
    GitHub Release notes do not populate the in-app modal. The Desktop release
    notes test must fail when the current package version has no in-app entry.

## Post-publication documentation synchronization

After GitHub Release `vX.Y.Z` is public and verified, but **before starting the next development version**, run `node scripts/sync-published-docs.mjs vX.Y.Z --apply` on `dev` and then `node scripts/sync-published-docs.mjs vX.Y.Z` (without `--apply`) as a no-change verification. Commit and PR the documentation follow-up to `main` through normal branch protection; synchronize `dev` again afterwards. This updates the current-published headings, release download filenames, and Thai installation guide without rewriting historical v5.7.x comparisons or mutating the immutable release tag. Recheck the actual assets at `https://github.com/engasnm111/lnwjud/releases/tag/vX.Y.Z` before merging. **Publishing alone does not update README URLs**: do not claim documentation synchronization is finished until this follow-up PR is merged and the public README shows the published version.

## Release-note format

Release notes are not free-form. Before tagging, write at least one clear,
user-facing bullet under the exact-version `### What's new in vX.Y.Z` heading
in `README.md`. Describe what users can do or what problem is fixed; a version
bump, CI commit hash, or artifact list alone is insufficient. The tag workflow
generates notes with `scripts/release-notes.mjs`, checks this README section,
and validates it immediately after the tag/version check, before waiting for
or downloading release artifacts. It publishes the generated file as the
GitHub Release body.

The in-app What's New modal uses a separate, statically bundled registry in
`apps/desktop/src/renderer/features/release-notes/release-notes.ts`; it does
not read `README.md` or the GitHub Release body. For every application version,
add the exact version and at least one real category/item to that registry, and
add meaningful Thai and English title/description translations. The Desktop
`release-notes.test.ts` reads the current `apps/desktop/package.json` version
and rejects a missing or empty entry. This test is a required release gate; a
release must not be tagged or published while the modal would show its empty
state for the packaged version.

Nonempty headings appear in this order:

```markdown
## Highlights

- Human-written change from README

## Features

- ...

## Bug Fixes

- ...

## Other Changes

- ...

**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/vPREVIOUS...vCURRENT
```

`Features`, `Bug Fixes`, and `Other Changes` appear only when they contain real
entries. The generator also examines the commits between tags because a generic
release PR title can hide the actual feature or fix from GitHub's generated
notes. Empty `None.` bullets are never published.

Classification is deterministic: conventional `feat` / `feature` entries go
to **Features**; `fix`, `bugfix`, `hotfix`, and clearly fix-labelled entries go
to **Bug Fixes**; documentation, tests, chores, release engineering,
performance-only maintenance, dependency work, and anything not matching the
first two groups go to **Other Changes**. The generator keeps GitHub PR/commit
links intact, deduplicates entries, collapses duplicate historical Full
Changelog lines, and preserves release/provenance metadata under **Other
Changes**. Do not hand-replace the generated body with `## What's Changed` or a
different heading scheme after publication.

Keep the three newest release highlights in `README.md` and `FULL_README.md`.
Move older highlights to `RELEASE_NOTES.md` without dropping their detail.
When preparing a new version, add its exact-version highlights to both READMEs
and the release history, and remove the oldest README entry in that same change
so the three-version limit holds before CI. The generator uses the current
`README.md` section for a new release and `RELEASE_NOTES.md` for historical
backfill.

Historical cleanup uses `node scripts/release-notes.mjs --backfill --repository
engasnm111/lnwjud --output review.json` as a dry run first. Inspect the
before/after JSON for every affected version; versions documented in
`RELEASE_NOTES.md` or their tagged `README.md` gain their original user-facing
highlights; remaining gaps use reviewed notes in
`docs/development/HISTORICAL_RELEASE_HIGHLIGHTS.md` and linked release/commit
evidence. Only add `--apply` after
review. This operation edits Release descriptions only; it does not move tags,
rebuild artifacts, or alter published binaries.

## Why CI runs on both the PR and `main`

The pull-request run answers whether the proposed merge is safe to accept. The
`main` run answers whether the exact commit that will be tagged is verified and
produces the release artifacts. GitHub may create a merge commit whose SHA
differs from the `dev` head, so both checks are necessary. On PRs and `main`, the
complete Windows workspace suite runs alongside the remaining Windows release
gate. The required `Authoritative Release Verification (Windows)` check succeeds
only when both jobs succeed. A local `verify-release.ps1` run still executes the
whole gate without splitting it.

PR CI and explicitly dispatched verification runs the full portable/test
contract while allowing the expensive Windows installer packaging to be
skipped with `-SkipWindowsPackaging`. Direct pushes to `dev` and other
non-main branches run the native platform contract without repeating that
portable gate, so feedback arrives sooner. The separate `Dev Windows Installer`
workflow is manual-only (`workflow_dispatch`) and must never be triggered by an
ordinary `dev` push; local installer requests should use `package:windows` on
the developer machine instead. The native platform contract runs on Windows,
macOS, and Linux. Its non-desktop workspace tests run in the
normal bounded pnpm pool, while each desktop shard first builds the workspace
packages used by acceptance fixtures and then runs an isolated half of the
desktop suite per operating system so the slowest files run concurrently. A
protected push to `main` additionally runs Windows packaging and the
target-native macOS/Linux package matrix alongside the test jobs, including
macOS arm64/x64 and Linux x64/arm64. The macOS packages are built on
`macos-15` / `macos-15-intel`,
then those exact SHA-scoped DMG/ZIP artifacts are downloaded and verified on
`macos-26` / `macos-26-intel`; the macOS 26 compatibility job is a publication
gate and must not rebuild the app. macOS provenance embeds the post-seal
signature-policy snapshot (mode, architecture, Team ID, CDHashes, nested-code
inventory, root executable hash, and main/helper entitlements), and each DMG/ZIP
must match a fresh target-native inspection. If the protected merge is performed by an automation credential
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
- Set the release version by running `corepack pnpm@10.15.0 run set-version <version>` first. The script is the canonical version-sync path; do not begin by hand-editing packages or current-version docs. Inspect the resulting diff for drift, and use manual edits only for uncovered references. If an uncovered reference is part of the canonical current-version surface, extend `scripts/set-version.mjs` in the same change so future bumps stay automated. Do not reuse an existing public tag; this cross-platform target uses a new version when the prior Windows tag already exists.
- Finish and locally verify functional behavior before changing the version. Keep the mechanical version-sync diff separate from unrelated runtime changes where practical so a failure has one obvious cause.
- Run `corepack pnpm@10.15.0 test:version` immediately after `set-version`. This fast contract checks package/source alignment, development versus published documentation, local artifact names, and invalid version rejection.
- Update README release-specific copy such as `What's new` when needed. Historical release details stay in GitHub Release notes and are not rewritten by the version script.
- Update tool-count and target-artifact assertions when the catalog or release
  matrix changes.
- Run `git diff --check` and keep source provenance clean before the
  authoritative build.

Useful local checks on the current Windows development host are:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 test:version
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

The same gate with `-SkipWindowsPackaging` is mandatory before pushing a
version-changing `dev` commit. A targeted feature test is not a substitute:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1 -SkipWindowsPackaging
git diff --check
```

### CI failure classification

Do not infer the cause from a commit title containing `release`, `version`, or
an `X.Y.Z` number. Inspect the exact failed run and job first:

- failures in `test:version`, frozen-lockfile installation, versioned artifact
  names, tag/version matching, or provenance are version-management failures;
- timeouts, process teardown, child MCP lifecycle, OS-specific spawning, and
  E2E state failures are runtime/test failures exposed by the broad release
  matrix, not version failures;
- a rerun that passes for the same SHA proves nondeterminism. It does not fix
  the race. Replace wall-clock polling with deterministic synchronization or
  fake time where appropriate, and leave a regression test at the real seam;
- never weaken a gate or only increase a timeout to make a release green.

After a corrective push, monitor the CI run for that exact commit SHA through
completion. Do not reuse a successful run from another SHA and do not claim
the Action is fixed while the replacement run is queued or in progress.

## 2. Push `dev` and validate the PR

Push `dev` and open or update the `dev -> main` pull request. The required
Windows check keeps the stable name `Authoritative Release Verification
(Windows)` for branch-protection compatibility. On a pull request, one Windows
job runs `test:release` while another invokes:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\verify-release.ps1 -SkipWindowsPackaging -SkipWorkspaceTests
```

The required check depends on both jobs; `-SkipWorkspaceTests` is used only
when the separate workspace test job runs on the same commit. Do not merge
until the required PR check succeeds and GitHub reports the
branch as mergeable/up to date under the configured protection rules.

## 3. Merge to `main` and wait for authoritative CI

Merge through the protected-branch path and record the resulting exact `main`
SHA. The authoritative CI for that exact SHA normally comes from the `main`
push. If no push-event run is created because the protected merge credential
suppresses downstream Actions, manually dispatch `ci.yml` with `main` as the
ref and verify that the run's `headSha` is still the exact SHA being prepared
for release. In either case, the run must complete all of these target boundaries:

- The full Windows workspace suite and the remaining Windows release gate both
  succeed. The build job uploads `windows-release-<main merge SHA>` and their
  aggregate `Authoritative Release Verification (Windows)` check passes.
- `Native Platform Contract` passes on Windows, macOS, and Linux, including
  Swift protocol tests on macOS and locked Cargo tests on Linux.
- `Native Package Verification` builds on macOS 15 arm64, macOS 15 Intel x64,
  Ubuntu 24.04 x64, and Ubuntu 24.04 arm64, then the exact macOS artifacts
  must also pass the macOS 26 arm64/x64 compatibility gate before release;
  the package jobs upload the four `native-<platform>-<arch>-<main merge SHA>` artifacts.

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
  `WINDOWS_CSC_KEY_PASSWORD` must either both exist or both be absent. When both
  are configured, release evidence must record `Valid` Authenticode for Setup
  and Portable. When both are absent, community publication may remain unsigned
  only after the same SHA-256/provenance verification and explicit signing-state
  evidence. macOS signing/notarization secrets follow their existing paired/protected-CI rule.

## Related release documents

- `.github/RELEASE_CHECKLIST.md` — current-version automated/manual evidence.
- `docs/development/PACKAGING_WINDOWS.md` — Windows packaging details.
- `docs/INSTALL_MACOS.md` and `docs/INSTALL_LINUX.md` — target install and
  clean-machine evidence.
- `docs/architecture/PLATFORM_SUPPORT.md` — platform disposition source of
  truth.
- `CONTRIBUTING.md` — contributor verification and pull-request expectations.
