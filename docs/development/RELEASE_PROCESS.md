# lnwjud Release Process

This document is the canonical release sequence for lnwjud maintainers and coding agents. If another planning note, old handoff, or historical checklist conflicts with this file, follow this file for release sequencing.

Canonical sequence: `dev -> PR -> main CI -> tag -> Release -> dev sync`.

The goals are simple: develop on `dev`, verify the exact code that will enter `main`, build the publishable GitHub Actions artifact once from the final `main` commit, and publish a tag only after that exact commit has a successful authoritative CI artifact.

## Release invariants

1. Normal release work happens on `dev`; do not prepare a release by editing `main` directly.
2. `package.json`, Desktop/CLI package metadata, README current version, What's new text, installer naming, update manifests, and release-facing docs must agree on the intended version before merge.
3. A release tag must point to the exact commit already present on `main`.
4. Never create or push the release tag before the successful `main` CI run for that exact commit exists.
5. The `main` CI artifact `windows-release-<commit SHA>` is the authoritative Windows build for that commit. The tag-triggered Release workflow must reuse it rather than rebuilding the application.
6. Release provenance and SHA-256 evidence are mandatory. Authenticode is enforced when both Windows signing secrets are configured; unsigned publishing remains supported when both signing secrets are absent and the workflow reports that state explicitly.
7. A failed gate is a stop condition. Fix the problem on `dev`, re-run the relevant checks, and repeat the merge/release sequence. Do not bypass a failing check by weakening tests, security settings, provenance checks, or branch protection.

## Why CI runs on both the PR and `main`

The pull-request run answers whether the proposed merge is safe to accept. The `main` run answers whether the exact commit that will be tagged is verified and produces the authoritative release artifacts. Those are different trust boundaries because GitHub may create a merge commit whose SHA differs from the `dev` head.

To avoid unnecessary duplicate work, pull-request and non-main branch CI use the release verification gate with Windows installer packaging skipped. They still run lint, typecheck, unit/package tests, acceptance, integration, Electron E2E, build, tool-catalog checks, packaging tests, and release-policy tests. Only a push to `main` runs the full gate including NSIS/Portable packaging and uploads the SHA-scoped release artifact.

The tag-triggered Release workflow is intentionally short: it downloads the successful exact-SHA artifact, verifies provenance/hashes/signing state, and publishes it.

## 1. Prepare the release on `dev`

- Fetch current remote state and make sure `dev` is based on the latest `main` required by branch protection.
- Finish the intended code and documentation changes.
- Set the release version with the repository version tooling rather than hand-editing only one package.
- Update README `Current version` and only the current release's `What's new` section. Historical change details belong in their GitHub Release pages, not as a growing README changelog.
- Update any version-sensitive release checklist/tool-count assertions when the catalog changes.
- Keep the working tree clean before the authoritative local release gate.

Recommended final local gate from repository root:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

During iteration, use smaller affected tests. Do not repeatedly run the full release gate for every small edit.

## 2. Push `dev` and validate the PR gate

Push `dev` and open or update the `dev -> main` pull request.

The required Windows check keeps the stable check name `Authoritative Release Verification (Windows)` for branch-protection compatibility. On a pull request it invokes:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\verify-release.ps1 -SkipWindowsPackaging
```

Do not merge until the required PR check succeeds and GitHub reports the branch as mergeable/up to date under the configured protection rules.

## 3. Merge to `main` and wait for authoritative CI

Merge the PR using the repository's normal protected-branch path. Record the resulting `main` merge SHA.

A push to `main` runs the full command without `-SkipWindowsPackaging`:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\verify-release.ps1
```

This run must finish successfully and upload an Actions artifact named:

```text
windows-release-<main merge SHA>
```

The artifact must contain at least:

- `lnwjud-Setup-<version>.exe`
- `lnwjud-Setup-<version>.exe.blockmap`
- `lnwjud-Portable-<version>.exe`
- `latest.yml`
- `portable.yml`
- `SHA256SUMS.txt`
- `PROVENANCE.json`

Do not tag while this run is queued, in progress, cancelled, or failed.

## 4. Create and push the version tag

After the exact `main` SHA has a successful authoritative CI artifact, verify that the intended `vX.Y.Z` tag does not already exist.

Create the tag so it resolves to that exact `main` SHA, then push it. Do not force-replace an existing public release tag.

The Release workflow checks that the tag version matches `package.json` and that a successful `ci.yml` push run exists for the exact tagged SHA.

## 5. Verify the GitHub Release

Wait for the tag-triggered `Release` workflow to complete successfully. Confirm the public GitHub Release contains the same Setup, Portable, blockmap, updater manifests, SHA256 sums, and provenance files from the exact-SHA CI artifact.

Also verify:

- the GitHub Release tag resolves to the intended `main` SHA;
- `latest.yml` points Installer users to the versioned Setup artifact;
- `portable.yml` points Portable users to the versioned Portable artifact;
- `PROVENANCE.json` records the intended version and exact source commit;
- SHA-256 verification succeeds;
- signing status matches repository configuration rather than silently changing policy.

If the Release workflow fails, do not retag a different commit with the same version. Diagnose the failure first. Source or packaging fixes require a new commit/version as appropriate rather than rewriting a published release tag.

## 6. Synchronize branches and close release work

After a successful public release, synchronize `dev` with the released `main` so the next development cycle starts from the public source state.

Then close issues fixed by the release with a concise comment naming the released version and the behavior that changed. Do not close an issue merely because a fix exists on an unpublished branch when the reporter needs a public binary.

## Failure handling

- PR CI fails: fix on `dev`, push, and let the PR gate rerun.
- `main` CI fails after merge: create the repair on `dev`, validate it, merge a new PR, and wait for a successful new exact-SHA `main` artifact. Do not tag the failed SHA.
- Release fails before publication: inspect whether the exact-SHA CI artifact, tag/version match, provenance, hashes, permissions, or signing configuration caused the failure. Preserve the existing tag unless the release was never public and changing it is explicitly safe; prefer a corrected patch release once a tag/release is public.
- Signing secrets: `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` must either both exist or both be absent. The project does not require buying a certificate merely to produce an unsigned community release.

## Related release documents

- `.github/RELEASE_CHECKLIST.md` — current-version automated/manual acceptance evidence.
- `docs/development/RELEASE_CHECKLIST.md` — compatibility pointer for older links; the operational sequence lives here.
- `docs/development/PACKAGING_WINDOWS.md` — Windows packaging and clean-machine evidence details.
- `CONTRIBUTING.md` — contributor verification and pull-request expectations.
