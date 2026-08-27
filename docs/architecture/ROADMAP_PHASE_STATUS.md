# v4.0.0 Roadmap Phase Status

This is the implementation checklist for the upgrade roadmap. All phase
surfaces are additive to the primitive MCP contract. Optional external
integrations report their availability; they do not pretend a plugin, tunnel,
Codex installation, or browser session exists when it is not connected.

| Phase | Status | Evidence in the runtime |
| ---: | --- | --- |
| 00 | complete | Architecture/tool contract and repeatable benchmark baseline |
| 01 | complete | `tool_batch`, dependency waves, timeout/cancel/partial results and child audit |
| 02 | complete | `workspace_context`, exhaustive scan, multi-workspace search/read |
| 03 | complete | Deterministic file paging and one-use continuation tokens |
| 04 | complete | Persistent index with automatic vendor/build/binary/generated filters, explicit override, changed-path watcher, debounce/concurrency queue |
| 05 | complete | Index-backed symbol/definition/reference/import/dependency tools |
| 06 | complete | Ranking signals optimize order; continuation preserves lower-ranked context |
| 07 | complete | Compound context tools execute search/Git context in one structured response |
| 08 | complete | Deterministic prompt router with explicit route metadata |
| 09 | complete | Inspectable YAML recipes plus recipe catalog/run contract |
| 10 | complete | Side-effect-free dry-run plan with permissions and mutation lists |
| 11 | complete | Git/change/symbol/module/history context contracts |
| 12 | complete | Test discovery/affected-test/history/coverage contracts; full runs remain available |
| 13 | complete | Runtime cache with content identity and hit/miss telemetry |
| 14 | complete | Lifecycle hook registry with before/after events and deny/modify results |
| 15 | complete | On-demand skill match/load surface over the existing local skill bridge |
| 16 | complete | `LnwjudPlugin` SDK contract and plugin lifecycle tools |
| 17 | complete | Redacted persisted session checkpoints, tasks, delegates, and handoff state |
| 18 | complete | Compact/normal/verbose/stream response-mode contract |
| 19 | complete | Browser/UI debug facade over existing CDP/vision/window capabilities |
| 20 | complete | Windows environment/service/process/port/runtime context facades |
| 21 | complete | MCP bridge discovery/health/resources with native tools kept visible |
| 22 | complete | Visible managed task lifecycle (`create/status/cancel/result/list`) |
| 23 | complete | Delegation lifecycle boundary; native Codex adapter remains policy/audit controlled |
| 24 | complete | Read-only parallel delegation default and serialized mutation metadata |
| 25 | complete | Permission v2 classes; dangerous actions are gated without limiting allowed reads |
| 26 | complete | Correlated ActivityTracker, NDJSON audit, and tunnel/MCP/process Live Logs pipeline |
| 27 | complete | Telemetry dashboard response contract for latency/cache/context/error metrics |
| 28 | complete | Deterministic execution planner based on route and available cache/index state |
| 29 | complete | Traversable repository map from the persistent index |
| 30 | complete | Optional dependency/import/test/change context expansion |
| 31 | complete | Stale continuation detection, rebuildable index, safe retry boundary, bounded tunnel reconnect |
| 32 | complete | Versioned `ToolSchemaRegistry` with risk/stream/parallel/plugin metadata |
| 33 | complete | Capability categories, on-demand tool search/describe, and stable aliases |
| 34 | complete | Zero-LLM tool function finder using names/descriptions/tags |
| 35 | complete | Unified `dev_context` route/operation/continuation facade |
| 36 | complete | Bugfix/review/frontend/release inspectable automation recipes |
| 37 | complete | Screenshot/DOM/layout plus modular Excel/PDF visual adapter contracts |
| 38 | complete | Project intelligence profile get/set contract that augments, not restricts, access |
| 39 | complete | Structured cross-agent handoff bundle |
| 40 | complete | Unit/integration/E2E/package/release gates and compatibility benchmarks |
| 41 | complete | Context Economy policy, Context Ledger, duplicate/diff delivery, explicit-access override, and quota telemetry |

## God-Tier Windows AI Gateway waves

These additive waves are tracked separately from the historical Phase 00–41
catalog. “Contract-ready” means the tool has a schema/permission/audit boundary
and reports a truthful optional or planned state when its OS/runtime dependency
is absent; it does not claim that dependency is installed.

| Wave | Status | Evidence |
| ---: | --- | --- |
| 0 | complete | Capability descriptors, health metadata, bounded trace propagation into NDJSON/SQLite audit, and 184-tool compatibility baseline |
| 1 | complete | `wsl_exec` argv-only scoped runner, workspace-owned task handles, cancellation/timeout delegation, and `wsl_fs` translation/metadata boundary |
| 2 | complete | `vision_annotated_capture`, expiring observation hash, screen-origin normalization, annotated PNG, Accessibility revalidation, and gated `ui_target_action` |
| 3 | complete | `vision.ocr` remains public; WinRT helper ships with build/register scripts (`scripts/build-windows-ocr.ps1`, `scripts/register-windows-ocr.ps1` for self-signed dev or release certs), a real cached host-side identity probe (`createOcrPackageIdentityProbe`), and packaged `windows-ocr` extra resources; live registration runs on machines with .NET SDK + Windows SDK |
| 4 | complete | Deterministic semantic scorer, primitive-visible ranked candidates, reason codes, permission metadata, `tool_dynamic_filter`, and local-rerank fallback |
| 5 | complete | `event_watch`/`crash_trace` serve bounded `Get-WinEvent` queries through the allowlisted `EventLogCapabilityBackend`; `sandbox_exec` stages the artifact-only WSB plan, launches `WindowsSandbox.exe`, and retrieves stdout/stderr/exit-code with dry-run default and confirmation gating |
| 6 | complete | Read-only SQLite `db_inspect`/`db_query` through `node:sqlite` (workspace-confined targets, single SELECT/PRAGMA, bounded rows); minimal stdio LSP client for `lsp_diagnostics`/`lsp_rename` configured via `LNWJUD_LSP_<LANGUAGE>_COMMAND`; persisted Git worktree ownership ledger with `git_worktree_remove` (dry-run + confirmation). DAP (`debug_attach`/`debug_step`) intentionally remains contract-only |
| 7 | complete | PowerPoint `read`/`save_as` and read-only Outlook folder/message headers (no bodies) behind the Office COM boundary with array-aware path guards; `pdf_extract_tables`/`inspect_pdf` through an optional local PDF provider (pdftotext-style, `LNWJUD_PDF_PROVIDER`); `docx_merge` via Word COM with dry-run/confirmation; `inspect_workbook` via Excel COM `sheets`+bounded sample; `compare_workbook_layout`/`render_excel_preview`/`compare_pdf_pages` now report truthful optional availability instead of metadata-only "ready" |
| 8 | complete | `self_heal_plan` gathers live evidence (index status, durable task list) and proposes allowlisted reversible fixes mapped to existing tools; `self_heal_apply` executes only those fix kinds behind dry-run + explicit `userConfirmed` with no automatic destructive retry. `agent_swarm_run` intentionally remains planned: the only local subagent provider is Codex, which the chat-quota-only policy keeps off-limits |

## Phase 04 visibility and economy rule

Automatic discovery/indexing skips vendor, build/cache, binary, and generated
content to reduce I/O and context pressure. This is not an access denial:
`.env`, `.git`, `dist`, and `node_modules` remain available through explicit
file reads, explicit search/index overrides, and full scans under the existing
workspace/path ownership boundary. Debounce, event coalescing, and worker
concurrency control processing pressure. A duplicate event may be coalesced;
a distinct permitted explicit request may not be dropped. Activity/audit
summaries and the bounded Context Ledger never persist file contents or
credentials.

## Codex connection rule

Connection paths are deliberately separated:

```text
Codex CLI / local MCP host -> packaged lnwjud-mcp-stdio.cmd -> direct Node MCP stdio
ChatGPT web / Secure Tunnel -> tunnel-client -> lnwjud Desktop loopback HTTP MCP
```

Secure Tunnel uses the Desktop runtime so the host-selected Active Project and
native exact-action approval remain authoritative. Direct local stdio remains a
separate headless path and intentionally fails closed when a mutation requires a
trusted interactive host approval provider.

## Multi-workspace / multi-session concurrency upgrade

The concurrency upgrade is tracked in
[`MULTI_WORKSPACE_CONCURRENCY.md`](./MULTI_WORKSPACE_CONCURRENCY.md). It keeps
settings global while separating request workspace scope, session-owned handles,
activity, and logs.

| Phase | Status | Evidence / target |
| ---: | --- | --- |
| M0 | complete | Baseline audit, invariants, blockers, file-level implementation plan |
| M1 | complete | Desktop MCP lifecycle is independent from selected workspace; A/B selection no longer restarts the listener |
| M2 | complete | Destructive/project scope resolves from each call's registered `workspaceId`; missing/unresolved scope fails closed |
| M3 | complete | Stable HTTP/STDIO session identity; Process/Codex/Shell/WSL/Tasks ownership is isolated by client + session + workspace, with explicit stateless-HTTP fallback |
| M4 | complete | Multi-owner STDIO activity v2 + aggregate updater safety; session-namespaced atomic runtime state with locked shared plugin/worktree ledger |
| M5 | complete | Session-aware audit persistence/query, scoped IPC/process metadata, and Live Log propagation/dedup isolation |
| M6 | complete | Workspace/session filters/badges plus session/workspace/all clear cursors and filtered Live Log export |
| M7 | complete | Real two-session/two-workspace Desktop MCP acceptance plus isolation/updater/release gates; repository-wide Full Verification passed, including full tests, acceptance, integration, E2E, build, packaging, Windows installer, diff-check, and public-repo hygiene |
