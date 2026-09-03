---
name: lnwjud-scheduled-continuation
description: Use when a user wants one durable lnwjud goal to continue autonomously across ChatGPT turns until verified terminal completion, especially during long builds, tests, or managed background tasks.
---

# lnwjud Scheduled Continuation

One user request starts one durable chain: acquire the existing goal, maintain at most one still-pending native cloud watchdog for that active goal, keep doing useful work, hand off only with verified recovery coverage, and stop only after the goal is verifiably terminal. Reuse and retime the same pending native task whenever it has not fired; create a fresh native task only after the prior one-time task was consumed or when no pending native task exists.

## Non-negotiable outcome

- Never require the user to type “continue”, “ทำต่อ”, or ask for status to restart an unfinished goal.
- Never send a completion report while `get_goal` reports `active`.
- A request to stop scheduling cancels only the successor; it does not cancel or complete the durable goal.
- `run_goal` defaults to `scheduledContinuation: auto`; when `continuationDirective.mode: auto` is returned, the client MUST apply this skill automatically and never require another user prompt to resume an unfinished goal.
- Use one native one-time ChatGPT Scheduled Task in the current chat and request cloud execution. Never use recurrence, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser/DOM automation, or undocumented scheduling APIs.
- Native task creation/update/deletion is host-owned. Invoke the native ChatGPT Scheduled Task host tool/API surface exposed to the current chat directly from `scheduleRequest`; lnwjud stores reservations, receipts, claims, and cancellation truth. If that native host surface is absent, record a truthful create failure and never substitute DOM automation.
- Resolve and use the native Scheduled Task operation exactly as it is exposed by the current ChatGPT host/tool registry. Do **not** assume, invent, or hard-code an internal host tool/resource name; host operation identifiers are not part of the lnwjud contract. `scheduleRequest` is source data for the host call, not the name of another lnwjud MCP operation.
- Never search for, invent, or route through an lnwjud MCP scheduler/automation tool to create the native task. lnwjud owns durable-goal reservation/receipt/claim state only; the ChatGPT host owns the actual Scheduled Task. If the exposed host operation is unavailable, rejects the request, or returns not-found/unsupported, immediately call `record_scheduled_continuation_receipt(outcome: create_failed)` with the current continuation version **before** checkpointing, yielding, or relying on that reservation.
- `prepared` means **reservation only**: never a confirmed successor and never handoff-ready. A valid live worker may keep doing useful fenced work while native-task creation is retried, but it must never silently return with a merely `prepared` successor.

## Timing policy: adaptive host cadence, fixed safety invariants

Do not treat protocol safety windows as scheduling cadence.

- The normal goal lease is **600 seconds (10 minutes)**.
- When `successorDelayMinutes` is omitted, `prepare_scheduled_continuation` derives the successor from the current durable-goal lease and clamps it to **2–25 minutes**. A normal 600-second lease therefore produces a roughly 10-minute successor, not a fixed +2-minute wake.
- Explicit 2–25 minute delays remain valid when the caller has a concrete bounded reason.
- A successful scheduled claim atomically reserves a fresh lease-aligned successor using the requested claim lease, clamped to 2–25 minutes.
- Worker collision backoff is adaptive: approximately **4 → 8 → 16 → 25 minutes**, with lease/liveness/orphan-proof floors able to move the due time later within the cap.
- A truthfully failed create with no native task ID may refresh to the current lease-aligned adaptive deadline.
- A confirmed **still-pending future** native task is the Single-Live Watchdog for the goal. Repeated real checkpoints may reuse it or retime that same native task ID earlier or later when the lease-aligned watchdog deadline materially changes. `expedite_scheduled_continuation` is the explicit handoff-risk path for moving that same pending task earlier; it must never update a task after it has fired. Targets are adaptive; do not hard-code +2.
- The **120 seconds early** wake allowance, receipt-time tolerance, and the two-probe orphan interval are safety invariants. They remain fixed because they protect correctness; they are not host polling frequencies.

## Start or resume

1. Call `run_goal` before the first mutation of a non-trivial multi-step task. Reuse the stable workspace and goalKey; do not create a second goal while the existing one is active.
2. Use the normal 600-second lease and keep the raw lease token private.
3. Read the checkpoint, perform useful work, and call `checkpoint_goal` only for real milestones.
4. After a real checkpoint, call `prepare_scheduled_continuation` to **ensure** watchdog coverage, not to blindly create a new task. If no live native watchdog exists it returns a `scheduleRequest` for one create. If a confirmed pending watchdog already exists it reuses that continuation and may return a same-ID `taskUpdateRequest` when retiming is needed; apply the returned host schedule verbatim. `dueAt` is the canonical absolute instant and the VEVENT must carry an explicit IANA `TZID`.
5. Record `created` immediately with the real native task ID and host-reported absolute dueAt. Record `runsOn: cloud` only when the native host explicitly proves cloud execution; when the host confirms task creation/schedule but does not expose execution mode, record `runsOn: unverified`. `status: scheduled`, a non-empty `nativeTaskId`, and `confirmedRunsOn: cloud|unverified` prove native-host task coverage; only `cloud` proves the execution mode itself. Explicitly confirmed `local` is not valid coverage for this cloud-preferred lane.
6. Attach `goalLease` to every fenced mutation. Real fenced activity renews the lease while work is alive; inactivity does not.
7. For builds/tests/tasks, wait for every active task ID to reach a terminal state and inspect its result instead of returning “still running”.

## Before any turn boundary

If the goal is still active:

1. Checkpoint the exact next action and tracked tasks.
2. Require exactly one confirmed native ChatGPT successor and request cloud execution. If none exists, reserve/create one using the lease-aligned adaptive policy and record its host receipt. A host-confirmed task whose execution mode is not exposed may remain `unverified`; do not invent `cloud` proof.
3. If a confirmed **future pending** task exists but a real host deadline/budget/tool-degradation/turn-yield signal requires it sooner, call `expedite_scheduled_continuation` and apply its returned schedule verbatim. Do not invent a fixed time.
4. Re-read the continuation and require `status: scheduled`, a real native task ID, and `confirmedRunsOn: cloud|unverified`. `prepared`, `create_failed`, `create_uncertain`, missing host identity, or explicitly confirmed `local` execution is not handoff-ready for this lane.
5. **Release the worker lease at the actual turn boundary.** Once recovery coverage above is confirmed and the current worker is really about to return, write one final `checkpoint_goal` with the exact latest state/tracked tasks and `releaseLease: true`, then perform no further workspace mutation in that turn. This makes the next user/scheduled worker immediately acquirable instead of leaving a healthy 10-minute lease behind. Do not release early while useful work is still continuing.
6. Unexpected death before that final release is recovered by `run_goal` liveness-aware stale-worker takeover for rolling goals: only trustworthy evidence with no live fenced calls, no running/unknown blocking tasks, unchanged generation/activity, and a stale heartbeat may rotate the lease. Session equality alone is never recovery proof, and the old lease generation becomes invalid after takeover.

## Scheduled wake

`claim_scheduled_continuation` must be the first connected lnwjud action before workspace mutation.

- `terminal_noop`: create nothing; let the already-firing one-time host task return naturally.
- `already_claimed`: another run owns the wake; do not mutate.
- `receipt_required`: reconcile the exact native host state before any create or mutation.
- `acquired` / `orphan_recovered`: claim atomically reserves a fresh `prepared` lease-aligned successor and returns its `scheduleRequest`. Do **not** call `prepare_scheduled_continuation` again. Create the exact returned task, record the real host receipt, then continue with the new goalLease.
- `successor_required`: use the returned `scheduleRequest` for the exact deterministic successor. This is the normal recovery result when the firing one-time task collided with live/uncertain work, an expired lease still has blocking work, the host fired outside the accepted early-jitter window, or a prior claimed successor still needs truthful creation/reconciliation. Never create blindly when the reason is `native_task_receipt_missing`, `native_task_creation_uncertain`, or `native_task_id_already_recorded`.
- A one-time native task that has **fired is consumed transport identity**. Retire/supersede it and use the fresh adaptive successor returned by claim. Never repeatedly update or re-arm the firing nativeTaskId.
- `reschedule_required` is the normal same-ID retime state for an exact confirmed native watchdog that is **still pending**. Apply only its returned `taskUpdateRequest`, record the host receipt, and reuse the same nativeTaskId. It is never permission to update a one-time task after that task has fired.

A host wake outside the 120-second early window is still a fired one-time task. Do not try to move that consumed task back to its old dueAt; reserve the fresh adaptive successor returned by claim instead.

If exact host metadata later proves a recorded native task ran while claim did not complete, reconcile with `record_scheduled_continuation_receipt(outcome: consumed)` and the exact native run receipt. `consumed` does **not** mean the goal work completed.

## Collision and orphan safety

- Collision never calls `finish_goal`, marks the goal blocked, or mutates workspace without ownership.
- A firing collision retires the old transport row and reserves exactly one fresh deterministic successor. Backoff grows adaptively (about 4/8/16/25 minutes) rather than hammering the host every two minutes.
- Live fenced calls and managed task states are worker-liveness evidence; MCP session equality and elapsed time are not.
- Orphan takeover requires two unchanged trustworthy no-worker probes at least 120 seconds apart, identical revision/generation/activity evidence, no live fenced calls, and no running blocking tasks. `orphan_recovered` remains the stronger acquisition reason even if the lease expires between valid probes.
- Full Bypass never bypasses durable-goal ownership fences.

## Cancellation and verified completion

- `cancel_goal` and `cancel_scheduled_continuation` are independent controls.
- Native cleanup/cancellation is proven only by matching host evidence that the exact task is **non-runnable**. Prefer delete when the host exposes true deletion; otherwise a host-confirmed disable of the exact pending task is valid non-runnable evidence. Never call a task deleted when it was only disabled. Never report cancellation as successful without exact non-runnable host evidence, and never report cleanup as successful while the effect is failed, uncertain, or unverified.
- Before completion, wait for all blocking tasks to be terminal and re-run acceptance evidence.
- Call `finish_goal` even when scheduling was disabled.
- If `finish_goal` returns `pending_native_cleanup`, follow the exact host cleanup instruction, record the native host deletion/run receipt, then call `finish_goal` again.
- Report completion only when `finish_goal` returns `completionState=completed` and `get_goal` is terminal.

## Invocation on another machine

Use `$lnwjud-scheduled-continuation` when exposed by name; otherwise load this source-qualified skill and follow it. Never expose raw lease tokens, credentials, private source text, or internal session IDs in native task prompts or status reports.