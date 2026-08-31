# Contributing to lnwjud

Thanks for helping improve lnwjud. The project is a Windows-first local AI-agent runtime and MCP gateway, so changes should preserve local-first behavior, explicit trust boundaries, and deterministic release verification.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a large feature or architectural change, open an issue first and describe the intended behavior and compatibility impact.
- Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
- Never commit credentials, private keys, local databases, user logs, machine-specific secrets, or private project data.

## Development environment

The repository is developed and release-tested on Windows x64.

Required for source development:

- Node.js 24.x
- Git
- Corepack
- pnpm 10.15.0 (pinned by the repository)

Install dependencies from the repository root:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
```

Do not silently upgrade the package manager or rewrite the lockfile for an unrelated change.

## Making changes

- Keep each pull request focused on one coherent change.
- Preserve workspace/path/security boundaries; do not bypass permission checks to make a test pass.
- Avoid hard-coded developer paths, usernames, tokens, ports, or machine-specific assumptions.
- Add or update tests for behavior changes and regressions.
- Keep tool catalog, version metadata, README, and release documentation synchronized when your change affects them.
- Do not bump versions or create release tags unless the change is explicitly a release-preparation change.

## Verification

Run the smallest relevant tests while developing. Before requesting review for a substantial change, run the checks that cover the affected packages.

Common commands:

```powershell
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:e2e
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 docs:tools:check
git diff --check
```

The authoritative release gate is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

Release verification is intentionally heavier than normal development checks; do not repeatedly run it while iterating on a small change. Pull-request/non-main CI uses the same gate with `-SkipWindowsPackaging` to avoid rebuilding NSIS/Portable artifacts that cannot be published from a PR.

For an actual release, follow the canonical [release process](docs/development/RELEASE_PROCESS.md). In particular, prepare on `dev`, wait for the required PR check, merge through branch protection, wait for the full exact-SHA `main` CI artifact, and only then create the `vX.Y.Z` tag. Never tag first and hope CI catches up later.

## Pull requests

A good pull request should include:

- What changed and why.
- User-visible behavior or compatibility impact.
- Security/trust-boundary implications, if any.
- Tests run and their results.
- Screenshots for meaningful desktop UI changes.
- Migration or rollback notes when storage/schema behavior changes.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
