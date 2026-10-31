# Maintaining the in-app What's New registry

## v5.9.1 development candidate (not released)

The offline What's New registry includes a `5.9.1` entry with Thai and English descriptions of the single top-left titlebar update action (the duplicate Settings → General update test button has been removed), explicitly confirmed proven-idle same-client writer-lease recovery (ordinary acquisitions cannot reclaim active leases), and MCP refusal diagnostics. The current local Windows Setup and Portable packages are **unsigned test builds**, not production auto-update acceptance.

Activity logs distinguish actual MCP-level `CONFLICT` (expired or missing Goal lease, writer-lease owner not idle), `EXECUTABLE_NOT_FOUND` (e.g. `pwsh` on Windows), and successful tool execution. **Host Safety refusals before dispatch are not necessarily recorded by lnwjud**, and therefore cannot be attributed to `shell` from the server-side audit alone. `shell` preserves restart-safe durable tasks; `process_start` owns an immediate managed process. Keep both until evidence justifies a backward-compatible change, not a safety bypass.

The native updater is not yet proven to install signed packages unattended, relaunch the app, restore the Tunnel, or roll back app/data successfully. Keep release gates closed until installed exact-SHA acceptance proves those outcomes.

**31 October 2026 native safety validation:** A failed or unverified search-subprocess termination now returns a non-recoverable error rather than a successful partial result. Targeted regressions pass; three Windows side-effect-marker process-termination integrations failed under load in earlier runs but passed in a later 34/34 run, so the intermittent issue remains open, so this is a fail-closed reporting improvement, not proof of process containment. For macOS, the process-group stop path now retries a transient malformed process-table observation or a live group lacking the newly spawned root's start identity before attempting any identity-verified signal; repeated missing identity still fails closed. macOS Issue #223 and the native updater release gates remain open until exact-source native CI and signed installed E2E pass; do not advertise zero-click availability.

---

The Desktop title bar has two independent controls:

1. the existing version/update button, which displays the version and update status. Automatic updates are unavailable in the current v5.9.0 source candidate until native transaction authority and signed acceptance are complete;
2. the adjacent `?` button, which opens bundled release notes for the current release series, newest installed-or-earlier version first.

Do not merge those responsibilities.

## Source files

- `apps/desktop/src/renderer/features/release-notes/release-notes.ts` — typed local release-note registry.
- `apps/desktop/src/renderer/features/release-notes/WhatsNewModal.tsx` — accessible modal.
- `apps/desktop/src/renderer/i18n/messages.ts` — Thai/English titles, descriptions, badges, empty-state and accessibility copy.
- `apps/desktop/tests/release-notes.test.ts` and `apps/desktop/tests/release-notes-series.test.ts` — exact-version registry, series ordering, future-version filtering and modal rendering.

## Adding a release

Before packaging a new public version:

1. Add exactly one registry entry whose `version` equals the installed semantic version. The modal displays all entries for the installed series with descending semantic-version order (5.8.x, then 5.9.x after upgrading; v6+ groups by major as 6.x.x). Never show notes for future or other series.
2. Keep stable item/category IDs; put user-visible copy in i18n rather than branching on locale in components.
3. Describe only functionality that actually ships. Provider contracts that remain unavailable must not be described as ready.
4. Keep the registry local/offline. Opening What's New must not require GitHub or any network request.
5. Run the release-note tests and the normal release/version gates.

`scripts/set-version.mjs` synchronizes version surfaces but intentionally does **not** invent release notes. The release-note entry is a reviewed product artifact.

## Current source v5.9.0 candidate release-note coverage

The offline `5.9.0` registry entry provides localized Thai and English notes for the current candidate:

- Issue #213: Windows process-lifetime and writer-reservation evidence, plus authenticated named-pipe RPC recovery proven in a local disposable fixture; installed SCM pipe and interactive-session acceptance remain open;
- Issue #214: Engineering Gate applicability that preserves required evidence and reports unavailable or stale proof instead of treating it as passed;
- Issues #215 and #216: WSL UNC path handling; in-process synchronous mutation reservations are reclaimed only after the recorded owner process is proven gone, with privacy-preserving hashed blocker diagnostics; unknown process reservations remain held and macOS process writers stay refused while escaped-descendant containment remains incomplete;
- Issue #219: the bounded file-publication contract and its durability limits;
- Goal ownership: terminal writer refusals close their Goal heartbeat, and writer lease renewal and release receive the exact proof without exposing credentials in activity or audit records;
- updater status: automatic updates remain unavailable until the native authority, enrolled package trust, independent health, and application/data rollback pass signed acceptance;
- Tunnel Stop and Factory Reset recovery for a stale Windows alias, without deleting remote Tunnel state; Start stays disabled while that persistent alias may still be active, preventing a duplicate runtime;
- WSL/tooling intent, unresolved Dashboard startup, large Tunnel history, and pinned Ponytail v5.3.2 document-only skills.

These notes describe the source candidate and its current limitations. They are **not** evidence that security verification, protected merge, exact-main-SHA CI, official packages, or publication has passed. The updater item explicitly describes an unavailable capability. The latest public release remains v5.8.7 until the release gates complete.

## Historical v5.8.7 candidate release-note coverage

The `5.8.7` registry entry recorded the candidate behavior for Issues #208 and #209, safe Git import, writer leases, MCP connector identity, Scheduled Task/Goal status, and local Tunnel alias reconciliation. Keep these notes as history; do not treat them as v5.9.0 acceptance.

## Historical v5.8.5 release-note coverage

The `5.8.5` entry provides localized Thai and English notes for:

- Engineering Harness routing that keeps read-only audits and historical deployment or release topics in the local review workflow while retaining explicit delivery actions;
- safe resume of an existing Engineering Goal after metadata or required-platform contracts change, preserving compatible findings, task tracking and evidence;
- modern MCP HTTP notifications when host tool availability changes, followed by a fresh `tools/list` response.

The direct local SDK `tools/list` contract includes the optional checkpoint engineering fields. `tool_describe` reports a canonical SHA-256 digest from the active ToolRegistry schema and marks the remote connector schema unavailable. Issue #198 reports a Cloudflare connector schema discrepancy. The connector-side transformation and refresh behavior remain external acceptance and must not be described as fixed until verified in that connector.

## Historical v5.8.0 release-note coverage

The exact `5.8.0` in-app registry provides localized Thai and English entries for:

- Six review-first Workflows with required input validation and explicit AI handoff (without automatic Goal creation or scheduling);
- Git changed-file browsing, Prompt typography, shared dropdowns and Doctor/Tools/Work Log improvements;
- CSV/XLSX file auditing and template report support subject to native provider availability;
- Goal-aware MCP call diagnostics, resources, result coverage and honest unavailable measurements.

For each item, verify the corresponding code and target-native runtime before publication. Registry text alone does not prove the full flow.

## Historical v5.7.2 release-note coverage

The bundled `5.7.2` entry covers the behavior shipped in the current published release:

- Engineering Harness settings persist across Desktop restarts, including saved workspace overrides and diagnostics;
- Engineering Harness tools are discoverable through the tool catalog and bind to the active Durable Goal/lease correctly;
- ProseMirror/contenteditable typing uses native `Input.insertText` and verifies the DOM changed before reporting success;
- Git image changes can render bounded before/after previews at the real `HEAD → Index` and `Index → Working Tree` scopes;
- Durable Goal progress is refreshed at meaningful milestones and during sustained work so Watcher does not present stale active work;
- transient Windows PowerShell inventory failures are retried before Secure MCP Tunnel is marked Error, while unverifiable process identity remains fail-closed.

## Historical v5.6.4 release-note coverage

The bundled `5.6.4` entry covers behavior verified in the Windows installer:

- an existing Secure Tunnel ID follows the current local MCP port after restart, and Windows retires only a duplicate client verified to belong to the same lnwjud Tunnel;
- ChatGPT accepts the no-auth MCP tool schema, and the guide separates the Tunnel Runtime API key from ChatGPT OAuth fields;
- Tunnel Start/Stop controls remain disabled during startup;
- Live Logs retain each event's original timestamp;
- the Git changed-files list fills available window space while long lists and diffs remain scrollable.

The CI scheduling change is documented in the release process and README files; it does not need an in-app user-facing card.

## Historical v5.6.3 release-note coverage

The bundled `5.6.3` entry must describe only behavior that actually ships in this patch:

- Secure Tunnel protected-resource discovery uses the empty-404 no-auth contract required by the bundled OpenAI `tunnel-client` profile instead of returning a `text/plain Not found` body that is parsed as malformed JSON;
- the bundled target-native OpenAI `tunnel-client` is v0.0.15 and remains pinned by SHA-256 plus Sigstore provenance;
- Windows Codex discovery falls back to the official `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin` installation when the Desktop process PATH is stale;
- Recovery retention also expires database backups moved into `retention-archive`, using the same configured lifetime (30 days by default);
- Recovery Settings exposes independently confirmed delete-all actions for Recovery Trash, checkpoints, and database backups, while backend deletion stays limited to validated recovery records/artifacts and never recursively wipes unrelated files.

Historical registry entries remain bundled for exact-version display on older installations.

Keep README/FULL_README release notes and Thai/English in-app copy semantically aligned with this registry. Do not add claims for fixes that are not in the packaged artifact.

## Accessibility contract

The `?` trigger must remain a real focusable button. The modal must:

- use `role="dialog"` and `aria-modal="true"`;
- move focus into the dialog when opened;
- trap Tab/Shift+Tab inside the dialog;
- close on Escape;
- restore focus to the previous trigger on close;
- keep long release notes scrollable;
- show a localized graceful empty state when the exact installed version has no registry entry.

## Localization

Use the existing translator and message keys. Do not introduce `isTh`, `locale === 'th'`, or component-local Thai/English branches for release-note content.

The required tooltip is:

- Thai: `ดูกันว่ามีอะไรอัพเดตใหม่`
- English: `See what’s new`
