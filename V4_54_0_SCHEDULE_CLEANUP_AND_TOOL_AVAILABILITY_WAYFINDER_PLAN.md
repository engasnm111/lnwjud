# lnwjud v4.54.0 — Native Schedule Finalization + First-Party Tool Availability Plan

> Status: **IMPLEMENTED — verification/build/push/CI closure in progress**
> Target branch: `dev`
> Baseline observed: `dev` at `origin/dev` / v4.53.0
> Plan date: 2026-09-05
> Implemented version: **4.54.0**

## สรุปเป้าหมาย

v4.54.0 จะจัดการ 2 ปัญหาที่เกี่ยวข้องกับ control-plane โดยตรง:

1. **Scheduled Task cleanup ตอนจบ durable goal ต้องกู้คืนและปิดได้จริง**
   - ห้ามพึ่งว่าต้องยังอยู่ใน turn เดิมที่ `finish_goal` คืน `nativeTaskId` มาให้เท่านั้น
   - ห้าม terminalize แล้วทำให้ recurring wake กลายเป็น `terminal_noop` ทั้งที่ Native ChatGPT Scheduled Task ยังต้อง cleanup
   - ต้องรองรับ host ที่มี `delete`, host ที่มีเพียง `disable/pause`, host operation ที่ไม่ expose ในบาง turn, และ manual user cleanup โดยไม่ปลอม provenance ว่าเป็น host receipt

2. **first-party tools ของ lnwjud ทุกตัวต้องมี user-controlled enable/disable state**
   - state ต้องถูกบังคับจริงทั้ง `tools/list`, `tools/call`, direct registry invoke, `tool_batch`, tool search/ranking และ Desktop Tool Catalog
   - ใช้ MCP SDK 2.0.0 primitive `RegisteredTool.enable()/disable()` และ `notifications/tools/list_changed` แทนการสร้าง protocol ซ้ำ
   - แยก `runtime ready` ออกจาก `user enabled` ชัดเจน
   - เปลี่ยน state แล้วแจ้งเรื่อง ChatGPT refresh/re-scan/re-publish **เฉพาะเมื่อเกี่ยวข้อง**; ห้ามบอกผู้ใช้ว่า browser F5 จะ sync tool snapshot เสมอ เพราะ OpenAI ChatGPT custom MCP app อาจใช้ frozen action snapshot

---

# 1. Research findings

## 1.1 Native ChatGPT Scheduled Tasks

OpenAI Help Center ระบุว่า Scheduled Tasks สามารถจัดการจาก Scheduled page และผู้ใช้สามารถ **edit / pause / delete** task ได้จาก UI.

สิ่งที่เอกสารสาธารณะ **ไม่ได้รับประกัน** คือ model/runtime ทุก turn จะมี native internal delete operation แบบ programmatic ให้เรียกเสมอ. ดังนั้น lnwjud ต้องรักษา boundary เดิม:

- lnwjud owns durable goal/continuation state.
- ChatGPT host owns the real Native Scheduled Task.
- lnwjud may request `make_native_task_non_runnable`, but must not claim that it directly deleted a ChatGPT task unless host evidence proves it.

Reference checked 2026-09-05:
- OpenAI Help Center — “Scheduled Tasks in ChatGPT”: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- OpenAI Help Center — Thai Scheduled Tasks article: https://help.openai.com/th-th/articles/10291617-scheduled-tasks-in-chatgpt
- The public documentation confirms edit / pause / resume / delete management surfaces, but does not promise that every model turn receives an undocumented programmatic delete operation.

## 1.2 ChatGPT MCP app/tool refresh behavior

OpenAI Help Center currently documents:

- Creating a custom MCP app in developer mode includes **Scan Tools**.
- Enterprise/Edu action controls can **Refresh** to pull new/updated actions.
- Business published apps currently cannot simply update published tools; they may require recreate + republish.
- After an app is approved, ChatGPT may use a **frozen snapshot** of tools and inputs. MCP server changes do not automatically update that approved snapshot until the appropriate admin/app update flow runs.

Implication: `notifications/tools/list_changed` is still correct MCP behavior, but it is **not sufficient evidence that ChatGPT web’s approved action catalog changed**.

Reference checked 2026-09-05:
- OpenAI Help Center — “Developer mode and MCP apps in ChatGPT”: https://help.openai.com/en/articles/12584461
- Current guidance explicitly documents Scan Tools for draft creation, Refresh for Enterprise/Edu action control, Business recreate+republish constraints, and the approved-app “frozen snapshot” behavior.

## 1.3 MCP protocol + installed SDK

MCP schema defines `notifications/tools/list_changed` as the server notification that the offered tool list changed.

The exact installed dependency on `dev` is:

- `@modelcontextprotocol/server`: **2.0.0**

A read-only runtime probe against the installed SDK confirmed:

- `McpServer.registerTool(...)` returns a registered-tool handle.
- Handle has `enabled`, `enable()`, `disable()`, `update()`, `remove()`.
- `disable()` / `enable()` go through `update({ enabled: ... })`.
- SDK automatically sends `sendToolListChanged()` after the registered tool is updated.
- SDK `tools/list` filters disabled handles out.
- SDK `tools/call` rejects a disabled tool.

Therefore v4.54.0 must reuse these SDK semantics rather than inventing another list-changed protocol.

Reference checked 2026-09-05:
- Model Context Protocol Tools spec — `notifications/tools/list_changed`: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Model Context Protocol schema reference: https://modelcontextprotocol.io/specification/2025-11-25/schema
- Local installed `@modelcontextprotocol/server@2.0.0` runtime inspection confirmed the SDK handle behavior described above.

---

# 2. Current root causes

## 2.1 Schedule finalization root cause A — cleanup locator is not durable in `get_goal`

Current flow:

1. `finish_goal` validates the goal.
2. It marks the live scheduled continuation `cancel_required`.
3. It returns `completionState=pending_native_cleanup` plus exact `continuationId`, `nativeTaskId`, and expected continuation version.
4. Caller must resolve the ChatGPT host delete/disable operation, execute it, record the receipt, then call `finish_goal` again.

Problem:

- `GoalContinuationService.getGoal()` currently returns only the goal row (`toSnapshot(goal)`).
- The service already has `scheduledContinuations.getLiveScheduledContinuation`, but `getGoal()` does not use it.
- If the turn/tool context that received the original cleanup instruction is lost, `get_goal` does not remind the next worker that the goal is actually waiting on Native Task cleanup.

Consequence: work looks merely `active`, and recovery depends on the model remembering to separately call `get_scheduled_continuation`.

## 2.2 Schedule finalization root cause B — `cancel_goal` terminalizes before Native Task cleanup

Current `cancelGoal()`:

1. terminalizes goal as `cancelled`;
2. cancels tracked work;
3. only afterwards marks the scheduled continuation for host cancellation.

Current storage test intentionally expects a later wake to become `terminal_noop` once the goal is terminal.

That is incorrect for a still-live recurring native watchdog. A terminal goal with a continuation in `cancel_required` still needs a **cleanup-only wake**.

## 2.3 Schedule finalization root cause C — normal completion starts cleanup too late

The current skill’s primary path reaches `finish_goal` first and only then performs host cleanup. That creates a fragile transition exactly at the end of the work.

There is already an independent `cancel_scheduled_continuation` tool that can request cleanup while the goal remains active. v4.54 should make this the preferred pre-terminal path:

```text
all work verified
  -> cancel_scheduled_continuation
  -> host delete OR confirmed disable/pause
  -> record cancellation receipt
  -> finish_goal once
  -> verify get_goal terminal
```

`finish_goal` retains its current defensive pending-cleanup behavior for callers that skip the preferred sequence.

## 2.4 Schedule finalization root cause D — manual cleanup provenance is not modeled honestly

Today `record_scheduled_continuation_receipt(outcome="cancelled")` requires host-native evidence. If the host management surface is unavailable but the user manually deletes the task in ChatGPT’s Scheduled page, there is no truthful typed receipt for “user explicitly confirmed manual deletion”.

v4.54 must never turn a user statement into a fake `provider=chatgpt_scheduled_task / operation=delete / state=deleted` receipt.

A separate user-attested receipt type is required, gated by explicit user confirmation and exact `nativeTaskId` matching.

## 2.5 Tool availability root cause A — exposure is frozen at registry construction

`ToolRegistry` currently computes readonly `allTools` and readonly `tools` in its constructor. Exposure currently depends on:

- Codex group setting,
- Agent Swarm availability,
- upgrade delivery state.

`list()` returns that frozen array and `invoke()` searches that frozen array.

There is no per-tool persistent user preference.

## 2.6 Tool availability root cause B — MCP SDK registration is one-time

`createMcpServer()` currently loops `registry.list()` and registers only those tools. Once a server instance exists, lnwjud does not retain registered-tool handles, so it cannot use SDK `enable()/disable()` later.

Transport lifetimes differ:

- modern Streamable HTTP: server factory may create fresh server instances per request;
- legacy HTTP sessions: server is long-lived;
- stdio: connection-scoped server is long-lived.

v4.54 must support both fresh snapshots and live handle updates.

## 2.7 Tool availability root cause C — secondary discovery can leak disabled tools

Even if `tools/list` is fixed, disabled tools can still leak through:

- `ToolRegistry.invoke()` direct internal path;
- `tool_batch` child execution and child metadata;
- `tool_search` / `tool_dynamic_filter` / `tool_describe` paths backed by the upgrade/search catalog;
- schema/doctor/catalog views if they do not distinguish catalog existence from effective exposure.

The same availability decision must be authoritative everywhere.

---

# 3. v4.54 architecture decisions

## Decision A — no SQL schema migration for tool preferences

Use the existing generic `settings(key, value)` table.

Add one versioned JSON setting key, proposed:

```text
tool_availability_v1
```

Proposed payload:

```ts
interface ToolAvailabilityPreferencesV1 {
  readonly version: 1;
  readonly generation: number;
  readonly overrides: Readonly<Record<string, 'enabled' | 'disabled'>>;
}
```

Reasons:

- existing table already supports arbitrary settings;
- no table/index migration required;
- `generation` gives cross-process watchers an inexpensive change token;
- explicit overrides allow a normal tool to be disabled and a default-hidden Codex tool to be explicitly enabled;
- unknown future/temporarily unavailable names can be preserved without corrupting current catalog.

Default when key is absent: exact v4.53 behavior.

## Decision B — split four concepts that are currently conflated

Every first-party tool should expose:

1. **catalogKnown** — tool exists in canonical first-party catalog;
2. **systemEligible** — platform/delivery/runtime feature can expose it;
3. **userPreference** — `default | enabled | disabled`;
4. **effectiveExposed** — final result used by MCP.

Readiness stays independent. A tool can be:

- runtime-ready but user-disabled;
- user-enabled but dependency-gated/not ready;
- user-default and effective-enabled;
- user-enabled but hard-unavailable on this platform.

Do not reuse current `feature_disabled` readiness reason to mean user choice.

## Decision C — Codex compatibility becomes a group default, not the only gate

`codexToolsEnabled` remains for backward compatibility in 4.54.0, but is treated as the **default preference for Codex-family tools when no per-tool override exists**.

Effective preference precedence:

```text
explicit per-tool override
  > legacy/group default (Codex family)
  > normal default enabled
```

Hard runtime eligibility still wins. Example: enabling Agent Swarm cannot fabricate a missing Agent Swarm provider.

A later release may retire `codexToolsEnabled` after migration telemetry, but not in 4.54.0.

## Decision D — register potential tools once, then use SDK handles

For each server instance:

- construct canonical/system-eligible tool definitions;
- register every tool that may become user-exposed during that server lifetime;
- retain `RegisteredTool` handles by tool name;
- immediately disable handles whose effective state is disabled;
- on availability change, only call `enable()`/`disable()` when state actually changed.

SDK then owns:

- `tools/list` filtering;
- disabled `tools/call` rejection;
- `notifications/tools/list_changed`.

Do not emit duplicate hand-written MCP notifications.

## Decision E — ToolRegistry still enforces availability itself

SDK enforcement is not sufficient because internal/direct paths bypass SDK.

`ToolRegistry` must consult the same availability provider for:

- `list()`;
- `invoke()`;
- schema listing/description where the API claims “currently exposed”;
- `tool_batch.describe` / child invocation;
- tool search/ranking/describe output.

`listAll()` remains canonical and intentionally ignores user exposure so Desktop can always recover a disabled tool.

## Decision F — disabling a tool blocks new calls, not already-running work

When a user disables a tool:

- new calls are denied immediately;
- the tool disappears from current MCP list after propagation;
- already-started calls are **not automatically killed**.

Reason: enable/disable is an exposure control, not a cancellation primitive. Killing an in-flight mutation because a switch changed can leave partial state.

## Decision G — dynamic refresh first, explicit host-sync fallback second

Runtime result should distinguish:

```text
localRuntimeApplied: true/false
mcpListChangedEmitted: true/false/unknown
clientReconnectRequired: true/false
chatgptActionRefreshMayBeRequired: true/false
hostSyncMessage: localized copy or null
```

Rules:

- Do not show ChatGPT refresh copy when no ChatGPT/remote MCP integration is active.
- For a normal MCP client that honors `tools/list_changed`, no manual refresh message is required.
- For ChatGPT custom apps, if the UI still has old actions, show the official app-action refresh guidance.
- Do **not** claim browser F5 alone updates an approved/frozen action snapshot.
- Enterprise/Edu: advise Action control / Refresh when applicable.
- Business published app: current OpenAI docs may require recreate + republish for changed tool definitions/catalog.
- Developer mode draft: Scan Tools / recreate scan as appropriate.

This copy is advisory, not a fake acknowledgement from ChatGPT.

## Decision H — schedule cleanup is a pre-terminal gate

Preferred completion path becomes:

```text
verify actual work complete
  -> read exact latest scheduled continuation
  -> cancel_scheduled_continuation (while goal active)
  -> resolve native ChatGPT schedule management surface dynamically
  -> prefer delete; if delete absent use confirmed disable/pause/update-to-disabled
  -> record exact host receipt
  -> finish_goal
  -> get_goal must be terminal and show no pending native cleanup
```

If host cleanup cannot be verified:

- keep the durable goal active/pending cleanup;
- preserve the exact task locator;
- do not report goal complete;
- recurring wake is cleanup-only, never workspace work.

## Decision I — terminal goals may still have cleanup-only wakes

`claimRecurringScheduledContinuation` must evaluate cleanup obligation before returning `terminal_noop`.

Required behavior:

```text
if continuation is cancel_required/cancel_failed/cancel_uncertain
  and exact native task is still relevant:
    -> terminal_cleanup_required
else if goal is terminal:
    -> terminal_noop
```

This fixes `cancel_goal` and crash/restart races without reactivating workspace mutation.

## Decision J — `get_goal` becomes a recovery surface for pending Native Task cleanup

When the latest live continuation requires cleanup, `get_goal` must return a derived cleanup section such as:

```ts
pendingScheduledTaskCleanup: {
  continuationId,
  nativeTaskId,
  expectedContinuationVersion,
  provider: 'chatgpt_scheduled_task',
  requiredEffect: 'non_runnable',
  state: 'required' | 'failed' | 'uncertain'
}
```

This is derived from existing continuation storage; it does **not** require duplicating the task ID into the goal row.

## Decision K — model manual user cleanup truthfully

Add a separate cancellation evidence variant for explicit manual deletion, for example:

```ts
interface UserConfirmedScheduledTaskCancellationReceipt {
  readonly source: 'user_confirmation';
  readonly nativeTaskId: string;
  readonly action: 'deleted_in_chatgpt_scheduled_tasks_ui';
  readonly observedAt: string;
}
```

Constraints:

- only accepted for a continuation already waiting for cleanup;
- exact native task ID must match;
- tool call must carry explicit user confirmation;
- audit detail must say user-attested/manual, never host-verified;
- host receipt remains preferred whenever host lookup/update/delete is available.

---

# 4. Proposed APIs/contracts

## 4.1 Shared tool availability

New shared parser/serializer:

```ts
type ToolUserPreference = 'default' | 'enabled' | 'disabled';

interface ToolAvailabilitySnapshot {
  readonly generation: number;
  readonly overrides: Readonly<Record<string, 'enabled' | 'disabled'>>;
}

interface EffectiveToolAvailability {
  readonly name: string;
  readonly systemEligible: boolean;
  readonly userPreference: ToolUserPreference;
  readonly effectiveExposed: boolean;
  readonly reason: 'enabled' | 'user_disabled' | 'system_ineligible';
}
```

Corrupt JSON must fail closed to the **v4.53 defaults**, not disable the whole MCP server.

## 4.2 MCP source abstraction

Proposed narrow interface:

```ts
interface ToolAvailabilitySource {
  snapshot(): ToolAvailabilitySnapshot;
  subscribe?(listener: (snapshot: ToolAvailabilitySnapshot) => void): () => void;
}
```

The MCP package must not import Desktop SQLite directly.

Long-lived server lifecycle must dispose subscriptions/timers on close.

## 4.3 Desktop IPC

Add dedicated mutation IPC instead of rewriting all UserSettings:

```ts
interface SetToolAvailabilityRequest {
  readonly name: string;
  readonly enabled: boolean;
}

interface SetToolAvailabilityResult {
  readonly item: ToolCatalogItem;
  readonly localRuntimeApplied: boolean;
  readonly mcpListChangedEmitted: boolean | null;
  readonly clientReconnectRequired: boolean;
  readonly chatgptActionRefreshMayBeRequired: boolean;
  readonly hostSyncMessage: string | null;
}
```

Also add reset-to-default action:

```ts
resetToolAvailability(name)
```

A global “Restore all defaults” can be added in the same service if UX testing shows it is useful, but it is not required for the first implementation checkpoint.

## 4.4 Tool Catalog fields

Add to first-party item:

```ts
readonly userPreference: 'default' | 'enabled' | 'disabled';
readonly effectiveExposed: boolean;
readonly systemEligible: boolean;
```

External MCP child tools remain read-only from this control; this feature controls **lnwjud first-party tools** only. Plugin/extension enable/disable stays in its existing plugin control plane.

## 4.5 Goal read recovery fields

`get_goal` must carry a pending cleanup locator when applicable. Keep the existing `get_scheduled_continuation` tool as the detailed continuation view; do not remove it.

---

# 5. File-impact inventory

## Planned functional touch set: 53 unique paths

This is the implementation touch matrix based on current `dev`. Four of these are proposed new files. It intentionally excludes generated `dist/`, local artifacts, worktrees, and installer output.

### A. Schedule finalization — 15 paths

1. `packages/domain/src/goal-continuation.ts`
2. `packages/domain/src/scheduled-continuation.ts`
3. `packages/application/src/goal-continuation-service.ts`
4. `packages/application/src/scheduled-continuation-service.ts`
5. `packages/storage/src/goal-repository.ts`
6. `packages/mcp-server/src/tools/goal-tools.ts`
7. `packages/mcp-server/src/tools/scheduled-continuation-tools.ts`
8. `.agents/skills/lnwjud-scheduled-continuation/SKILL.md`
9. `packages/application/src/scheduled-continuation-service.test.ts`
10. `packages/storage/src/goal-continuation.integration.test.ts`
11. `packages/storage/src/scheduled-continuation.integration.test.ts`
12. `packages/mcp-server/src/tools/goal-tools.test.ts`
13. `packages/mcp-server/src/tools/scheduled-continuation-tools.test.ts`
14. `packages/mcp-server/src/scheduled-continuation-skill-contract.test.ts`
15. `tests/release/public-repo-hygiene.test.ts`

### B. Shared/application tool-availability model — 7 paths

16. `packages/shared/src/user-settings.ts`
17. `packages/shared/src/index.ts`
18. **NEW** `packages/shared/src/tool-availability.ts`
19. **NEW** `packages/shared/src/tool-availability.test.ts`
20. `packages/application/src/index.ts`
21. **NEW** `packages/application/src/tool-availability-service.ts`
22. **NEW** `packages/application/src/tool-availability-service.test.ts`

### C. MCP runtime + transport enforcement — 10 paths

23. `packages/mcp-server/src/tool-registry.ts`
24. `packages/mcp-server/src/server.ts`
25. `packages/mcp-server/src/http.ts`
26. `packages/mcp-server/src/stdio.ts`
27. `packages/mcp-server/src/upgrade-runtime.ts`
28. `packages/mcp-server/src/tool-registry.test.ts`
29. `packages/mcp-server/src/mcp-http.integration.test.ts`
30. `packages/mcp-server/src/stdio.integration.test.ts`
31. `packages/mcp-server/src/tool-runtime-contract.test.ts`
32. `packages/mcp-server/src/upgrade-runtime.test.ts`

### D. Desktop + stdio runtime + UX — 18 paths

33. `apps/desktop/src/main/desktop-services.ts`
34. `apps/desktop/src/main/mcp-lifecycle.ts`
35. `apps/desktop/src/main/main.ts`
36. `apps/desktop/src/main/tool-catalog/tool-catalog-service.ts`
37. `packages/ipc-contracts/src/index.ts`
38. `apps/desktop/src/preload/index.ts`
39. `apps/desktop/src/renderer/App.tsx`
40. `apps/desktop/src/renderer/features/tools/ToolsPage.tsx`
41. `apps/desktop/src/renderer/features/tools/ToolDetailModal.tsx`
42. `apps/desktop/src/renderer/styles.css`
43. `apps/desktop/tests/preload-tool-catalog-validation.test.ts`
44. `apps/desktop/tests/tools-doctor-ui.test.ts`
45. `apps/desktop/tests/desktop-runtime.persistence.test.ts`
46. `apps/desktop/tests/mcp-lifecycle.test.ts`
47. `apps/desktop/tests/session-resilience-acceptance.test.ts`
48. `apps/desktop/tests/tunnel-tool-catalog-continuity.test.ts`
49. `apps/cli/src/runtime/stdio-mcp-runtime.ts`
50. `apps/cli/src/runtime/stdio-mcp-runtime.test.ts`

### E. Public docs/contracts — 3 paths

51. `README.md`
52. `docs/LNWJUD_CAPABILITIES.md`
53. `docs/architecture/TOOL_CONTRACT.md`

## Mechanical version-bump set: 20 package manifests

At 4.54.0 implementation completion, these 20 manifests currently containing `4.53.0` must be bumped consistently:

1. `package.json`
2. `apps/desktop/package.json`
3. `apps/cli/package.json`
4. `packages/application/package.json`
5. `packages/audit/package.json`
6. `packages/capabilities/package.json`
7. `packages/codex/package.json`
8. `packages/domain/package.json`
9. `packages/extensions/package.json`
10. `packages/filesystem/package.json`
11. `packages/git/package.json`
12. `packages/ipc-contracts/package.json`
13. `packages/mcp-server/package.json`
14. `packages/permissions/package.json`
15. `packages/process/package.json`
16. `packages/project/package.json`
17. `packages/search/package.json`
18. `packages/shared/package.json`
19. `packages/storage/package.json`
20. `packages/workspace/package.json`

`packages/shared/src/index.ts` already appears in the 53 functional paths and contains `APP_VERSION`; it must become `4.54.0` in the release/version phase.

### Planned maximum implementation scope

- **53 functional source/test/doc paths**
- **20 package manifest version paths**
- **73 unique planned paths total**
- **4 proposed new files**
- **0 planned SQL migrations**

If implementation proves that `mcp-lifecycle.ts` does not need a code change because the availability source fully handles lifecycle disposal, that path can be removed; do not add a pointless edit merely to satisfy this inventory.

Generated `dist/`, `.local-artifacts/`, `.worktrees/`, installers, and Wayfinder plans are explicitly excluded from the source touch count.

### Inventory audit performed 2026-09-05

- Verified on `E:\\lnwjud` / branch `dev`.
- `HEAD` and `origin/dev` both resolve to `6cf02e34fd47b42d2e978a5678488d19ab7e083d` at planning time.
- Of the 53 functional paths, **49 currently exist** and **4 are intentionally proposed NEW files**:
  - `packages/shared/src/tool-availability.ts`
  - `packages/shared/src/tool-availability.test.ts`
  - `packages/application/src/tool-availability-service.ts`
  - `packages/application/src/tool-availability-service.test.ts`
- All 20 version-bump manifest paths currently exist.
- No production/source implementation was changed during this planning pass; only this Wayfinder plan was created/updated.

---

# 6. Implementation phases / task list

## Phase 0 — Freeze baseline and write failing characterization tests

- [ ] Confirm branch is `dev`, clean except intentional untracked planning/worktree files.
- [ ] Capture current tool catalog cardinality using the canonical `ToolRegistry(..., { codexToolsEnabled: true }).listAll()` fixture and record it in test output, not hard-coded docs prose.
- [ ] Add failing test: after `finish_goal` enters pending cleanup, `get_goal` exposes exact cleanup locator.
- [ ] Add failing test: a terminal/cancelled goal with `cancel_required` continuation yields cleanup-only wake, not `terminal_noop`.
- [ ] Add failing test: user-attested manual deletion has truthful provenance and cannot masquerade as host receipt.
- [ ] Add failing test: user-disabled tool is absent from `list`, rejected from `invoke`, rejected through `tool_batch`, and excluded from search/ranking recommendations.

Exit criteria: failures prove the two current bugs before production changes.

## Phase 1 — Durable schedule cleanup recovery

- [ ] Add derived pending cleanup section to `get_goal`.
- [ ] Reuse existing continuation row; do not duplicate native task ID into goal table.
- [ ] Ensure `cancel_required`, `cancel_failed`, and `cancel_uncertain` all map to a recoverable cleanup instruction.
- [ ] Change recurring claim ordering so pending cleanup wins over generic terminal-noop.
- [ ] Keep cleanup wakes mutation-free: no goal lease for workspace work, no successor creation, no scheduler churn.
- [ ] Preserve exact continuation version CAS behavior.

Exit criteria: any later turn can call `get_goal` and recover the exact task cleanup contract.

## Phase 2 — Pre-terminal cleanup gate

- [ ] Update scheduled continuation skill: when work is verified done, call `cancel_scheduled_continuation` **before** `finish_goal`.
- [ ] Dynamically resolve host schedule-management operation from the actual ChatGPT host surface.
- [ ] Prefer delete when exposed.
- [ ] Otherwise use confirmed disable/pause/update-to-disabled when the host exposes that as its strongest non-runnable effect.
- [ ] Record exact receipt before `finish_goal`.
- [ ] `finish_goal` defensive fallback remains for callers that skipped the gate.
- [ ] If host operation is absent/ghost/unavailable, persist cleanup-required/uncertain state and do not falsely complete the durable goal.

Exit criteria: normal happy path performs only one terminal `finish_goal` call after native cleanup is already proven.

## Phase 3 — Manual cleanup fallback with honest provenance

- [ ] Add explicit user-confirmed manual deletion receipt variant.
- [ ] Require exact `nativeTaskId` match.
- [ ] Require continuation already in cleanup state.
- [ ] Require explicit user confirmation through mutation envelope.
- [ ] Audit/store it as user-attested, not host-verified.
- [ ] Prefer host not-found/delete/disable evidence whenever available.

Exit criteria: user can manually delete through Scheduled page without the system fabricating a native host receipt.

## Phase 4 — Tool availability persistence + policy

- [ ] Add `USER_SETTING_KEYS.toolAvailability`.
- [ ] Implement versioned parser/serializer.
- [ ] Default missing/corrupt state to v4.53 exposure behavior.
- [ ] Preserve unknown override keys safely.
- [ ] Add monotonic generation.
- [ ] Model explicit override precedence over group defaults.
- [ ] Keep hard platform/runtime eligibility separate.
- [ ] Add reset-to-default behavior.

Exit criteria: preferences survive application restart without SQL migration.

## Phase 5 — ToolRegistry effective-state enforcement

- [ ] Replace frozen user-exposure array assumptions with an authoritative availability provider.
- [ ] Keep `listAll()` canonical and recovery-safe.
- [ ] `list()` filters by effective exposure.
- [ ] `invoke()` rechecks effective exposure at invocation time.
- [ ] Schemas/search descriptions that claim current availability use current exposure state.
- [ ] `tool_batch` cannot execute a disabled child tool.
- [ ] `tool_search` / `tool_dynamic_filter` do not recommend user-disabled tools as runnable.
- [ ] Tool description can state that a catalog-known tool is user-disabled rather than “not found”.

Exit criteria: no bypass path can execute a newly disabled first-party tool.

## Phase 6 — MCP SDK live enable/disable

- [ ] Register all potentially exposable first-party handles for the lifetime of a server instance.
- [ ] Retain SDK `RegisteredTool` handles by name.
- [ ] Apply initial effective state.
- [ ] Subscribe long-lived server instances to availability changes.
- [ ] Call `enable()/disable()` only on actual state transitions.
- [ ] Verify SDK emits `notifications/tools/list_changed` once per meaningful list change.
- [ ] Dispose subscription/polling when server/session closes.
- [ ] Modern per-request HTTP instances read the latest snapshot at construction without leaking timers.
- [ ] Legacy HTTP and stdio long-lived connections receive live changes.

Exit criteria: an MCP test client observes list changes without restarting lnwjud where protocol/lifetime supports it.

## Phase 7 — Desktop/CLI cross-process propagation

- [ ] Desktop main mutation updates settings and in-process availability service immediately.
- [ ] stdio process observes generation changes from shared settings storage without restart.
- [ ] Use bounded/unref’d polling only where cross-process notification is required; no tight loop.
- [ ] Close watcher on runtime shutdown.
- [ ] Ensure unrelated SQLite writes do not cause repeated `tools/list_changed` notifications; compare availability generation/value before publishing.

Exit criteria: toggle in Desktop is reflected by a connected stdio MCP client within the defined bounded propagation window.

## Phase 8 — Tools page UX

- [ ] Add enable/disable control to each first-party tool card/detail.
- [ ] Make user state visually distinct from readiness.
- [ ] Disabled+ready must say “พร้อมใช้งาน แต่ผู้ใช้ปิดไว้” / equivalent English.
- [ ] User-enabled but dependency-gated must still show the dependency issue.
- [ ] Add Enabled/Disabled filter independent from readiness filter.
- [ ] Disable toggle while mutation is in flight to prevent double writes.
- [ ] Refresh selected modal item from the newest catalog snapshot after mutation.
- [ ] Keep Desktop UI as out-of-band recovery so even every MCP tool can be disabled without lockout.

Exit criteria: all first-party tools can be controlled even if the MCP tool set itself has been reduced to zero.

## Phase 9 — Conditional ChatGPT sync guidance

- [ ] Return host-sync disposition from tool availability mutation.
- [ ] If no remote/ChatGPT MCP connection is active: no ChatGPT-specific warning.
- [ ] If live MCP update is enough: show no manual-refresh warning.
- [ ] If ChatGPT may be using an approved frozen action snapshot: show a concise non-blocking notice.
- [ ] Wording must say that browser F5 is not guaranteed to refresh an approved tool snapshot.
- [ ] Point user to the applicable ChatGPT App Action Refresh / Scan Tools / recreate+republish workflow depending deployment capability.
- [ ] Never claim that lnwjud observed ChatGPT’s admin refresh unless it actually has evidence.

Exit criteria: user is prompted only when host-side catalog sync may still be required.

## Phase 10 — Regression and E2E matrix

### Schedule matrix

- [ ] recurring task + normal completed goal + host delete available;
- [ ] recurring task + normal completed goal + delete absent + disable available;
- [ ] host management operation temporarily unavailable -> goal stays pending cleanup and locator remains recoverable;
- [ ] later wake while goal active cleanup-pending -> cleanup-only;
- [ ] cancelled terminal goal + `cancel_required` -> cleanup-only late wake;
- [ ] duplicate cleanup delivery idempotent;
- [ ] manual user deletion receipt has user provenance;
- [ ] wrong native task ID rejected;
- [ ] stale continuation version rejected;
- [ ] after verified cleanup, `finish_goal` terminal and `get_goal` no longer exposes pending cleanup.

### Tool matrix

- [ ] normal tool default enabled;
- [ ] normal tool explicit disabled;
- [ ] disabled tool absent from `tools/list`;
- [ ] disabled tool direct call rejected;
- [ ] disabled child rejected in `tool_batch`;
- [ ] disabled tool excluded from dynamic search/ranking recommendation;
- [ ] enable restores list + invocation;
- [ ] already-running call survives a disable switch;
- [ ] preference survives Desktop restart;
- [ ] preference propagates to stdio process;
- [ ] Codex group default remains backward compatible;
- [ ] explicit per-tool Codex override works without exposing unavailable runtime;
- [ ] `listAll()` / Desktop catalog still contains disabled tools;
- [ ] `notifications/tools/list_changed` emitted on actual transition only;
- [ ] no notification on idempotent repeated same value;
- [ ] external MCP child/plugin tools are not accidentally controlled by first-party toggle;
- [ ] all tools disabled still leaves Desktop recovery UI working.

### Transport matrix

- [ ] modern HTTP;
- [ ] legacy session HTTP;
- [ ] stdio;
- [ ] remote tunnel endpoint preserves same tool exposure as local HTTP;
- [ ] reconnect after state change yields the same list as live-updated connection.

## Phase 11 — Docs + v4.54.0 version consistency

- [ ] Update README with schedule cleanup semantics.
- [ ] Update README Tool Catalog section with per-tool availability and ChatGPT frozen-snapshot caveat.
- [ ] Update `docs/LNWJUD_CAPABILITIES.md`.
- [ ] Update `docs/architecture/TOOL_CONTRACT.md` with effective exposure contract.
- [ ] Bump `APP_VERSION` to 4.54.0.
- [ ] Bump all 20 package manifests to 4.54.0.
- [ ] Run version consistency/release hygiene tests.

---

# 7. Invariants that must not regress

## Scheduled continuation

1. Exactly one Native ChatGPT recurring watchdog per active durable goal.
2. No Windows Task Scheduler, lnwjud scheduler, cron, browser DOM automation, or external scheduler as a substitute for Native ChatGPT Scheduled Tasks.
3. Never hard-code or guess internal ChatGPT scheduling operation names.
4. Cleanup always targets the exact immutable native task ID recorded for the continuation.
5. Delete is preferred; verified disable/pause is acceptable when delete is unavailable.
6. No model assertion may be stored as host-native proof.
7. User manual confirmation, if used, must be stored with truthful user-attested provenance.
8. Cleanup-only wake must never obtain authority to resume workspace mutations.
9. A terminal goal is not sufficient reason to ignore a still-live cleanup obligation.
10. Normal completion is not reported until cleanup contract is satisfied or the product explicitly enters a truthful cleanup-blocked state.

## Tool availability

1. Desktop canonical catalog never loses a tool merely because it is disabled.
2. Disabled means absent from MCP list and denied for new execution.
3. Runtime readiness and user exposure are independent.
4. Hard platform/provider unavailability cannot be overridden by a user toggle.
5. No direct/internal/batch/search path may bypass user-disabled state.
6. SDK `tools/list_changed` is the protocol source of truth for live MCP list-change notification.
7. ChatGPT approved action catalog sync is a separate host concern; never fake acknowledgement.
8. Already-running tool calls are not killed by exposure toggle.
9. All first-party tools can be recovered/re-enabled from Desktop even when MCP exposure is empty.
10. External MCP child tools/plugins retain their own enable/disable control planes.

---

# 8. Explicit non-goals for 4.54.0

- No PR to `main`, merge, tag, publish, or release until separately ordered.
- No macOS/Linux integration work in this plan.
- No redesign of permission profiles; enable/disable is not an authorization replacement.
- No automatic cancellation of in-flight calls on disable.
- No promise that plain browser F5 refreshes ChatGPT’s approved app action snapshot.
- No attempt by lnwjud MCP server to call undocumented OpenAI scheduling APIs directly.
- No SQL schema migration unless implementation research disproves the generic-settings approach.
- No flattening of external MCP child tools into the first-party toggle catalog.

---

# 9. Implementation order recommendation

Recommended order to reduce rollback risk:

1. schedule characterization tests;
2. schedule recovery + pre-terminal cleanup;
3. schedule manual provenance;
4. shared tool availability parser/store;
5. ToolRegistry enforcement;
6. MCP SDK handle live updates;
7. Desktop/stdio propagation;
8. UI/IPC;
9. ChatGPT host-sync messaging;
10. full E2E regression;
11. docs/version bump only after all tests are green.

Do not start with UI. The authoritative runtime policy must exist before adding switches.

---

# 10. Definition of Done for v4.54.0

v4.54.0 is ready for user testing only when all of the following are true:

- A completed durable goal can always recover its exact pending Native Scheduled Task cleanup locator from durable state.
- Normal completion cleans the watchdog before terminalization when possible.
- A cancelled/terminal goal can still produce cleanup-only recurring wake until the native watchdog is non-runnable.
- Host delete, host disable, host-unavailable, and explicit manual user-delete paths are truthfully differentiated.
- No fabricated native receipt is required to finish cleanup.
- Every first-party lnwjud tool has a persisted user enable/disable preference and correct effective state.
- Disabled tools are absent/blocked across MCP list, call, direct registry, batch, and search/ranking paths.
- Long-lived MCP connections receive correct list-change behavior without unnecessary full app restart.
- Cross-process stdio state converges within a bounded interval.
- Desktop clearly separates “ready” from “enabled”.
- ChatGPT-specific refresh guidance appears only when relevant and does not falsely imply F5 is sufficient.
- Full focused tests + full package/app regression suites are green.
- Version metadata is consistently 4.54.0.
- No unrelated branch/main/release mutation has occurred.

---

# 11. Notes for the implementation session

At implementation start:

- reread this plan and current `dev` diff before editing;
- re-run exact tool-catalog bijection test because v4.53.x may have gained tools after this plan was written;
- keep the plan untracked unless the user later requests it committed;
- do not reuse `.worktrees/v453-authoritative-build` as the primary working tree;
- work in `E:\lnwjud` on `dev` unless the user explicitly changes branch policy;
- only after implementation/tests are complete should version files be bumped to 4.54.0 and fresh Setup/Portable artifacts be built when explicitly requested.
