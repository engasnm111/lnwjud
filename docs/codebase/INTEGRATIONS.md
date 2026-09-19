# lnwjud integrations

Audit date: 2026-09-19

## OpenAI Secure MCP Tunnel

The desktop can use a bundled, target-native OpenAI tunnel client. Release packaging verifies pinned binaries and provenance rather than silently falling back to an unverified system executable.

Relevant areas:
- `apps/desktop/src/main/tunnel-controller.ts`
- tunnel runtime/profile/auth adapters under `apps/desktop/src/main`
- target-native preparation/provenance scripts
- release workflow cosign/SLSA checks

## Remote MCP / ngrok / OAuth

`apps/desktop/src/main/remote-mcp-controller.ts` provides the local protected OAuth/MCP gateway and ngrok integration. Public origins are HTTPS-only and validated; local control/gateway endpoints remain loopback HTTP.

Secrets such as ngrok/runtime credentials are stored through the injected secure-secret provider. The Desktop startup path uses Electron `safeStorage`/platform secure storage and deliberately rejects insecure Linux `basic_text` storage.

OAuth callback handling is loopback-bound where appropriate and trusted ChatGPT redirect patterns are explicitly validated.

## External MCP servers

External MCP definitions are discovered/configured through `packages/extensions`. Each child server has an independently managed session, live tool/resource discovery, schema validation, timeout/abort handling and cleanup.

Operational rule after this audit: when a child tool name is stale, refresh the live catalog with `mcp_describe` before retrying. Do not hard-code compatibility aliases for one external server unless that alias is part of an explicit versioned contract.

## Skill providers

Skills may come from:
- bundled roots,
- workspace `.agents/skills`,
- user/global skill roots,
- configured external roots,
- optional ECC skill artifacts.

The trust tier is part of the skill metadata. Automatic preflight must not auto-inject `external` trust-tier content without an explicit user selection.

## Browser and computer-use capabilities

Managed-browser/CDP access uses a loopback Chrome DevTools endpoint. Native computer-use features are platform-composed and permission/dependency gated.

The platform support contract in `docs/architecture/PLATFORM_SUPPORT.md` is authoritative for native vs dependency-gated vs unsupported behavior.

## Update and release services

Desktop update metadata is sourced from the GitHub release channel. Release assets are built and verified on target-native hosts and collected only after exact-SHA CI evidence succeeds.

Runtime dependencies are also versioned separately. During this audit, `runtime:check` reported a PDF provider update:
- current: `26.07.0-0`
- available: `26.09.0-0`

That update should use the existing hash/provenance/package-smoke path.

## PDF provider

The optional PDF provider uses a downloaded Poppler package with integrity/size verification before extraction. The current production dependency `extract-zip@2.0.1` has two high-severity advisories and no patched upstream release, so extraction implementation must be replaced or additionally isolated rather than merely version-bumped.

## Storage

Persistent application state uses SQLite through Node's `node:sqlite`. Repositories cover workspaces, audit records, checkpoints, durable goals, scheduled continuation, agent swarm and other runtime state. Backup/restore uses SQLite-aware snapshots and lifecycle locking.

## Network fetch

The generic `web_fetch` capability accepts only HTTP/HTTPS URLs and classifies mutating methods through the central mutation/permission policy. Browser/CDP control endpoints are loopback-only.

## Secrets and incident diagnostics

Desktop startup injects a secure secret protector. Legacy secret migration validates regular files, bounds file/helper output, verifies helper integrity and rewrites secrets through the current provider.

Incident reports and runtime diagnostics contain dedicated secret/token redaction. Secret-bearing environment/CLI/query/JSON shapes should continue to be covered by the central redactors rather than ad-hoc page-specific filtering.
