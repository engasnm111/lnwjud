# Multi-Workspace / Multi-Session Concurrency Upgrade

Status: **complete; full verification passed**
Owner scope: lnwjud desktop, HTTP MCP, STDIO/tunnel MCP, activity/audit/logging  
Primary invariant: **one lnwjud installation can serve many concurrent AI sessions and many workspaces while all user settings remain global.**

The dated phase evidence below preserves the catalog counts that were measured
at each historical checkpoint (including the earlier 214/208 baseline). The
current v4.31.0 runtime contract is 231 total definitions, 195 advertised by
default, and 201 when Codex delegation is enabled; see the current catalog and
release checklist for the authoritative release count.

## Goal

Support scenarios such as:

```text
Chat / Session A -> workspace A -> E:\\Project-A
Chat / Session B -> workspace B -> E:\\Project-B
```

at the same time, without one session restarting, re-scoping, cancelling, hiding, or taking ownership of another session's work.

The target topology is:

```text
                         lnwjud
                           |
                  Global machine settings
            permissions / timeouts / delete policy
                 updates / locale / providers
                           |
                one tunnel / MCP surface
                           |
             +-------------+-------------+
             |                           |
         Session A                     Session B
             |                           |
       workspace A                  workspace B
       processes A                  processes B
       activity A                   activity B
       recovery A                   recovery B
```

A session may still perform explicit reads across registered workspaces where an existing tool intentionally supports that behavior. Workspace isolation must not turn into an artificial read-access restriction. Mutating and executing operations remain explicitly scoped by the `workspaceId` in the call and by existing path/permission guards.

## Non-goals

- Do not create separate user settings per workspace.
- Do not create one desktop app, one tunnel, or one port per workspace.
- Do not weaken existing workspace path guards or destructive-operation confirmation rules.
- Do not require a ChatGPT conversation ID; lnwjud must work with protocol/session identities it can actually observe.
- Do not remove explicit multi-workspace read/search capabilities.
- Do not make hidden automatic workspace switching a prerequisite for normal tools.

## Baseline audit — 2026-08-24

### Already workspace-aware

The service layer is mostly ready for concurrency:

- file read/write/move/copy/delete/restore resolves a supplied `workspaceId`;
- recoverable delete stores recovery data below a workspace-specific directory;
- Git status/diff/log/run accepts workspace scope;
- search and project snapshots accept workspace scope;
- workspace indexes are stored per workspace;
- process ownership currently includes `workspaceId`;
- visual observations reject use from a different workspace;
- `WorkLogEntry` and `InFlightWorkItem` already expose `workspaceId`;
- HTTP MCP already has concurrent request/session support;
- Run Budget already understands MCP session IDs where the transport exposes one;
- SQLite is already configured/tested for concurrent WAL access.

### Current blockers

1. **Desktop MCP lifecycle is bound to one selected workspace.**
   `DesktopMcpLifecycle` stores one `workspaceId`; selecting another workspace restarts the MCP listener. This makes the desktop-selected workspace a transport concern when it should only be UI state.

2. **Destructive auto-approval uses one captured Active Project.**
   Desktop and STDIO build `activeProjectProvider` around the workspace selected at MCP startup. Auto-approved destructive operations therefore cannot safely represent simultaneous workspaces.

3. **Transport actors are too coarse.**
   Desktop HTTP uses a shared actor such as `desktop-mcp-http`; STDIO uses `cli-mcp-stdio`. Process ownership therefore separates different workspaces, but two sessions operating in the same workspace are not isolated from each other by actor identity.

4. **STDIO starts with one primary workspace.**
   CLI and packaged desktop STDIO bootstrap a single workspace and close `activeProjectProvider` over it. Registered workspaces can exist, but the destructive-scope identity remains single-workspace.

5. **Shared activity snapshot is single-owner.**
   `lnwjud.mcp.activity.json` stores one process owner and one active count. Multiple simultaneous STDIO MCP processes can overwrite one another, which can make update quiet-time accounting incorrect.

6. **Upgrade runtime persistence is one shared JSON file.**
   `upgrade-runtime.json` contains session/checkpoint/task/plugin/worktree state. Multiple server/session runtimes can race or overwrite unrelated state.

7. **Work Log has workspace metadata but the UI does not filter by it.**
   The data contract is already ahead of the UI.

8. **Live `LogLine` lacks workspace/session metadata.**
   MCP activity files contain workspace context, but `LogHub` flattens the visible line into a global buffer. Session identity is not propagated.

9. **Clear-log state is global.**
   `work_log_cleared_at` clears the visible history for every workspace. Multi-workspace UX needs scoped clear state without turning it into per-workspace user configuration.

10. **Audit queries are global-limit-first.**
    `listByActionPrefix(prefix, limit)` fetches a global recent slice. Filtering only after this slice can starve a quiet workspace when another workspace is very noisy. Workspace/session-aware queries are needed for reliable filtering.

## Architecture decisions

### A1. `selectedWorkspace` is UI state only

Changing the project shown by the desktop must never restart MCP or change the scope of an already-running remote session.

Desktop may remember `selected_workspace_id` for navigation, Git page display, and local buttons, but the MCP lifecycle must be global to the application.

### A2. The call's `workspaceId` is authoritative for workspace-scoped operations

Each workspace-scoped tool call resolves its own registered workspace. The destructive policy must receive the resolved call workspace, not a globally selected workspace.

If a destructive command cannot be proven to target only the call workspace, auto-approval must fail closed and normal confirmation is required.

### A3. Session identity and workspace identity are separate axes

Introduce an internal `McpSessionIdentity` / `RequestScope` that can carry:

```ts
interface McpRequestScope {
  sessionId: string;
  transport: 'http' | 'stdio';
  protocolSessionId?: string;
  workspaceId?: string;
  requestId?: string;
  traceId?: string;
}
```

`workspaceId` describes **where this call operates**. `sessionId` describes **who owns handles/logs/run state**.

Do not require a real ChatGPT conversation ID. HTTP should use a stable MCP session identity when available. STDIO should create a stable synthetic session identity for the lifetime of that MCP process.

### A4. Session identity must participate in owned handles

A process/task/observation or other owned mutable handle started by Session A must not be controllable by Session B merely because both are in the same workspace.

Target ownership key:

```text
(sessionId, workspaceId, handleId)
```

Existing workspace ownership remains mandatory.

### A5. Session-to-workspace binding is descriptive first, not a new read restriction

Track a session's `primaryWorkspaceId` from its first normal workspace-scoped call for logs/UI. Do not block intentional cross-workspace reads or existing multi-workspace tools.

Mutating/executing tools always require their explicit workspace scope and existing permission/path policy. A future optional strict-session-lock can be added separately if needed; it is not required for this upgrade.

### A6. Global settings stay global and live

Permission profile, destructive auto-approval switches, Protected Critical Files, Recoverable Delete, wait/timeout values, Codex tools, providers, update settings, and locale remain machine/application settings.

Changing a global security setting must affect all current sessions without restarting MCP whenever the current implementation already supports live providers.

### A7. Logs gain two orthogonal filters

Keep source tabs:

```text
Tunnel | MCP Activity | Process
```

Add filters:

```text
Workspace: All / Project A / Project B / Global
Session:   All / Session A / Session B
Search:    ...
```

Work Log gets the same Workspace + Session dimensions. Workspace chips/tabs are appropriate for a small number of projects; the renderer should fall back to a dropdown when the list is large.

### A8. Clear/export operations are scoped operational state

Support:

- clear current session;
- clear current workspace;
- clear all visible logs;
- export current filter;
- export a selected source/workspace/session.

These clear cursors are runtime/log-view state, not user security settings.

### A9. Update quiet-time must aggregate all live MCP owners

Replace the single fixed shared-activity owner snapshot with a multi-owner representation. Preferred shape:

```text
<TUNNEL_CLIENT_PROFILE_DIR>/lnwjud.mcp.activity.d/
  <owner-key-1>.json
  <owner-key-2>.json
  ...
```

Each process owns only its lease file. Readers validate owner PID/start time, discard stale owners, and sum `activeCount`. Keep a compatibility reader for the existing v1 fixed file during migration.

### A10. Persisted runtime state must be concurrency-safe

Do not let multiple sessions blindly write the same `upgrade-runtime.json`. Preferred direction:

```text
<data>/runtime-state/
  shared.json                 # only truly shared records, if any
  sessions/<sessionId>.json   # session checkpoints/state
  worktrees/<id>.json         # independently owned durable records
```

Use atomic temp-write + rename and bounded cleanup. Plugins/settings that are actually global should stay in their existing global stores instead of being copied into session files.

## Implementation phases

| Phase | Status | Purpose |
| --- | --- | --- |
| M0 | **complete** | Audit current concurrency model, choose invariants, record file-level plan |
| M1 | **complete** | Decouple desktop-selected workspace from MCP lifecycle |
| M2 | **complete** | Make destructive/project scope request-scoped by `workspaceId` |
| M3 | **complete** | Add stable MCP session identity and session-aware ownership |
| M4 | **complete** | Make STDIO shared activity and persisted runtime state multi-owner safe |
| M5 | **complete** | Propagate workspace/session metadata through audit + Live Logs |
| M6 | **complete** | Add workspace/session filters, scoped clear/export, UI badges/tabs |
| M7 | **complete** | Concurrency/isolation acceptance, release gates, and repository-wide Full Verification complete |

## Phase M1 — global MCP lifecycle

### Code changes

- `apps/desktop/src/main/mcp-lifecycle.ts`
  - remove workspace ownership from the listener lifecycle;
  - `start()` becomes application-level, not `start(workspaceId)`;
  - status no longer treats a workspace as the listener identity;
  - retain a compatibility `workspaceId: null` field temporarily if needed by IPC consumers.

- `apps/desktop/src/main/desktop-services.ts`
  - `selectAndMaybeRestart()` becomes selection only;
  - adding/selecting a workspace must not restart MCP;
  - `createServerOptions` becomes global and receives a request-scoped workspace resolver instead of closing over one workspace.

- `apps/desktop/src/main/main.ts`
  - desktop startup should start one MCP surface independently of the selected project.

### Tests

- selecting A -> B while MCP is running keeps endpoint/session alive;
- an in-flight A call survives UI switch to B;
- two concurrent calls with A/B workspace IDs complete without listener restart;
- global settings updates still propagate.

### Exit criteria

Desktop project navigation has zero effect on MCP transport continuity.

## Phase M2 — request-scoped workspace/destructive policy

### Code changes

- `packages/mcp-server/src/tool-registry.ts`
  - replace synchronous global `activeProjectProvider()` with a workspace resolver keyed by the invocation input;
  - resolve `workspaceId` before destructive auto-approval;
  - if there is no resolvable registered workspace, never auto-approve destructive behavior.

- `packages/mcp-server/src/destructive-scope.ts`
  - accept the resolved call workspace root;
  - preserve current path containment, machine-root rejection, wildcard, recursive, and critical-file rules.

- `packages/mcp-server/src/server.ts`
  - expose the request-scoped resolver in server options.

- `apps/cli/src/runtime/stdio-mcp-runtime.ts`
- `apps/cli/src/bin/mcp-stdio.ts`
- `apps/desktop/src/main/main.ts`
  - stop closing destructive scope over the startup workspace.

### Tests

- Session/call A `workspaceId=A`, target inside A -> eligible according to global policy;
- same call targeting B/outside A -> no auto-approval;
- B works at the same time independently;
- machine-root workspace still cannot enable broad automatic deletion;
- no-workspace destructive request fails closed to confirmation.

### Exit criteria

The selected/startup project is no longer part of destructive authorization.

## Phase M3 — stable session identity and handle ownership

### Code changes

- add `packages/mcp-server/src/request-scope.ts` or equivalent;
- propagate one stable internal session ID through `server.ts`, HTTP, and STDIO;
- HTTP: attach protocol session ID when available;
- STDIO: generate one synthetic session ID at process/server startup;
- extend `ActivityTracker.begin/end` with session identity;
- derive a session-specific `FileActor` or add explicit session ownership to services;
- update `ProcessService` ownership checks to include session identity;
- audit other owned handles: durable shell tasks, Codex task handles, observations, debug/LSP/session handles.

### Important compatibility rule

Do not assume `actor.clientId` from the transport is already a session ID. Today it is intentionally static. Session ownership must be explicit and stable.

### Tests

- Session A and B in the same workspace cannot stop/read owned process handles from each other;
- Session A can reconnect to its own stable protocol session and retain ownership where transport semantics support reconnect;
- a new unrelated session cannot inherit handles;
- different workspaces remain isolated as before.

### Exit criteria

Same-workspace concurrent sessions have independent ownership boundaries wherever the transport exposes a stable session identity. Modern stateless HTTP intentionally uses an explicit endpoint-level fallback rather than inventing a ChatGPT conversation ID.

### M3 implementation evidence

- HTTP protocol sessions derive a stable internal session identity from the MCP session ID; STDIO receives one synthetic identity for its serving lifetime.
- `ProcessService` and `CodexService` ownership now require client + session + workspace.
- Shell durable metadata persists client/session/workspace ownership; list/status/wait/logs/result/cancel enforce it across backend replacement.
- WSL task handles and MCP Tasks protocol propagate the same trusted owner metadata. Tool input cannot spoof this metadata because the MCP layer overwrites it from the scoped actor.
- Legacy ownerless durable metadata remains readable only through the legacy ownership fallback, so a new scoped session cannot inherit it.
- Targeted verification: application ownership 15/15, capabilities shell/WSL/durable 28/28, MCP scope/activity/tasks/registry 46/46, HTTP/STDIO transport integration 10/10, MCP/CLI/Desktop typecheck passed, targeted ESLint passed.

## Phase M4 — multi-owner STDIO and durable runtime state

### Shared activity

- evolve `packages/mcp-server/src/shared-activity-snapshot.ts` to v2 multi-owner leases;
- keep v1 read compatibility during upgrade;
- updater aggregation returns the sum of verified live owners;
- each lease removes only its own owner file;
- stale owner cleanup is bounded and race-safe.

### Runtime state

- replace shared blind writes to `upgrade-runtime.json`;
- namespace session state by internal `sessionId`;
- use atomic writes;
- keep truly shared data in an explicit shared store only when required;
- migrate/read legacy single-file state once without dropping valid worktree ownership data.

### Tests

- two STDIO runtimes publish activity simultaneously without overwriting one another;
- updater sees total active count from both;
- one process exits and only its lease disappears;
- simultaneous session checkpoints do not overwrite each other;
- legacy v1 activity/runtime state remains readable during migration.

### Exit criteria

Multiple STDIO MCP children can coexist without corrupting activity or session persistence.

### M4 implementation evidence

- Shared MCP activity now publishes one v2 lease file per verified process owner and aggregates all live owners; the v1 fixed snapshot remains readable during migration.
- Lease close/stale cleanup is owner-scoped and quarantine-based, so one STDIO child cannot delete another child's fresh heartbeat.
- Update quiet-period checks use aggregate active count plus an owner-set/revision key, so owner arrival/departure restarts the safety clock.
- Upgrade runtime persistence now uses hashed session files for tasks/checkpoints/session state and a locked shared file for global plugins + Git worktree ledger.
- Writes use atomic temp+rename and token-owned inter-process locks with bounded stale-lock recovery. Legacy `upgrade-runtime.json` is preserved; one session claims legacy session state while shared plugin/worktree data migrates once for every session.
- New worktree ledger entries include `ownerSessionId`; another session cannot remove them, while legacy client-owned entries remain compatible.
- Targeted verification: shared activity 10/10, CLI STDIO 4/4, desktop session-resilience acceptance 9/9, upgrade runtime/state concurrency 19/19, MCP/CLI/Desktop typecheck passed, targeted ESLint and `git diff --check` passed.

## Phase M5 — audit/log metadata propagation

### Contracts

Extend MCP activity/audit-visible data with:

```text
workspaceId
sessionId
protocolSessionId?  # diagnostic only
callId
traceId?
```

### Code changes

- `packages/mcp-server/src/activity-tracker.ts`
- `packages/mcp-server/src/activity-log-file.ts`
- desktop + CLI activity sinks
- `packages/audit/src/audit-types.ts`
- `packages/storage/src/audit-repository.ts`
- `packages/ipc-contracts/src/index.ts`
- `apps/desktop/src/main/log-hub.ts`

`LogLine` should gain nullable `workspaceId` and `sessionId` fields instead of encoding scope only into text.

Add workspace/session-aware audit repository queries. Do not query the latest 100 global rows and then filter, because a noisy project can starve another project's history.

Process log feed entries must carry their owning workspace/session too.

### Tests

- activity NDJSON round-trips workspace + session;
- SQLite audit queries return the requested workspace/session slice;
- log dedup keys cannot collapse identical calls from two sessions;
- tunnel-global lines remain `workspaceId=null`, `sessionId=null` unless correlation proves otherwise.

### Exit criteria

Every MCP/process line that can be scoped carries machine-readable workspace/session metadata.

## Phase M6 — desktop log UX

### Work Log

- add `All` + workspace selector/chips;
- add session selector;
- show small workspace/session badges per row when viewing `All`;
- preserve newest-first behavior and search;
- default to selected workspace when useful, but allow `All` explicitly.

### Live Logs

Keep source tabs and add workspace/session filters below them.

Suggested layout:

```text
Tunnel | MCP Activity | Process
Workspace: [All v]   Session: [All v]   Search: [...]
```

### Clear/export

- clear current session;
- clear current workspace;
- clear all;
- export the active filtered view.

Do not implement clear cursors as security settings. Use a dedicated log-view state structure/repository or clearly separated internal state keys.

### Target files

- `apps/desktop/src/renderer/features/worklog/WorkLogPanel.tsx`
- `apps/desktop/src/renderer/features/worklog/WorkLogPage.tsx`
- `apps/desktop/src/renderer/features/live/LiveLogsPage.tsx`
- `apps/desktop/src/renderer/features/live/LogStreamPanel.tsx`
- `apps/desktop/src/renderer/features/live/StandaloneLogViewer.tsx`
- `apps/desktop/src/renderer/App.tsx`
- renderer i18n + CSS

### Exit criteria

A user can isolate A/B activity visually without stopping either project, while global settings remain a single settings surface.

## Phase M7 — concurrency and release gates

Required acceptance scenario:

```text
Session A / Workspace A:
  write -> build -> background task -> git status

Session B / Workspace B, concurrently:
  write -> test -> background task -> git status
```

Assertions:

1. both complete;
2. switching Desktop UI A/B does not restart MCP;
3. A destructive call cannot escape A's explicit workspace;
4. B destructive call cannot escape B's explicit workspace;
5. A cannot control B-owned handles, including when A/B use the same workspace;
6. Work Log filters A/B correctly;
7. Live Log filters A/B and Session A/B correctly;
8. clear A does not clear B;
9. changing a global delete/permission setting affects both sessions;
10. updater does not install while either session has active MCP work;
11. simultaneous STDIO owners do not overwrite activity state;
12. no tool-count/catalog drift;
13. lint, typecheck, build, full tests, packaging, release, and public-repo hygiene pass.

Add a dedicated concurrency acceptance test instead of relying only on unit tests. Prefer deterministic barriers/promises over timing sleeps.

## Progress log

### 2026-08-24 — M0 complete

- confirmed service-layer workspace scoping is already widespread;
- confirmed Desktop MCP lifecycle is the main single-active-workspace bottleneck;
- confirmed destructive auto-approval is currently closed over one startup/selected workspace;
- confirmed HTTP transport already supports concurrent sessions;
- confirmed Work Log already carries workspace IDs;
- confirmed visible Live Log contract lacks workspace/session IDs;
- confirmed process actor identity is shared per transport and therefore insufficient for same-workspace session isolation;
- confirmed shared STDIO activity snapshot is single-owner and must become multi-owner;
- confirmed `upgrade-runtime.json` is a shared blind-write collision point;
- confirmed global-limit-first audit queries need workspace/session-aware variants;
- recorded target architecture and phased implementation plan in this document.

### 2026-08-24 — M1 complete

- made `DesktopMcpLifecycle` application-global: listener status no longer owns a workspace and the compatibility `workspaceId` is always `null`;
- adding or selecting a desktop workspace no longer restarts the MCP listener;
- `startMcp` still validates the requested registered workspace for IPC compatibility, but starts the same global listener;
- `restartMcp` no longer requires a selected workspace;
- verified one connected HTTP MCP client remains usable while the desktop selection switches A -> B -> A and concurrent `workspace_info` calls for A/B both complete;
- architecture deviation recorded: request-scoped destructive resolution belongs to M2, so M1 intentionally supplies no Active Project to Desktop HTTP destructive auto-approval. This fails closed to normal confirmation instead of inheriting the UI-selected workspace;
- verification: `mcp-lifecycle.test.ts` 4/4, targeted `desktop-runtime.persistence.test.ts` 7/7, desktop typecheck, and targeted ESLint all passed.
### 2026-08-24 — M2 complete

- replaced the selected/startup Active Project dependency with request-scoped registered-workspace resolution inside `ToolRegistry`;
- destructive auto-approval now requires an explicit non-empty `workspaceId` on the invocation and resolves that workspace through the registered `workspaceInfo` service;
- resolver failures, missing workspace IDs, unknown workspaces, cross-workspace absolute targets, machine-root scopes, wildcards, recursive deletes, and protected critical targets all fail closed to normal confirmation;
- added optional `workspaceId` to the `shell` schema for backwards compatibility; confirmed shell execution remains available without it, but destructive auto-approval does not;
- Desktop HTTP, packaged Desktop STDIO, and CLI STDIO no longer close destructive authorization over a startup/selected workspace;
- kept `activeProjectProvider` as deprecated internal API compatibility only; current lnwjud runtimes no longer use it;
- updated destructive tool descriptions and regenerated the 214-tool catalog;
- verification: MCP targeted tests 29/29, CLI STDIO runtime 4/4, Desktop persistence 7/7, MCP/CLI/Desktop typechecks, targeted ESLint, and `docs:tools:check` all passed.
## Progress update rules

When implementation starts, update this file in the same commit as each phase change:

- change the phase status (`planned` -> `in progress` -> `complete`);
- append a dated progress entry with code/tests completed;
- record any architecture deviation before implementing it;
- never mark a phase complete without its exit-criteria tests;
- keep global settings global unless this document is explicitly revised.

### 2026-08-24 — M7 complete

- added a real Desktop MCP concurrency acceptance using one listener, two protocol sessions, and two registered workspaces;
- verified parallel A/B flows: write -> project build/test -> durable shell background task -> git status;
- verified switching the Desktop-selected workspace does not restart or replace the listener;
- verified process and durable-shell handles remain session-owned even when another session addresses the same workspace;
- verified one global destructive-delete policy applies to both sessions while cross-workspace destructive targets fail closed;
- verified Work Log and Live Log retain separate workspace/session metadata and scoped clearing of A leaves B intact;
- verified updater/shared-activity/runtime-state isolation through the targeted M7 matrix;
- wired the new concurrency acceptance into the authoritative test:acceptance script and release checklist/gate;
- targeted verification: new concurrency acceptance 1/1, M7 isolation/updater matrix 84/84, authoritative acceptance 16/16, release gate 6/6, advertised tools 208 per HTTP session, configurable catalog 214, Desktop typecheck, targeted ESLint, and git diff --check all passed;
- repository-wide Full Verification completed after M7: frozen install, lint, typecheck, full monorepo tests, acceptance 16/16, integration 2/2, E2E 3/3, build, 214-tool catalog sync, packaging 4/4, release gate 6/6, Windows NSIS packaging, git diff --check, and public-repo hygiene 7/7 all passed.
- the Full Verification run exposed one real runtime-state contention race; it was repaired in commit `6adcfc4` by serializing same-process writers, hardening cross-process locking/atomic I/O, failing closed on unreadable authoritative state, and making durable checkpoint persistence surface failure instead of silently succeeding.
- post-repair evidence: MCP full package 169/169, targeted runtime-state/concurrency 7/7, stress 20/20 repeated runs, then the authoritative Full Verification completed cleanly.
