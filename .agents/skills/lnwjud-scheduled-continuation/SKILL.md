---
name: lnwjud-scheduled-continuation
description: Use when a user wants one durable lnwjud goal to continue autonomously across ChatGPT turns until verified terminal completion, especially during long builds, tests, or managed background tasks.
---

# lnwjud Scheduled Continuation

One user request starts one durable chain: acquire the goal, arm one cloud successor, keep doing useful work, hand off when necessary, and stop only after the goal is verifiably terminal.

## Non-negotiable outcome

- Never require the user to type “continue”, “ทำต่อ”, or ask for status to restart an unfinished goal.
- Never send a completion report while `get_goal` reports `active`.
- A request to stop scheduling cancels only the successor. It does not cancel, block, pause, or complete the durable goal. Continue in the current run and still call `finish_goal` when the work is actually done.
- `cancel_goal` and `cancel_scheduled_continuation` are independent controls: the former records the goal as cancelled, aborts in-flight fenced MCP requests, and stops only goal-relative tracked tasks whose `cancelWithGoal` policy is true; shared `supporting_service` entries remain running by default. The latter cancels only the waiting successor. Call both when the user wants both effects.
- Use one native one-time cloud ChatGPT Scheduled Task in the current chat. Never use recurrence, Windows Task Scheduler, `schtasks.exe`, cron, shell timers, browser automation, or undocumented scheduling APIs.
- Native task creation, update, and deletion are host-owned. lnwjud stores the reservation, receipts, claim, and cancellation truth.
- `prepared` means **reservation only**. It is never a confirmed successor, never handoff-ready, and never sufficient recovery coverage. A worker that already owns a valid current goal lease may keep doing useful fenced work while native-task creation is retried; the reservation still caps that worker at its handoff deadline. Before any turn yield or handoff with an active goal, require `status: scheduled`, a real `nativeTaskId`, and `confirmedRunsOn: cloud`, unless scheduling was explicitly disabled; otherwise create/reconcile the native task and record its host receipt first. never silently return with a merely `prepared` successor.

## Start or resume

For any non-trivial multi-step workspace task that includes mutation plus verification, build, packaging, push/release preparation, or is reasonably likely to outlive the current host turn, call `run_goal(..., scheduledContinuation: 'auto')` **before the first mutation even when the user did not explicitly ask for scheduling or name this skill**. If such work is already in progress and no active durable goal exists, enroll/recover it immediately before the next mutation instead of continuing unfenced. This is the automatic entry guard that prevents a long workflow from ending with no successor merely because `run_goal` was never invoked.

`run_goal` defaults to `scheduledContinuation: auto`. When its result contains `continuationDirective.mode: auto`, the client MUST apply this skill automatically even when the user did not name `$lnwjud-scheduled-continuation`. The directive is the durable-goal opt-in signal: never require another user prompt to resume an unfinished goal. Use `scheduledContinuation: off` only when the user explicitly disables future scheduling; that disables the successor, not the current goal work.

1. Call `run_goal` with a stable workspace and goal key using the normal **600-second (10-minute) lease**. Never override this workflow to an hour-long lease. Keep the returned lease token and generation private. The lease is a short crash-recovery window, not the expected work duration; real checkpoint/fenced-mutation activity renews it while work is actually alive.
2. Read the durable checkpoint and do the next useful work. Record real milestones with `checkpoint_goal`; do not checkpoint merely because time elapsed.
3. After the first checkpoint, call `prepare_scheduled_continuation` and create exactly one native one-time task from its `scheduleRequest`. Use `scheduleRequest.schedule` verbatim as the host schedule. `dueAt` is the canonical absolute instant, while the VEVENT carries an explicit IANA `TZID` so the native ChatGPT host does not misread a UTC `Z` timestamp as local wall-clock time. Record `created` with the real native task ID, the host-reported absolute `dueAt`, and `runsOn: cloud` **immediately** before relying on it. If native creation fails or is uncertain, record that truth immediately and keep the valid current worker doing useful fenced work while repairing recovery coverage; do not turn a host scheduling failure into a reason to stop the goal. Never yield while durable state is still only `prepared`, `create_failed`, or `create_uncertain` and the goal remains active.
4. Choose `successorDelayMinutes` adaptively within **2–25 minutes**. The API default is deliberately **2 minutes** as a fail-safe: any longer watchdog must be explicit.

   | Remaining work at this checkpoint | Delay |
   | --- | --- |
   | Long or open-ended work while this run is healthy and will keep executing | explicitly 25 minutes |
   | One bounded phase expected within about 15 minutes and this run will keep executing | explicitly 10 minutes |
   | Final build, smoke, or verification expected soon and this run will keep executing | explicitly 5 minutes |
   | This turn must end while work remains, or no worker will continue after this response | 2 minutes |

   25 minutes is the maximum watchdog, not the default handoff. A schedule is recovery insurance, never permission to stop working early. If the current response is about to end, do not arm 25/10/5 minutes merely because the goal is long; use +2 because there will be no live worker after the turn.
5. Attach the current proof as `goalLease` to every fenced mutation. Never put the raw token in prompts, logs, receipts, docs, or user-visible text.
6. Keep working continuously. For a managed build/test/shell task, use condition-based task wait/status calls, inspect its terminal output, and do not end the turn with only “still running” when the user asked to babysit it to completion.

## Before any turn boundary

If `get_goal` is still `active` and scheduling remains authorized:

1. Checkpoint the exact next action and every active task ID.
2. Require one confirmed cloud successor. If none exists yet, prepare it **directly at +2 minutes**, create the native task, and record `created`; do not first create a 25/10/5-minute task when this turn is already ending. Do not create a second task when one already exists.
3. If a confirmed successor already exists at a later due time, call `expedite_scheduled_continuation` with `turn_yield_signal`, update the **same native task** to **+2 minutes**, and record the reschedule receipt.
4. Re-read the continuation and require `status: scheduled`, a non-empty `nativeTaskId`, and `confirmedRunsOn: cloud` at the +2-minute due time. `prepared`, `create_uncertain`, or a missing host identity is a hard handoff failure: do not mutate further and do not let the turn yield until the host task is created/reconciled and its receipt is recorded. Only then may the current turn yield. A status update is not completion.

If the user disabled scheduling, call `cancel_scheduled_continuation` for the exact pending successor, delete the exact pending native task, and record its native host deletion receipt. Do not create another successor; remain in the current run, wait for bounded active work, finish verification, and close the goal.

If the user asks to cancel the goal, call `cancel_goal` with the latest expected revision. It aborts active fenced MCP requests and stops only goal-owned tracked tasks across process, Codex, and shell backends, including durable shell workers from another MCP session. Model background work in checkpoints with `trackedTasks: [{taskId, provider, role: 'blocking_job'|'supporting_service', cancelWithGoal}]`; use explicit providers to avoid all-provider fan-out, and use `activeTaskIds` only for legacy compatibility. Supporting services such as a shared local database are not liveness blockers and are not cancelled unless explicitly owned. Treat `allRequestsStopped: false`, `allTasksStopped: false`, `requestCancellation.timedOut: true`, or a `termination_unverified` result as unresolved evidence and report it; do not claim that all background work stopped. If the user also asks to cancel its scheduled successor, call `cancel_scheduled_continuation` separately and complete its exact native-host deletion receipt flow.

## Scheduled wake

1. Call `claim_scheduled_continuation` first with the normal **600-second lease**; do not request a longer lease. Do no workspace mutation beforehand. The runtime accepts a confirmed cloud wake up to **120 seconds early** so observed native-host jitter does not consume the one-time wake without a handoff. While this run is genuinely active, checkpoint and fenced-mutation activity slide the lease forward, capped by the scheduled handoff deadline; inactivity does not renew it.
2. Handle the returned outcome exactly:

   - `terminal_noop`: the durable goal is already terminal. Create no successor and let this already-firing one-time host task return naturally so the host can mark the run completed. Do **not** disable, pause, delete, or reschedule the current wake as a substitute for natural completion.
   - `already_claimed`: another run consumed it; do not mutate.
   - `not_due`: do not mutate or create a replacement. This means the host fired outside the bounded early-jitter window. Use the returned `taskUpdateRequest.schedule` verbatim to move the same native host task back to its safe UTC due time when the host permits it, then record `rescheduled` with the host-reported absolute `dueAt`. Do not treat the early firing as future recovery coverage.
   - `receipt_required`: reconcile the exact native task first; record `created`, `create_failed`, or `create_uncertain` truthfully.
   - `successor_required`: a prior acquired response ended before the already-reserved successor received a confirmed host receipt. If the result includes `scheduleRequest` (a fresh reservation or a truthfully failed create with no native ID), create that exact native task and record its receipt; do not prepare a duplicate. If `reason` is `native_task_receipt_missing`, `native_task_creation_uncertain`, or `native_task_id_already_recorded`, reconcile the exact host metadata/receipt first and never create blindly. A stale `create_failed` reservation may be refreshed to a new +2 due only after its absence is truthful, then retried with the returned request.
   - `reschedule_required`: this wake collided with a worker that is still active or whose liveness is not trustworthy enough for takeover. The result is explicitly `handoffReady: false` / `currentWakeMayReturn: false`. Do **not** create a replacement task. Update `taskUpdateRequest.nativeTaskId`, the exact same confirmed one-time cloud task, to `taskUpdateRequest.schedule` at +2 minutes, explicitly keep the native task enabled, record `rescheduled` with the host-reported absolute `dueAt`, re-read the continuation as `scheduled`, then let the current wake return naturally. Repeat collisions without a retry limit until claim acquires the goal or the goal is terminal. If the native update fails or is uncertain, record that truth and do not pretend future recovery coverage exists.
   - `acquired`, including `orphan_recovered`: the claim transaction atomically reserves a fresh `prepared` successor at the fail-safe +2-minute handoff and returns it with its `scheduleRequest`, `handoffReady: false`, and `currentWakeMayReturn: false`. Do **not** call `prepare_scheduled_continuation` again. Create the native one-time cloud task from the returned `scheduleRequest`, record `created` with its real host identity, require confirmed `scheduled` readback, then use the new lease token/generation as `goalLease` and continue from the durable checkpoint without waiting for user input.

3. If exact ChatGPT host metadata later proves that the recorded native one-time task already **ran/was consumed** but the durable continuation is still in a pending/live state because claim never completed, reconcile it with `record_scheduled_continuation_receipt(outcome: consumed)` and the exact native host run receipt. `consumed` means only that the host task is no longer pending; it does **not** mean the goal work completed. If the goal is still active, reserve and create a fresh successor after reconciliation. This is crash recovery for a missed claim. Normal worker collisions are handled by `reschedule_required`, which defers the exact same confirmed native task by +2 minutes so collision recovery never depends on creating a new Scheduled Task from inside an automation response.

## Collision and orphan safety

- Collision never calls `finish_goal`, marks the goal blocked, or creates a replacement task. lnwjud keeps the same continuation/nativeTaskId and moves it to `reschedule_required` with a +2-minute `pendingDueAt`; the host must update that exact task and keep it enabled before the wake returns.
- A successfully rescheduled same native task is the future successor. Repeated collisions keep the same nativeTaskId and move it forward by +2 minutes again, with no retry cap; each update must be confirmed by a truthful `rescheduled` receipt before relying on it.
- Live fenced calls and managed task/process states are worker-liveness evidence. MCP session equality and elapsed time are not.
- Active or unknown liveness fails closed into a same-native-task +2-minute reschedule; it never depends on nested Scheduled Task creation.
- Orphan takeover requires two unchanged trustworthy no-worker probes at least 120 seconds apart, the same revision/generation/activity sequence, no live fenced calls, and all tracked tasks terminal or absent. The orphan probe state carries forward across same-task reschedules; recovery uses CAS and increments lease generation.
- Full Bypass skips application approval/scope gates, but it does **not** skip durable rolling-goal ownership. If a live scheduled-goal mutation fence exists for the workspace, `ToolRegistry` requires the current `goalLease` even under Full Bypass; a stale/missing proof must fail before mutation. Ordinary unscheduled Full Bypass calls remain lease-free when no rolling fence exists.

## Verified completion

1. Before deciding the work is done, wait for every active task ID to reach a terminal state and inspect its result. Clear stale task IDs in the final checkpoint.
2. Re-run the acceptance evidence required by the goal. A generated artifact or passing subtest alone is not terminal proof unless it satisfies the goal.
3. Call `finish_goal` with the current lease and revision even when no schedule exists or scheduling was disabled.
4. If `finish_goal` returns `status: active` with `completionState: pending_native_cleanup`, do not report completion. Follow its exact `scheduledTaskCancellation` instruction through the native ChatGPT host, record the matching native deletion or run receipt, require the continuation to be `cancelled` or `superseded`, then call `finish_goal` again with the unchanged active-goal revision.
5. Call `get_goal` and require `completed`, `failed`, or `blocked`, and require `completionState: completed` from the final `finish_goal` result. If the goal is still `active`, continue cleanup/work; do not report completion.
6. If the current one-time wake already fired and claim returns `terminal_noop` (or cancellation metadata says `already_fired`), do not delete, disable, pause, or reschedule that current host task. End the wake naturally so the host can mark its one-time run completed. Never use pause/disable as fake deletion or completion proof.
7. Never report cancellation as successful, and never report completion while deletion/run reconciliation is failed, uncertain, unverified, or still required. Never create another successor after terminal state.

## Invocation on another machine

Use `$lnwjud-scheduled-continuation` when the client exposes the bundled skill by name. Otherwise call `skills_list`, select the source-qualified `lnwjud-scheduled-continuation`, call `skills_read`, and follow it. A typical request is:

```text
Use $lnwjud-scheduled-continuation in workspace <path>. Create or resume goalKey <stable-key>, do the requested work autonomously until get_goal is terminal, then cancel the exact remaining successor and report once.
```

Do not expose raw lease tokens, credentials, private source text, or internal session IDs in native task prompts or status reports.
