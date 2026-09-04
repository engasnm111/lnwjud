---
name: lnwjud-scheduled-continuation
description: Use when one durable lnwjud goal must continue autonomously across ChatGPT turns until verified terminal completion.
---

# lnwjud Scheduled Continuation

One user request owns one durable goal and at most one live Native ChatGPT watchdog. v4.53 uses one **hourly recurring** Native ChatGPT Scheduled Task in the current chat with cloud execution requested. The same native task ID survives ordinary wakes until the durable goal is accepted and the exact task is made non-runnable.

## Non-negotiable outcome

- Never require the user to type `continue`, `ทำต่อ`, or ask for status to resume unfinished work.
- Never report completion while `get_goal` is `active`.
- `run_goal` defaults to `scheduledContinuation:auto`; follow this skill automatically for an unfinished goal.
- Use exactly one Native ChatGPT recurring Scheduled Task for a v4.53 active goal: `occurrence=interval`, `intervalMinutes=60`, destination=current chat, cloud requested.
- Never use lnwjud `scheduler`, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser/DOM automation, or an undocumented scheduling API as a fallback.
- Native task create/update/delete/disable is host-owned. Resolve the operation from the current ChatGPT host/tool registry; never invent or hard-code an internal operation name.
- A native-host transport failure is scheduler degradation only. It never by itself completes, fails, or blocks the durable goal.
- Keep raw lease tokens, credentials, private host task IDs, and internal session IDs out of user-visible text and native task prompts.

## Core model

- Normal worker lease: **600 seconds**.
- Recurring cadence: **60 minutes**. This cadence is independent of the worker lease.
- `dueAt` on an interval watchdog is the first scheduled firing, not a mutation handoff deadline.
- If `successorDelayMinutes` is omitted, a new recurring watchdog first fires in 60 minutes.
- A legacy explicit `successorDelayMinutes` value in the accepted 2–25 minute range changes only the **first firing**; recurrence stays hourly.
- Ordinary checkpoints and ordinary recurring wakes never create a successor and never retime the recurring cadence.
- One recurring firing never consumes the native task. `outcome=consumed`, `reschedule_*`, and per-wake successor creation are historical `occurrence=once` compatibility paths only.
- Historical v4.52 one-time rows remain supported. Never create a recurring watchdog while a confirmed live one-time watchdog for the same goal still exists. Let the old one-time lifecycle become historical first, then create exactly one recurring watchdog.

## Start or resume

1. Call `run_goal` before the first mutation of non-trivial multi-step work. Reuse the stable workspace and `goalKey`; do not create a second active goal for the same objective.
2. Use the normal 600-second lease and keep the lease token private.
3. Read the durable checkpoint and continue useful fenced work.
4. At a real milestone call `checkpoint_goal`.
5. Call `prepare_scheduled_continuation` to **ensure one recurring watchdog exists**. Do not call it merely because another checkpoint occurred if confirmed coverage already exists.
6. For a new v4.53 watchdog, use the returned schedule verbatim. It must describe `occurrence=interval`, `intervalMinutes=60`, an explicit IANA `TZID`, and the current chat destination.
7. Create the exact Native ChatGPT task through the host surface and immediately record `created` with the real native task ID and host-reported absolute `dueAt`.
8. Record `runsOn: cloud` only when the host explicitly proves cloud execution. If task identity/schedule is confirmed but execution mode is not exposed, record `runsOn: unverified`; never invent cloud proof.
9. If a definitive host lookup/dispatch failure such as `Resource not found` proves create was not dispatched, re-resolve the Native Scheduled Task operation once and retry that exact create once. Do not retry an ambiguous possible-success. Record `create_failed` or `create_uncertain` truthfully.
10. Continue the current leased worker while useful work is possible; scheduler degradation is not a work failure.

## Work-conserving worker behavior

- **A checkpoint is not a turn boundary.** Ordinary milestone checkpoints persist progress and the worker must continue useful work in the same host turn; they are not permission to yield.
- Keep ordinary checkpoints on the current lease (`releaseLease:false` or omitted). Use `releaseLease:true` only for the final checkpoint when an actual turn boundary is unavoidable.
- A transient tool, status, log, result, or safety/polling error is not a handoff signal. Re-read authoritative durable state and retry or re-resolve the bounded observation in the same turn before considering a handoff.
- When a tracked `blocking_job` is running, do useful non-conflicting work first. If no useful parallel work exists, use bounded waits/observations in the same turn. One failed poll never justifies abandoning the task to the next hourly tick.
- As soon as a tracked task is terminal, inspect its terminal result in the same turn and handle success or failure before yielding.
- If the current worker loses or expires its lease during useful work, read the latest goal and safely reacquire the same `goalKey` with `run_goal` when no newer live owner blocks takeover, then continue in the same turn. Never deliberately wait for lease expiry as a continuation strategy.
- Yield only when the goal is terminal, a real external blocker/user decision leaves no safe useful work, the host forces the turn boundary, or a genuinely long blocking job has no useful parallel work left and durable continuation coverage is confirmed.
- Do not promise or target a fixed 22/25-minute runtime. Consume as much useful host turn as is available while respecting the stop conditions above.

## Recurring scheduled wake

`claim_scheduled_continuation` must be the **first connected lnwjud action before any workspace mutation**.

Handle the result exactly:

- `recurring_acquired`: continue work with the returned `leaseToken`/`leaseGeneration`. Keep the same recurring native task. Do **not** create, update, consume, or replace it.
- `worker_busy_noop`: another worker is live or blocking work is still running. Do not mutate the workspace, do not steal the lease, do not touch the native task, and return naturally. A later hourly firing will try again.
- `orphan_probe_noop`: legacy pre-hardening compatibility only. Current v4.53 recurring mainline must not enter a two-probe wait; if this historical outcome is encountered, do not mutate or touch the native task.
- `already_claimed`: this run/tick was already handled. Do nothing.
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

- A recurring collision is a no-op, not a scheduling event.
- Never create a new recurring task because a worker is busy.
- Live fenced calls and tracked blocking-task states are worker-liveness evidence; MCP session equality and elapsed time alone are not.
- For recurring v4.53 rows, a still-valid lease with trustworthy proof of no live fenced calls and no running/unknown blocking tasks uses the same bounded 60-second stale-heartbeat grace as `run_goal`; once that grace is exceeded, takeover happens in the **same hourly tick** as `orphan_recovered` instead of waiting for lease expiry or a second hourly firing. Historical one-time rows keep their two-probe compatibility fence.
- Full Bypass never bypasses durable-goal ownership fences.

## Before a turn boundary

If the goal remains active:

1. Checkpoint exact progress, blockers, tracked tasks, and the next action.
2. Require exactly one confirmed Native ChatGPT watchdog for normal autonomous recovery: `status=scheduled`, real native task ID, and `confirmedRunsOn=cloud|unverified`.
3. For v4.53 interval mode, reuse the same recurring task; do not create a per-turn successor and do not retime the hourly cadence.
4. If host creation is truthfully unavailable, checkpoint scheduler degradation without claiming coverage. Keep the goal active.
5. At the actual boundary, release the worker lease with the final `checkpoint_goal(..., releaseLease:true)` and perform no later workspace mutation in that turn.

## Verified completion

- Wait for every blocking task to become terminal and inspect its result.
- Clear durable blockers and mark every durable plan step `completed` only after real acceptance evidence exists.
- Call `finish_goal(status:completed)` before reporting completion.
- If it returns `pending_native_cleanup`, the goal is still active. Make the exact recurring task non-runnable using host-confirmed delete or disable evidence. A recurring run receipt is **not** cleanup proof.
- Record the matching native cancellation receipt. If the prior completion lease expired, reacquire the same durable goal with `run_goal` for administrative finalization only; do not resume workspace work. Then call `finish_goal` again immediately.
- Report completion only after `finish_goal` returns `completionState=completed` and `get_goal` confirms a terminal status.
- `failed` or `blocked` are real work outcomes, not scheduler escape hatches.

## Invocation on another machine

Use `$lnwjud-scheduled-continuation` when exposed by name; otherwise load this source-qualified skill and follow it. Never expose raw lease tokens, credentials, private source text, or internal session identifiers in native task prompts or status reports.
