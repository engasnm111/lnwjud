# Scheduled Continuation Capability Evidence

## v4.52.3 Scheduler-degraded durable-goal hardening — 2026-09-04

A live end-to-end probe exposed a post-fire host-surface failure that durable state must not confuse with work completion: the first Native ChatGPT one-time watchdog fired and was correctly retired/superseded, a fresh generation-2 successor reservation was created, and the Native Scheduled Task host then returned `Resource not found` while creating the fresh successor. The successor was recorded truthfully as `create_failed`; no Windows Task Scheduler, lnwjud scheduler, cron, DOM automation, recurrence, or external scheduler fallback was used.

v4.52.3 hardens the boundary between **work state** and **scheduler transport state**:

- `create_failed`, unavailable, unsupported, and `Resource not found` from the Native ChatGPT Scheduled Task host are scheduler transport degradation only; they do not by themselves complete, fail, or block the durable goal;
- the current leased worker keeps useful fenced work running when possible and an unavoidable turn boundary checkpoints the exact work state plus degraded scheduling truthfully without claiming watchdog coverage;
- `run_goal` exposes `create_failed_no_native_task` and `continue_current_run_scheduler_degraded_goal_stays_active` so clients do not terminalize work merely to escape missing successor coverage;
- `finish_goal(status: completed)` is runtime-guarded and rejected while any durable plan step is unfinished, durable blockers remain, or blocking tasks remain tracked;
- `failed` and `blocked` remain real work outcomes, not scheduler escape hatches;
- a still-pending native task may continue to be reused/retimed, while a fired one-time native task remains consumed transport identity and is never re-armed.

Verification on 2026-09-04: application **163/163**, storage **61/61**, and MCP server **894/894** tests passed; focused continuation/goal-tool/skill coverage passed **40/40**; desktop acceptance passed **30/30**; root typecheck, lint, generated tool-catalog check, packaging contract gate, release-gate command, `git diff --check`, and full workspace build all passed before packaging.

## v4.52.2 Single-Live Watchdog hardening — 2026-09-04

v4.52.2 keeps at most one confirmed still-pending native one-time watchdog per active goal. Repeated real checkpoints reuse that continuation/nativeTaskId and may retime the same pending task earlier or later; only a fired/consumed task or absence of pending coverage creates a fresh successor. Terminal cleanup is effect-based: the exact pending task must become non-runnable with truthful host evidence, preferring true delete and accepting host-confirmed disable when delete is not exposed. Skill/runtime prompts must never hard-code an `Automations.*` host operation name.

## Historical: v4.52.1 adaptive host-scheduling hotfix — 2026-09-03

Wayfinder review of the live failure mode found that fixed native-task timing and same-task updates after a one-time wake fired could drive the host into repeated/invalid update attempts, including `Resource not found` once the host had already consumed the one-time task. v4.52.1 separates safety timing from host cadence: the 120-second early-wake tolerance, receipt tolerance, and two-probe orphan interval remain fixed correctness bounds, while all normal native create/recovery timing is lease-aligned/adaptive.

Current v4.52.1 contract:

- omitted `successorDelayMinutes` derives from the current durable-goal lease and clamps to 2–25 minutes; a normal 600-second lease produces roughly a 10-minute successor;
- an acquired wake reserves one deterministic lease-aligned successor in the same transaction;
- a firing one-time task is consumed transport identity and is never treated as future coverage;
- live/uncertain collisions, blocking work after lease expiry, and wakes outside the accepted early window retire the firing ticket and return one fresh adaptive successor rather than updating a consumed host task;
- adaptive collision recovery uses bounded backoff/floors rather than fixed +2 polling;
- `expedite_scheduled_continuation` is the only same-task update path and applies only to a still-pending future task, with a target calculated from remaining lease, host-jitter margin, and deterministic staggering;
- `reschedule_required` remains only for legacy compatibility.

Focused evidence on 2026-09-03: application package **160/160** passed, storage package **59/59** passed, and scheduler-focused MCP skill/runtime/tool contracts **6/6** passed. Native host creation/update/deletion remains host-owned and still requires exact receipts for release-level proof.

## Historical: v4.45 claimed-successor hardening — 2026-09-01

The v4.45 incident exposed a liveness gap between durable state and the native host: a scheduled wake successfully claimed an active goal, but the worker did not make the separate `prepare_scheduled_continuation` call requested only by prompt text. The firing continuation became historical, the goal stayed active, and no next reservation existed until the user prompted the agent again.

The v4.45 repository contract now makes that omission impossible inside lnwjud. A successful `claim_scheduled_continuation` transaction acquires the new lease, marks the firing continuation `claimed`, inserts exactly one deterministic generation N+1 row as `prepared`, caps the acquired lease at the +2-minute handoff, and returns that successor with its host `scheduleRequest`. A repeated claim after an interrupted response returns `successor_required` with the same row. A replay with `native_task_receipt_missing`, `native_task_creation_uncertain`, or `native_task_id_already_recorded` requires exact host reconciliation before any create; only a truthfully failed create without a native ID can refresh to a new +2 retry request. Confirmed worker collisions retain the existing same-native-task +2-minute reschedule path; they do not create a replacement task.

Focused implementation evidence on 2026-09-01:

- application, storage, and goal-continuation state-machine suites: 52/52 passed;
- MCP tool and bundled-skill contract suites: 5/5 passed;
- acquired, interrupted-repeat, receipt, collision, orphan-recovery, lease-cap, finish, and exact-successor cancellation behaviors are exercised by repository/application tests.

This proves the durable lnwjud state transition and published client contract. It does **not** prove that the external ChatGPT host created a native cloud task: `prepared`, `create_failed`, and `create_uncertain` remain unconfirmed. Host creation is accepted only after a real native task ID, host-reported due time, and `runsOn: cloud` receipt are recorded. A real two-wake host run remains the release-level E2E proof.

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

## Historical session-level overlap fence evidence — 2026-08-27

The implementation persists the predecessor MCP session on the continuation, binds the durable goal lease to a session, and requires a scheduled successor to claim from a different session before workspace mutation is authorized. Before `dueAt`, only the predecessor lease session may mutate the fenced workspace. At/after `dueAt`, predecessor mutation is rejected until a successor successfully claims. A wake that reuses the predecessor session fails closed as `busy_blocked` instead of risking concurrent writers.

The ToolRegistry performs the fence check before dispatching workspace-changing file, Git, shell/WSL, managed process, detected `project_*` commands, incremental verification, Codex delegation, worktree/self-heal mutation paths, and supported native document/media mutation tools. Read-only tools remain available. The fence is workspace-scoped, so unrelated workspaces retain the existing multi-workspace concurrency behavior.

Final verification from the implementation worktree:

- application package: 113/113 passed, including scheduled-continuation service 7/7;
- storage package: 34/34 passed, including scheduled-continuation integration 10/10 and goal-continuation integration 7/7;
- MCP server package: 377/377 passed, including scheduled-continuation fence 7/7, scheduled-continuation tools 3/3, goal tools 5/5, and ToolRegistry 37/37;
- desktop package: 348/348 passed, plus the focused acceptance gate 28/28;
- root lint, typecheck, build, documentation tool-catalog check, and Git diff whitespace check passed.

## Native-host gate interpretation

The host proves a native one-time create/disable surface without Windows Task Scheduler or an undocumented OpenAI API. Native current-chat serialization/queuing itself remains unverified, but overlap safety no longer relies on that behavior: the lnwjud session-level mutation fence fails closed if ownership cannot be transferred safely. Any execution-mode claim remains `unverified` until the native host explicitly confirms `cloud` or `local`.
