# lnwjud v4.55.0 — Comprehensive Hardening Wayfinder Plan

Date: 2026-09-07
Branch: `dev`
Baseline: `v4.54.0`
Target: `v4.55.0`
Status: **IMPLEMENTED THROUGH DOCS/VERSION — authoritative verification, dev push, installers, dev Actions, and terminal cleanup pending**
Method: Wayfinder + durable goal + one Native ChatGPT recurring cloud watchdog

## Destination

Ship one cohesive `v4.55.0` development build that improves the whole lnwjud product, not only the MCP tool catalog. The destination is a safer, more deterministic, more observable and more interoperable runtime whose tool contracts are strict, long-running work follows modern MCP lifecycle semantics where supported, stale durable state can reconcile itself, batch work isolates failures, metrics tell the truth, external MCP boundaries are explicit, Desktop UX explains readiness correctly, and platform differences are modeled rather than hidden.

The version is complete only when:

1. Every phase below is implemented in `dev` with regression coverage.
2. Version-bearing source/docs/packages are consistently `4.55.0`.
3. Local authoritative verification is green.
4. Fresh Windows Setup and Portable artifacts exist under `apps/desktop/dist/installers` and evidence/hashes are verified.
5. Intended changes are committed and pushed to `origin/dev` only.
6. All relevant GitHub Actions triggered by the final `dev` SHA are terminal and green (intentional conditional skips are acceptable; failures/cancellations are not).
7. The Native ChatGPT recurring watchdog is made non-runnable and its cleanup is truthfully reconciled before the durable goal is finalized.

No PR, merge to `main`, tag, public release, or publish action belongs to this goal.

## Current terrain / evidence from v4.54.0

- Tracked `dev` baseline is clean. Preserve unrelated pre-existing untracked paths exactly as-is:
  - `.worktrees/v453-authoritative-build/`
  - `NATIVE_SCHEDULED_TASK_HARDENING_WAYFINDER_PLAN.md`
  - `V4_53_RECURRING_NATIVE_WATCHDOG_WAYFINDER_PLAN.md`
- Root, Desktop and MCP package surfaces are at `4.54.0`.
- Tool registry contains more than two hundred definitions; the upgrade catalog is deliberately broad.
- Upgrade tools currently share `z.object({}).passthrough()`, so unsupported fields may be silently accepted.
- `McpToolAnnotations` currently models only `readOnlyHint` and `destructiveHint`.
- MCP registration currently does not advertise tool `outputSchema`.
- `tool_describe` exposes a generic `additionalProperties: true` shape for upgrade tools rather than their effective contract.
- Modern MCP traffic correctly avoids the removed legacy core Tasks capability, but there is no complete `io.modelcontextprotocol/tasks` extension adapter for lnwjud long-running work yet.
- Durable state contains historical goals that can remain `active` after later release work supersedes them; recovery can report stale continuation state.
- Batch/parallel orchestration needs stronger per-item fault isolation so one transport/tool failure cannot collapse unrelated successful calls.
- Context-economy calls can save substantial bytes while the telemetry dashboard still reports zero cache/context totals, proving aggregation is not yet unified.
- Trace correlation understands `traceId`/`traceparent` but not the complete W3C context envelope.
- Local reranker requests currently fall back deterministically; the capability must either become real or report itself as unavailable without pretending it ran locally.
- `scheduler` is a local Windows Task Scheduler capability and is distinct from host-owned Native ChatGPT Scheduled Tasks; UX/docs must make that boundary impossible to confuse.
- macOS/Linux work has prior evidence outside this branch, but `dev` must expose truthful platform boundaries instead of claiming Windows-only backends are portable.

## Architectural decisions

### A. Contract-first tool model

Create one authoritative tool-contract model used by runtime registration, catalog/Doctor UI, `tool_describe`, schema listing, tests and generated docs.

Contract metadata must cover, where meaningful:

- strict input schema / known extension points;
- structured output schema;
- read-only, destructive, idempotent and open-world annotations;
- risk/permission class;
- cancellation support;
- dry-run support;
- parallel safety;
- expected execution style (`immediate`, `background-task`, `external`);
- provider/platform requirements;
- provenance/version metadata.

Do not hand-maintain several contradictory copies of the same contract. Generate or project downstream views from the authoritative registry.

For upgrade tools, replace the single all-purpose passthrough schema with explicit per-tool or schema-family definitions keyed by tool name. Unknown fields must reject unless that specific tool intentionally defines a forward-compatible metadata/options object.

### B. Structured outputs are protocol contracts

Advertise real `outputSchema` on MCP tool registration when the SDK supports it. Validate or normalize structured results at the lnwjud boundary, including external MCP results where an upstream schema exists. `tool_describe` and `tool_schema_list` must return the effective real schemas, not placeholder objects.

### C. Durable lifecycle reconciler

Add deterministic reconciliation for stale/superseded goals and continuation state. It must never fabricate completion, but it may classify provably abandoned historical work using durable evidence.

Required invariants:

- a terminal goal cannot have a live mutation lease;
- a terminal goal cannot retain an actionable continuation requiring ordinary work;
- a superseded/abandoned goal is distinguishable from completed/cancelled work;
- no cleanup operation can silently change a goal that has trustworthy live-worker evidence;
- cleanup is idempotent and auditable;
- old release/dev-audit goals cannot remain permanently `active` merely because an earlier worker disappeared.

Prefer explicit `superseded`/reconciliation evidence if the domain can evolve safely; otherwise retain compatible terminal states plus a typed reconciliation reason.

### D. Modern MCP Tasks integration

Implement the modern Tasks extension adapter supported by the installed MCP SDK/protocol surface without re-advertising the removed modern core `tasks` capability.

Map eligible long-running lnwjud work—shell/process/project commands/delegates/benchmarks where practical—to a stable task abstraction. Preserve existing lnwjud task tools for compatibility while making lifecycle/cancellation/result semantics converge on one internal model.

Legacy 2025-era core Tasks compatibility remains isolated to negotiated legacy sessions only.

### E. Batch, delegate and cancellation correctness

Batch and parallel execution must produce per-item outcomes. One failed item must not erase successful siblings unless the caller explicitly selects fail-fast semantics.

Requirements:

- bounded concurrency;
- per-item timeout/cancellation;
- root cancellation propagation;
- deterministic result ordering;
- partial-success envelope;
- error codes preserved per item;
- no orphan child tasks after parent cancellation;
- fault-injection coverage for exceptions, timeouts, transport loss and mixed successes.

### F. Cache and context economy share one truth

Unify cache/context-economy accounting across request-scoped engines and Desktop/runtime telemetry.

Add deterministic invalidation keys for tool exposure/catalog generation and workspace-index freshness. Where protocol/SDK support exists, expose appropriate cache hints for stable discovery/resource surfaces. A dashboard zero must mean zero actual usage, not “metrics were collected somewhere else.”

### G. End-to-end observability

Carry W3C trace context through HTTP/stdio request scope, registry dispatch, delegated work and child/external MCP boundaries where permitted:

- `traceparent`;
- `tracestate`;
- `baggage` with bounded/redacted handling.

Add OpenTelemetry-compatible span/event semantics without requiring a remote exporter to operate. Telemetry must provide at least:

- per-tool calls/success/errors/cancellations;
- p50/p95/max latency by tool/category;
- active/in-flight count;
- cache/context-economy totals;
- batch partial failures;
- task lifecycle counts;
- bounded recent error classes.

Keep credential/path redaction and payload-size limits.

### H. External MCP / plugin trust layer

Every external MCP tool must expose server provenance and a collision-safe namespace. Track descriptor/schema fingerprints and surface meaningful drift.

Required boundaries:

- distinguish trusted local/core from external/unverified tools;
- `openWorldHint` for operations crossing external/network trust boundaries;
- validate external structured output against declared schema when available;
- preserve upstream tool/server identity in audit records;
- require the existing approval policy for unknown/destructive external calls;
- do not let an external server shadow a first-party tool silently;
- health/readiness must tell the truth when the configured server cannot be reached or has changed contract.

### I. Router and index improvements

Tool routing should combine lexical intent with effective exposure/readiness, permission/risk, schema fit and recent reliability/latency signals. Ranking never grants authorization.

Workspace indexing must report freshness/generation/staleness explicitly and avoid expensive full rescans when incremental state is valid.

Local reranking must be one of:

1. a configured functioning local provider, or
2. an explicit `needs_setup/unavailable` capability with deterministic fallback stated separately.

Never label deterministic fallback as a local-model result.

### J. Tool-family hardening across the whole product

Audit and improve all major families, not just catalog infrastructure:

- workspace/files/search/git/process/task;
- goal/scheduled continuation/session/delegate/swarm;
- browser/CDP/network/console;
- accessibility/input/window/vision/computer-use;
- LSP/symbol/graph/debug/test/coverage;
- PDF/Excel/Word/PowerPoint/Outlook/media;
- database/sandbox/self-heal/hooks/recipes/plugins;
- Windows/WSL/services/registry/events/scheduler/runtime diagnostics.

For each family ensure readiness, platform/provider requirements, cancellation/dry-run claims, schemas, audit targets and failure messages match actual runtime behavior.

### K. Desktop UX / Doctor / onboarding

Tools, Doctor and Settings must consume the same effective contract/readiness model as MCP exposure.

Improve:

- exact reasons a tool is disabled/needs setup/unsupported;
- remediation that opens the correct setting or official setup target;
- stale contract/provider warnings;
- task/goal recovery visibility;
- telemetry summary with per-tool latency/errors instead of one misleading global average;
- scheduler naming: present local `scheduler` as **Windows Task Scheduler (local)** and Native ChatGPT continuation as **ChatGPT Scheduled Task (cloud/host-owned)**;
- no misleading enable switch when system/provider gates are unmet;
- keep refresh work single-flight and avoid raising idle polling pressure.

### L. Cross-platform provider architecture

Do not merge historical feature branches blindly. Introduce or strengthen a provider/capability boundary in `dev` so common tools are platform-neutral and native implementations are selected by runtime capability.

Target model:

`core contract -> provider interface -> windows | macOS | linux implementation/status`

A missing implementation must return truthful unsupported/needs-setup state. Windows-only operations such as Registry/Event Log/WinRT OCR must not pretend to exist on macOS/Linux. Shared workspace/files/git/process/search/MCP logic should remain portable.

Native target execution may be verified by CI runners when existing workflows support them; no unsupported platform claim may be based solely on Windows simulation.

## Ordered execution phases

### Phase 0 — baseline characterization

- Lock current dev SHA/status/version.
- Add failing/characterization tests before contract changes where behavior is ambiguous.
- Preserve old untracked files.

### Phase 1 — authoritative contracts

Primary areas:

- `packages/mcp-server/src/tools/tool-types.ts`
- `packages/mcp-server/src/tool-schema-registry.ts`
- `packages/mcp-server/src/upgrade-catalog.ts`
- `packages/mcp-server/src/upgrade-runtime.ts`
- `packages/mcp-server/src/tools/upgrade-tools.ts`
- `packages/mcp-server/src/tool-registry.ts`
- `packages/mcp-server/src/server.ts`
- `packages/mcp-server/src/tool-runtime-fixtures.ts`
- `scripts/generate-tool-catalog.mjs`

Deliver strict effective input/output contracts and four MCP annotations; update generated docs/tests.

### Phase 2 — durable goal/continuation reconciliation

Primary areas:

- `packages/domain/src/*goal*`
- `packages/application/src/goal-continuation-service.ts`
- `packages/application/src/scheduled-continuation-service.ts`
- `packages/application/src/goal-mutation-fence-service.ts`
- `packages/storage/src/goal-repository.ts`
- related migrations/recovery services and MCP goal tools.

Add reconciler, stale/superseded evidence and startup/explicit recovery integration.

### Phase 3 — modern MCP Tasks adapter

Primary areas:

- `packages/mcp-server/src/server.ts`
- existing `tasks-protocol*`
- shell/process/task/delegate capability services
- HTTP/stdio integration tests.

Keep modern and legacy capability negotiation truthful.

### Phase 4 — batch/delegate/process reliability

Primary areas:

- `packages/mcp-server/src/tools/batch-tools.ts`
- parallel executor/delegate/task runtime
- cancellation registries and background task stores.

Implement bounded partial-result behavior and fault-injection tests.

### Phase 5 — cache/context/index/routing

Primary areas:

- `packages/mcp-server/src/context-economy.ts`
- `packages/search/src/context-economy.ts`
- `packages/application/src/runtime-cache.ts`
- workspace-index queue/index
- `upgrade-runtime` ranking/search tools.

Unify counters and freshness generations; implement truthful local-reranker disposition.

### Phase 6 — observability

Primary areas:

- `activity-tracker.ts`
- activity/audit log persistence
- telemetry upgrade tools
- request-scope/HTTP/stdio/delegate bridges
- Desktop Work Log/Live Log/telemetry presentation.

Add W3C context and per-tool statistics while preserving redaction.

### Phase 7 — external trust and extensions

Primary areas:

- `packages/extensions/src/*`
- MCP bridge/plugin/skill tools
- Desktop external catalog adapter.

Add namespace/provenance/fingerprint/schema/trust metadata and drift handling.

### Phase 8 — platform/tool-family audit

Audit every first-party tool against the authoritative contract. Correct false supportsCancel/supportsDryRun/platform/readiness claims and strengthen provider-specific behavior/tests.

### Phase 9 — Desktop/Doctor/product UX

Update IPC/catalog projection, Tools/Doctor/Settings/Onboarding/Home diagnostics and scheduler terminology. Keep accessibility and i18n parity.

### Phase 10 — cross-platform provider boundary

Refactor shared/native boundaries required by the preceding audit, keep unsupported Windows-specific features explicit, and run native CI evidence where configured.

### Phase 11 — conformance/security/performance coverage

Add or strengthen:

- MCP current-protocol/legacy negotiation tests;
- official/available conformance scenarios compatible with repository tooling;
- schema/unknown-field tests;
- batch fault injection;
- external MCP spoof/collision/drift tests;
- stale-goal reconciliation concurrency tests;
- trace propagation/redaction tests;
- cache invalidation/context metric tests;
- performance benchmark thresholds that detect major regressions without flaky wall-clock assumptions.

### Phase 12 — watchdog worker-liveness + log-time correctness

Execute this phase only after the originally planned implementation phases above are complete; do not interrupt or reorder the current MCP Tasks/batch/cache/observability/etc. work.

Primary areas:

- durable goal lease acquisition/recovery and scheduled-continuation claim/reconciliation;
- process/task liveness adapters and blocking-job observation;
- activity/work-log persistence and Desktop Work Log/Live Log timestamp rendering;
- watchdog, goal and continuation regression/integration tests.

Required behavior:

- an unexpired lease or `already_claimed` result alone is never sufficient evidence that another worker is live;
- worker-busy decisions must reconcile trustworthy runtime liveness: live fenced requests/heartbeats, `process_list`, and blocking `task_list` states (`running`/`unknown`) as applicable;
- when `process_list` is empty, no blocking task is `running`/`unknown`, no live fenced request exists, generation/activity is unchanged and the heartbeat is sufficiently stale, treat the lease as abandoned and permit fenced/CAS stale-lease recovery rather than waiting for lease expiry;
- takeover rotates lease generation/token so a late old worker cannot mutate after recovery; races must fail closed when liveness becomes uncertain;
- recurring watchdog ordinary wakes keep the same recurring Native ChatGPT task and do not create/retime successors;
- add regression coverage for the exact ghost-worker case: lease present while process list is 100% empty and task list has no `running`/`unknown` entry;
- persisted timestamps remain canonical instants (UTC ISO is acceptable), while Desktop log rows/details render them consistently in the actual local timezone and clearly label raw UTC values when shown; never hard-code UTC+7 or mix local row time with unlabeled `Z` detail timestamps;
- timestamp ordering/comparison always uses the underlying instant and has timezone/DST regression coverage.

### Phase 13 — docs/version/final verification

- Run `pnpm version:set -- 4.55.0` (repository authority) rather than scattered manual edits.
- Regenerate tool contract docs/catalog.
- Update README, architecture docs, capability matrix and release checklist for actual implemented behavior.
- Run focused tests during each phase, then authoritative root verification.
- Build fresh Setup + Portable and verify release evidence/hashes.
- Commit/push `dev` only.
- Inspect final-SHA GitHub Actions; repair and repush until required `dev` workflows are green.

## Acceptance matrix

| Area | Required evidence before closing |
|---|---|
| Tool contracts | All advertised first-party tools have real effective input contracts; output schemas advertised where supported; unknown unsupported fields are rejected; annotation tests cover readOnly/destructive/idempotent/openWorld |
| Catalog/Doctor | Registry, `tool_describe`, schema list, Desktop catalog and generated docs agree on effective metadata/readiness |
| Goals | stale/superseded historical goals can be reconciled safely; live-worker/lease races remain protected; no terminal goal has actionable stale work |
| Scheduled continuation | recurring watchdog lifecycle still passes create/claim/busy-noop/cleanup contracts; busy requires corroborated live-worker evidence rather than lease-only state; ghost lease with empty process list and no running/unknown blocking task recovers safely; no Windows/cron fallback |
| Worker liveness | stale lease takeover is fenced/CAS-safe, generation rotates, late workers cannot mutate, and liveness uncertainty fails closed |
| Log time | persisted instants and Desktop local-time rendering agree; raw UTC values are labeled; timezone/DST ordering tests pass with no hard-coded UTC+7 |
| MCP Tasks | current-protocol Tasks extension path passes integration tests when supported; legacy core Tasks remains legacy-only |
| Batch/delegate | mixed success/error/timeout returns per-item results; cancellation leaves no orphan work |
| Cache/context | runtime and telemetry counters agree in integration tests; catalog/index invalidation is generation-aware |
| Observability | per-tool latency/error/cancel metrics and bounded W3C trace propagation tests pass |
| External MCP | collision-safe namespace, provenance/fingerprint/drift handling and schema validation tests pass |
| Router/index | readiness/risk/schema fit influence ranking without changing authorization; index reports freshness |
| Tool families | every first-party category has truthful platform/provider/readiness/cancel/dry-run behavior |
| Desktop UX | Tools/Doctor/onboarding/scheduler labels are truthful in Thai/English and preserve accessible controls |
| Cross-platform | common provider interfaces compile; Windows-only features remain explicitly unsupported elsewhere; configured native CI jobs pass |
| Security | mutation approval/scope/redaction/external trust regression suites stay green |
| Performance | benchmark has no material regression from v4.54 baseline; idle Desktop refresh remains bounded/single-flight |
| Version/docs | all version surfaces = 4.55.0; generated tool docs and release checklist are consistent |
| Windows artifacts | fresh Setup and Portable under normal installer path with verified SHA-256/evidence |
| Dev CI | all relevant final-SHA `dev` workflows successful or intentionally skipped by design |
| Goal cleanup | Native ChatGPT recurring watchdog non-runnable, cleanup receipt recorded, durable goal terminal only afterward |

## Mutation and release safety

- Work only in the primary registered workspace on `dev` unless a native CI runner is being observed remotely.
- Do not create an implementation worktree unless a concrete isolation need arises; never use the pre-existing v4.53 worktree.
- Do not commit old unrelated Wayfinder files.
- Do not use shell scripts as text editors; use guarded file edit/write tools.
- Do not use Windows Task Scheduler, lnwjud local scheduler, cron, DOM automation or third-party schedulers for autonomous continuation.
- Do not PR/merge `main`, tag, publish or release.
- Do not close the durable goal while any intended test/build/push/CI verification remains unresolved.

## Progress checklist

- [x] Baseline audit
- [x] v4.55.0 comprehensive Wayfinder plan written
- [ ] Strict tool contracts/output schemas/modern annotations
- [ ] Durable lifecycle reconciler
- [ ] Modern MCP Tasks extension adapter
- [ ] Batch/delegate/task reliability
- [ ] Unified cache/context metrics
- [ ] W3C/OpenTelemetry-compatible tracing + per-tool telemetry
- [ ] External MCP/plugin trust hardening
- [ ] Router/index/local-reranker hardening
- [ ] All tool-family contract audit
- [ ] Desktop/Doctor/onboarding/performance/recovery UX hardening
- [ ] Cross-platform provider architecture
- [ ] Conformance/fault/security/performance test matrix
- [ ] Watchdog ghost-worker/stale-lease liveness recovery + fenced takeover
- [ ] Work Log/Live Log local-time/raw-UTC correctness + timezone/DST tests
- [ ] Docs/tool catalog/version = 4.55.0
- [ ] Authoritative local verification green
- [ ] Commit + push `dev`
- [ ] Fresh Setup + Portable verified
- [ ] Final `dev` GitHub Actions all green
- [ ] Native watchdog cleaned up and durable goal terminal
