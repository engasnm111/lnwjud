# Scheduled Continuation Capability Evidence

## Native one-time capability probe — 2026-08-27

- Host surface: ChatGPT scheduled automation capability exposed to this chat.
- Destination requested: current chat continuation.
- Occurrence requested: one-time, exactly one DTSTART and no RRULE.
- Probe prompt: bounded harmless current-time report; no file mutation, lnwjud mutation, or successor creation.
- Create result: accepted by the native host as a one-time task.
- Native task identifier: returned by host and intentionally not copied into repository evidence because user-facing automation policy treats it as internal metadata.
- Requested delay: 2 minutes.
- Runs on: `unverified`. The available host tool did not expose a field that can force or prove `cloud` versus `local` execution, so this evidence does not claim cloud mode.
- Recurrence evidence: host schedule contained one `DTSTART` and no `RRULE`.
- Delete/disable surface: verified by disabling the probe through the native task update surface.
- Same-chat native serialization: not proven by this harmless probe. No workspace mutation was used for the probe.
- Safety no longer assumes native serialization. A separately reviewed session-level workspace mutation fence now guards the rolling-continuation lane.

## Session-level overlap fence evidence — 2026-08-27

The implementation persists the predecessor MCP session on the continuation, binds the durable goal lease to a session, and requires a scheduled successor to claim from a different session before workspace mutation is authorized. Before `dueAt`, only the predecessor lease session may mutate the fenced workspace. At/after `dueAt`, predecessor mutation is rejected until a successor successfully claims. A wake that reuses the predecessor session fails closed as `busy_blocked` instead of risking concurrent writers.

The ToolRegistry performs the fence check before dispatching workspace-changing file, Git, shell/WSL, managed process, detected `project_*` commands, incremental verification, Codex delegation, worktree/self-heal mutation paths, and supported native document/media mutation tools. Read-only tools remain available. The fence is workspace-scoped, so unrelated workspaces retain the existing multi-workspace concurrency behavior.

Final verification from the implementation worktree:

- application package: 113/113 passed, including scheduled-continuation service 7/7;
- storage package: 34/34 passed, including scheduled-continuation integration 10/10 and goal-continuation integration 7/7;
- MCP server package: 377/377 passed, including scheduled-continuation fence 7/7, scheduled-continuation tools 3/3, goal tools 5/5, and ToolRegistry 37/37;
- desktop package: 348/348 passed, plus the focused acceptance gate 28/28;
- root lint, typecheck, build, documentation tool-catalog check, and Git diff whitespace check passed.

## Current gate interpretation

The host proves a native one-time create/disable surface without Windows Task Scheduler or an undocumented OpenAI API. Native current-chat serialization/queuing itself remains unverified, but overlap safety no longer relies on that behavior: the lnwjud session-level mutation fence fails closed if ownership cannot be transferred safely. Any execution-mode claim remains `unverified` until the native host explicitly confirms `cloud` or `local`.
