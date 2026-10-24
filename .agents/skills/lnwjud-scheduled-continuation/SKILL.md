---
name: lnwjud-scheduled-continuation
description: Resume one durable lnwjud goal across ChatGPT turns when the user authorized scheduled continuation; preserve lease ownership, hourly native scheduling, checkpoints, and verified terminal cleanup.
---

# lnwjud Scheduled Continuation

One user request owns one durable goal and at most one live Native ChatGPT watchdog. Current mainline uses one **hourly recurring** Native ChatGPT Scheduled Task in the current chat with cloud execution requested. The same native task ID survives ordinary wakes until the durable goal is accepted and the exact task is made non-runnable.

## Authorization and current contract

Use scheduled continuation only when the user authorized it for this task. Updating this skill, requesting a release, or enabling a host Goal does not itself authorize a native schedule. Reuse an existing goal's workspace, goal key, connector, and `scheduledContinuation` setting. For a new durable goal without scheduling authorization, explicitly pass `scheduledContinuation: off`; continue manual work normally. An explicit opt-out stops scheduled continuation and never abandons the durable goal.

Before changing workflow guidance, inspect the current runtime through CodeGraph when `.codegraph/` exists. The source contracts are [`goal-tools.ts`](../../../packages/mcp-server/src/tools/goal-tools.ts), [`scheduled-continuation-tools.ts`](../../../packages/mcp-server/src/tools/scheduled-continuation-tools.ts), and [`registry-runtime-port.ts`](../../../packages/mcp-server/src/registry-runtime-port.ts). Read root [`AGENTS.md`](../../../AGENTS.md) for repository rules. Installed connector tools may lag source; resolve their advertised schema in the current session before calling them. A missing tool or stale schema is a transport/version limitation, not permission to invent an API or change schedulers.

## Non-negotiable outcome

- Never require the user to type `continue`, `ทำต่อ`, or ask for status to resume unfinished work.
- Never report completion while `get_goal` is `active`.
- A ChatGPT Task marked **Active** proves only that the recurring schedule is enabled; it does not prove an MCP tool was invoked, the Goal lease was acquired, or any work ran between hourly firings. Verify the exact host last-run receipt, the first connector call and durable Goal/activity evidence before describing execution.
- An hourly recurring ChatGPT Task cannot guarantee continuous model execution or a gap shorter than its next firing. If the Goal opted out, resume the same Goal manually; preserve that setting and report host/tool safety checks truthfully.
- `run_goal` defaults to `scheduledContinuation:auto` in the API. Select `off` explicitly when scheduling was not authorized; an API default cannot grant user authorization.
- For an authorized active goal, use exactly one Native ChatGPT recurring Scheduled Task: `occurrence=interval`, `intervalMinutes=60`, destination=current chat, cloud requested.
- Never use lnwjud `scheduler`, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser/DOM automation, or an undocumented scheduling API as a fallback.
- Native task create/update/delete/disable is host-owned. Resolve the operation from the current ChatGPT host/tool registry; never invent or hard-code an internal operation name.
- A native-host transport failure is scheduler degradation only. It never by itself completes, fails, or blocks the durable goal.
- Keep raw lease tokens, credentials, private host task IDs, and internal session IDs out of user-visible text and native task prompts.
- Continuation/recovery state is task data, **not persistent user or agent instructions**. Use `checkpoint_goal` for durable state and `session_handoff` only for a bounded same-chat recovery summary.
- Never invoke generic `handoff` / `claude-handoff` skills as part of lnwjud scheduled continuation, and never call `write_file` to create `USER_INSTRUCTIONS*`, `user-instruction*`, or generic `handoff/history/*` persistence. Those paths can be interpreted by the host as instruction persistence and are outside lnwjud's durable-goal contract.
- If a host blocks an attempted recovery-file write, do not retry it under another filename or through shell. Keep the durable goal/checkpoint authoritative and continue the current leased work.

## Core model

- Normal worker lease: **600 seconds**.
- Recurring cadence: **60 minutes**. This cadence is independent of the worker lease.
- `dueAt` on an interval watchdog is the first scheduled firing, not a mutation handoff deadline.
- If `successorDelayMinutes` is omitted, a new recurring watchdog first fires in 60 minutes.
- A legacy explicit `successorDelayMinutes` value in the accepted 2–25 minute range changes only the **first firing**; recurrence stays hourly.
- Ordinary checkpoints and ordinary recurring wakes never create a successor and never retime the recurring cadence.
- One recurring firing never consumes the native task. `outcome=consumed`, `reschedule_*`, and per-wake successor creation are historical `occurrence=once` compatibility paths only.
- Historical one-time rows remain supported. Never create a recurring watchdog while a confirmed live one-time watchdog for the same goal still exists. Let the old one-time lifecycle become historical first, then create exactly one recurring watchdog.

## Lease and checkpoint payloads

Every rolling-mode workspace mutation carries the current `goalLease` object with `goalId`, `leaseToken`, and `leaseGeneration`. The top-level `leaseToken` on Goal control calls is a separate API field; follow the advertised schema for both. After reacquisition, replace the full proof with the returned generation. MCP session equality, Full Bypass, and a saved token are not ownership proof. Ordinary unscheduled Full Bypass calls stay lease-free when no live rolling-goal fence exists.

Use the latest returned Goal `revision` as `expectedRevision`, and the latest continuation `version` as `expectedVersion`. On conflict, read authoritative state and reconcile before retrying; never replay a mutation blindly.

`checkpoint_goal` and `prepare_scheduled_continuation` require either `trackedTasks` or legacy `activeTaskIds`, even though each array is individually optional. Send `trackedTasks: []` when none exist. Prefer entries shaped as `{ taskId, provider, role, cancelWithGoal }`, with `provider` equal to `process`, `codex`, or `shell`. A `blocking_job` participates in liveness and completion; a `supporting_service` does not. Set `cancelWithGoal` only when this Goal owns cancellation. Inspect and cancel through the entry's provider; never probe or stop a shared service as if it were a Goal-owned process. Legacy `activeTaskIds` remain conservative Goal-owned blocking jobs. When using `trackedTasks`, omit `activeTaskIds` or leave that legacy array empty.

When `resumeContext` is present, include all eight arrays, using empty arrays where appropriate: `changedFiles`, `commands`, `decisions`, `failedAttempts`, `pendingValidation`, `resumePrerequisites`, `stateFacts`, and `artifacts`. Commands use exact command text, `status` of `passed`, `failed`, or `running`, and real exit/result evidence. Engineering gate evidence must match a passed `resumeContext.commands` entry and its workspace. Do not mark an unverified gate passed, manufacture `not_applicable`, or create a replacement Goal to evade a completion gate. Discover an advertised compatibility alias only when the installed primary schema lacks fields; aliases retain the same ownership and evidence rules.

## Start or resume

1. Call `run_goal` before the first mutation of non-trivial multi-step work. Reuse the stable workspace and `goalKey`; do not create a second active goal for the same objective. Preserve scheduling authorization as described above.
2. Use the normal 600-second lease and keep the lease token private.
3. Read the durable checkpoint and continue useful fenced work. Prefer the latest checkpoint `resumeContext` over guessing from a short summary: inspect changed files, exact commands/results, decisions, failed attempts, pending validation, resume prerequisites, state facts, artifacts, blockers, tracked tasks, and the next action.
4. Keep the durable Goal fresh while working. Call `checkpoint_goal` immediately after a plan-step state change, terminal blocking task, blocker add/resolution, commit, push, hosted-CI conclusion, package/deploy/release artifact, or other meaningful milestone. If sustained active work has no natural milestone, refresh `currentPhase`, `nextAction`, blockers, `trackedTasks`, and truthful step state at least every 10 minutes; never defer several completed steps to one late end-of-task checkpoint. A meaningful milestone or handoff checkpoint must include reconstruction-grade `resumeContext`: changed files; exact commands with `passed`/`failed`/`running` status, exit code and concise result; decisions; failed attempts that should not be repeated; pending validation; resume prerequisites; state facts; and artifacts. `summary` is only a headline and must never be the sole recovery record.
5. Call `prepare_scheduled_continuation` to **ensure one recurring watchdog exists** only when scheduled continuation remains enabled. Do not call it merely because another checkpoint occurred if confirmed coverage already exists, and never create/re-enable scheduling after the user disables it.
6. For a new recurring watchdog, use the returned schedule verbatim. It must describe `occurrence=interval`, `intervalMinutes=60`, an explicit IANA `TZID`, and the current chat destination.
7. Create the exact Native ChatGPT task through the host surface and immediately record `created` with the real native task ID and host-reported absolute `dueAt`.
8. Record `runsOn: cloud` only when the host explicitly proves cloud execution. If task identity/schedule is confirmed but execution mode is not exposed, record `runsOn: unverified`; never invent cloud proof.
9. If a definitive host lookup/dispatch failure such as `Resource not found` proves create was not dispatched, re-resolve the Native Scheduled Task operation once and retry that exact create once. Do not retry an ambiguous possible-success. Record `create_failed` or `create_uncertain` truthfully.
10. Continue the current leased worker while useful work is possible; scheduler degradation is not a work failure.

## Work-conserving worker behavior

- **A checkpoint is not a turn boundary.** Ordinary milestone checkpoints persist progress and the worker must continue useful work in the same host turn; they are not permission to yield.
- For `recurring_acquired`, run an explicit work loop before status prose: inspect the returned goal and `get_goal`/latest `resumeContext` when reconstruction detail is needed; select one concrete next safe action from `nextAction`, pending plan steps, blockers, and tracked tasks; invoke the relevant tool; inspect the result; then select the next action. Repeat while safe useful work remains.
- Keep ordinary checkpoints on the current lease (`releaseLease:false` or omitted), and continue the work loop immediately after the checkpoint. Use `releaseLease:true` only for the final checkpoint when an actual turn boundary is unavoidable.
- **Pre-final active-goal guard:** before sending any final response while `get_goal` is still `active`, re-read authoritative goal state and inspect `nextAction`, blockers, tracked tasks, and pending plan work. If any concrete safe action remains, execute it instead of returning. An intermediate progress update never satisfies this guard.
- At an unavoidable handoff boundary, persist reconstruction-grade `resumeContext` and use `releaseLease:true` before returning when the host still permits tool calls. If the host cuts off without another tool call, rely on the existing stale-recovery contract rather than claiming a final checkpoint happened.
- A transient tool, status, log, result, or safety/polling error is not a handoff signal. Re-read authoritative durable state and retry or re-resolve the bounded observation in the same turn before considering a handoff.
- **Discovering a fixable failure is the next unit of work, not a turn boundary.** If CI, tests, code scanning, packaging, release validation, or another tool exposes a concrete problem, immediately inspect the exact failure, diagnose it, make the smallest justified repair, and run the relevant validation in the same host turn while useful tool time remains. Never spend an hourly wake merely reporting a problem that can still be acted on.
- User-visible progress prose is not a substitute for execution. Do not stop just to summarize an intermediate failure while safe useful actions remain; summarize only at a real yield boundary or after terminal completion.
- When a tracked `blocking_job` is running, do useful non-conflicting work first. If no useful parallel work exists, use bounded waits/observations in the same turn. One failed poll never justifies abandoning the task to the next hourly tick.
- As soon as a tracked task is terminal, inspect its terminal result in the same turn and handle success or failure before yielding.
- If the current worker loses or expires its lease during useful work, read the latest goal and safely reacquire the same `goalKey` with `run_goal` when no newer live owner blocks takeover. If `run_goal` returns `acquired: false` with `retryAfterSeconds <= 60` (or `nextRequiredAction: 'retry_run_goal_after_stale_grace_window'`), the prior worker is inactive and only the brief stale-recovery grace remains: wait that brief duration and invoke `run_goal` again to complete takeover, instead of yielding and reporting that an inactive worker blocks continuation. Never deliberately wait for lease expiry as a continuation strategy.
- Yield only when the goal is terminal, a real external blocker/user decision leaves no safe useful work, the host forces the turn boundary, or a genuinely long blocking job has no useful parallel work left and durable continuation coverage is confirmed.
- Do not promise or target a fixed 22/25-minute runtime. Consume as much useful host turn as is available while respecting the stop conditions above.

## Authoritative CI watcher policy

When work includes waiting for GitHub Actions, the CI watcher is part of the active worker's durable work, not a reason to yield to the next scheduled tick.

- Resolve the exact GitHub Actions run ID first and watch that exact run. Never switch to "latest branch run" after monitoring begins.
- Prefer one long-running background/durable watcher: `gh run watch <RUN_ID> -i 20 --exit-status`.
- Before spawning it, inspect existing authoritative tasks/processes. Reuse a live watcher for the same exact run ID instead of creating a duplicate.
- Track the watcher as the authoritative `blocking_job` for that CI run when a durable goal is active.
- Wait for the watcher to become terminal and confirm the workflow conclusion before reporting success.
- If it fails, inspect logs from that exact run before making code changes. Never diagnose from a different run.
- Never merge, tag, publish, or release a SHA whose required CI is failed or non-terminal.
- Multiple exact run IDs may share one durable watcher process if their exit codes are preserved and any required failure makes the watcher fail.
- Windows wrappers may use PowerShell. macOS/Linux wrappers must use a shell actually available on those platforms such as `sh` or `bash`; do not call a PowerShell-only watcher cross-platform.
- This watcher is not a Native ChatGPT Scheduled Task. If scheduled continuation is disabled, do not create or re-enable a schedule merely to monitor CI.

Windows-only wrapper example:

```powershell
powershell -NoProfile -NonInteractive -Command "
Write-Host 'Watching CI run 123456...';
gh run watch 123456 -i 20 --exit-status;
$ciExit = $LASTEXITCODE;
exit $ciExit
"
```

POSIX example:

```sh
gh run watch 123456 -i 20 --exit-status
```

## Recurring scheduled wake

The Native Scheduled Task prompt must explicitly bind back to the connected lnwjud plugin/connector for the current chat. When the host exposes a connector mention, pass the **exact host-provided value** as `prepare_scheduled_continuation.connectorMention`: either a plain `@name` or the ChatGPT app mention `[$name](app://asdk_app_<32 hex digits>)`. The returned `scheduleRequest.prompt` must prefix/preserve that exact mention verbatim, including its actual app ID, without assuming a universal `lnwjud`/`lnwjud-pc` alias. Never fabricate, reuse from a different user or infer a connector app ID; if no connector is installed/exposed, omit the mention and treat unresolved tool access as transport degradation. Mention text does not grant host tool approval; continue to respect exact-action Host Safety. Do **not** rely on a bare tool name alone. On wake, resolve that connected lnwjud connector before producing user-visible prose. If the connector cannot be resolved or invoked, treat it as scheduler transport degradation only: perform no workspace mutation, do not claim progress, leave the durable goal active, and let the recurring task try again.

`claim_scheduled_continuation` must be the **first connected lnwjud action before any workspace mutation** and before any user-visible status reply. Include the expected `goalId` and `workspaceId` from the wake metadata alongside `continuationId` when available, so identity is checked before liveness or lease mutation.

Handle the result exactly:

- `recurring_acquired`: continue work with the returned `leaseToken`/`leaseGeneration`. Keep the same recurring native task. Do **not** create, update, consume, or replace it.
- `worker_busy_noop`: another worker is live or blocking work is still running. If `retryAfterSeconds <= 60` is returned, no live worker was observed and the lease is simply within the bounded stale-heartbeat grace window: wait that brief duration and retry `claim_scheduled_continuation` or `run_goal` in the same turn to complete takeover. If `retryAfterSeconds` is large, do not mutate the workspace, do not steal the lease, do not touch the native task, and return naturally. A later hourly firing will try again.
- `orphan_probe_noop`: legacy pre-hardening compatibility only. Current recurring mainline must not enter a two-probe wait; if this historical outcome is encountered, do not mutate or touch the native task.
- `already_claimed`: a true concurrent/stale duplicate was observed after this interval already acquired the current lease. Do not mutate. An existing interval `runKey` alone is never sufficient; a same-interval retry whose liveness targets the current lease must re-check worker/blocking-task state and may recover after the stale-heartbeat grace.
- `receipt_required`: reconcile exact native host metadata before any mutation or blind create.
- `not_due`: do not mutate; let the recurring task remain unchanged.
- `terminal_cleanup_required`: **cleanup only**. Do not resume goal work and do not claim a worker lease before host cleanup. Make the exact recurring native task non-runnable with the strongest host operation exposed (prefer delete; otherwise confirmed disable) and record the exact cancellation receipt. If the prior completion worker lease has expired, call `run_goal` with the same workspace/goalKey **after cleanup only** to obtain an administrative finalization lease; do not resume workspace work. Then call `finish_goal` again immediately.
- `terminal_noop`: no work and no new task. Return naturally.

### Legacy one-time wake compatibility

Only for historical `occurrence=once` rows:

- `acquired` may return one freshly reserved one-time successor.
- `successor_required` may require the exact deterministic successor or exact receipt reconciliation.
- `reschedule_required` may retime the exact still-pending one-time task.
- A fired one-time native task is consumed transport identity and must never be re-armed.
- `expedite_scheduled_continuation` is **one-time compatibility only**. Never use it for `occurrence=interval`.

## Collision and orphan safety

- A true concurrent recurring collision is a no-op, not a scheduling event. A prior run record for the same hourly interval is not liveness proof and must not suppress current-liveness stale recovery.
- Never create a new recurring task because a worker is busy.
- Live fenced calls and tracked blocking-task states are worker-liveness evidence; MCP session equality and elapsed time alone are not.
- For recurring rows, a still-valid lease with trustworthy proof of no live fenced calls and no running/unknown blocking tasks uses the same bounded 60-second stale-heartbeat grace as `run_goal`; once that grace is exceeded, takeover happens in the **same hourly tick** as `orphan_recovered` instead of waiting for lease expiry or a second hourly firing. Historical one-time rows keep their two-probe compatibility fence.
- Full Bypass never bypasses durable-goal ownership fences.

## Before a turn boundary

If the goal remains active:

1. Checkpoint exact progress, blockers, tracked tasks, and the next action.
2. When scheduled continuation is authorized, require exactly one confirmed Native ChatGPT watchdog for normal autonomous recovery: `status=scheduled`, real native task ID, and `confirmedRunsOn=cloud|unverified`.
3. For authorized interval mode, reuse the same recurring task; do not create a per-turn successor and do not retime the hourly cadence. With scheduling disabled or unauthorized, preserve that setting and checkpoint for manual recovery instead of creating coverage.
4. If host creation is truthfully unavailable, checkpoint scheduler degradation without claiming coverage. Keep the goal active.
5. At the actual boundary, release the worker lease with the final `checkpoint_goal(..., releaseLease:true)` and perform no later workspace mutation in that turn.

## Verified completion

- Wait for every blocking task to become terminal and inspect its result.
- Clear durable blockers and mark every durable plan step `completed` only after real acceptance evidence exists.
- When a live scheduled watchdog exists, call `cancel_scheduled_continuation` **before** `finish_goal`. Keep the durable goal active while cleanup is being proven.
- Make the exact recurring native task non-runnable with the strongest operation actually exposed by the ChatGPT host: prefer delete, otherwise use a host-confirmed disable. Record host-confirmed delete or disable evidence when the host supplies it. A recurring run receipt is **not** cleanup proof.
- Record the matching native cancellation receipt before terminalizing the goal. If the host management surface is unavailable but the user explicitly deletes the exact task in ChatGPT Scheduled Tasks, record that as **user-attested manual deletion** with explicit user confirmation; never relabel user testimony as host-native evidence.
- After verified cleanup, call `finish_goal(status:completed)` once and then read `get_goal`. The normal happy path should not need a second finish call.
- Defensive fallback remains required for older callers: if `finish_goal` returns `pending_native_cleanup`, the goal is still active. Recover the exact cleanup locator from `get_goal`/`get_scheduled_continuation`, perform cleanup only, record truthful evidence, reacquire an administrative finalization lease if needed, and call `finish_goal` again without resuming workspace work.
- Report completion only after `finish_goal` returns `completionState=completed` and `get_goal` confirms a terminal status with no pending scheduled-task cleanup.
- `failed` or `blocked` are real work outcomes, not scheduler escape hatches.

## Invocation on another machine

Use `$lnwjud-scheduled-continuation` when exposed by name; otherwise load this source-qualified skill and follow it. Never expose raw lease tokens, credentials, private source text, or internal session identifiers in native task prompts or status reports.
