# Maintaining the in-app What's New registry

The Desktop title bar has two independent controls:

1. the existing version/update button, which keeps update/check/install behavior;
2. the adjacent `?` button, which opens bundled release notes for the exact installed version.

Do not merge those responsibilities.

## Source files

- `apps/desktop/src/renderer/features/release-notes/release-notes.ts` — typed local release-note registry.
- `apps/desktop/src/renderer/features/release-notes/WhatsNewModal.tsx` — accessible modal.
- `apps/desktop/src/renderer/i18n/messages.ts` — Thai/English titles, descriptions, badges, empty-state and accessibility copy.
- `apps/desktop/tests/release-notes.test.ts` — exact-version and missing-version behavior.

## Adding a release

Before packaging a new public version:

1. Add exactly one registry entry whose `version` equals the installed semantic version.
2. Keep stable item/category IDs; put user-visible copy in i18n rather than branching on locale in components.
3. Describe only functionality that actually ships. Provider contracts that remain unavailable must not be described as ready.
4. Keep the registry local/offline. Opening What's New must not require GitHub or any network request.
5. Run the release-note tests and the normal release/version gates.

`scripts/set-version.mjs` synchronizes version surfaces but intentionally does **not** invent release notes. The release-note entry is a reviewed product artifact.

## Current v5.8.0 release-note coverage

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
