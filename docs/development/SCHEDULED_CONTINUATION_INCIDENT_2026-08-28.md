# Scheduled continuation incident review — 2026-08-28

## Outcome

The reported failure is confirmed. The original run created a durable goal and one-time successors, but the autonomous chain stopped and later reported completion without making the goal terminal. The fixed 25-minute cadence also delayed short final work that actually took seconds to a few minutes.

This document records the evidence inspected before the repair, the root causes, and the acceptance contract for the replacement behavior. Times below are UTC. No lease token, credential, or private prompt content is recorded.

## Evidence inspected

- Referenced ChatGPT task `Continue lnwjud goal` (`6a911692-2d80-83ec-ae2f-8cb111f36d99`), including the first request, scheduled follow-ups, later manual “continue” requests, and the final completion response.
- Durable goal, continuation, activity, and background-task records in `%APPDATA%\lnwjud\lnwjud.sqlite`.
- Current service, repository, MCP tool descriptions/schema, packaged skill, Electron packaging configuration, and skill catalog implementation.

The database was inspected read-only. The historical stale goal was intentionally not rewritten by this code change.

## Observed timeline

| Time | Evidence |
| --- | --- |
| ~05:04 | Goal `6ce9750d…` was created for `FIRST_RUN_PERMISSION_FLOW_AUDIT.md`. |
| 05:29:56 → 05:32:07 | Generation 1 successor was due and claimed. |
| 05:57:28 → 05:58:36 | Generation 2 successor was due and claimed. |
| 06:23:47 → 06:26:25 | Generation 3 successor was due and claimed. |
| 06:29:37 → 06:30:15 | Acceptance task `d543f905…` actually completed successfully in about 38 seconds. The checkpoint still retained it as active. |
| 06:51:10 | Activity contains `get_scheduled_continuation`, but no successful claim for the generation due at 06:51:46. The 36-second gap is consistent with an early native wake being rejected by the old exact-due check; this is an inference from the durable timestamps. |
| 06:51:46 → 08:02:47 | Generation 4 was not claimed for about 71 minutes. It resumed only after another user message. |
| 08:28:42 → 08:29:08 | A later generation was claimed under a different native one-time task. |
| 08:30:54 → 08:34:37 | The Windows Setup + Portable packaging task `235f24d8…` completed successfully in about 3 minutes 43 seconds, far below the fixed 25-minute delay. |
| After final response | The assistant told the user the work was complete, but the authoritative goal remained `active`, revision 15, phase `verify`, with `terminal_at = NULL` and the completed packaging task still in `activeTaskIds`. No matching `finish_goal` activity exists. |

## Root causes

1. **Twenty-five minutes was encoded as a fixed value.** The application type/normalizer, MCP schema, successor prompt, skill, and documentation all made `25` the only accepted delay. A final task lasting under four minutes therefore had the same watchdog as an open-ended build.
2. **One-time wakes could arrive slightly early and be lost.** Claim used an exact `now >= dueAt` comparison. The host had no bounded jitter tolerance, so an early one-time wake could observe `not_due`, return, and never retry.
3. **The command-tool instruction explicitly encouraged abandonment.** `shell` and `wsl_exec` told the model to stop polling after one or two running checks and return control. It did not require a scheduled handoff or continued bounded waiting when the user asked for babysitting.
4. **Terminal closure was not a hard response gate.** The skill did not state that a completion response is invalid while `get_goal` is still `active`, and disabling future scheduling was not clearly separated from finishing the current goal.
5. **The skill was source-checkout-only.** Setup and Portable did not package the repository skill, so another machine could not reliably invoke it.
6. **`skills_list` was incomplete.** Discovery omitted Codex global/plugin roots and some workspace roots, and its depth limit skipped valid deeply nested global skills.

## Repair contract

- `successorDelayMinutes` accepts integer values from 2 through 25. Omitted delay now fails safe to **2 minutes**; 5/10/25-minute watchdogs must be chosen explicitly while the current run is genuinely continuing. Twenty-five remains only the maximum watchdog.
- The current run continues immediately after arming the successor. A schedule is recovery insurance, not permission to stop. If the host turn is already ending or no worker will remain after the response, prepare directly at +2 (or move the same confirmed task to +2) instead of leaving a long-delay successor.
- If a host turn must end while the goal is still active, a still-pending future native task may be moved to `now+2`; a task that is already firing is never re-armed and requires a fresh successor after the wake is consumed.
- Claim accepts native wake jitter up to 120 seconds early. A firing wake is a consumed one-time ticket: real worker collisions, an expired lease with a running `blocking_job`, or unknown blocking-task liveness fail closed into a **fresh** one-time cloud successor at `now+2`; same-task updates are reserved for still-pending future tasks handled by `expedite_scheduled_continuation`.
- If exact ChatGPT host metadata proves that a native one-time task ran/was consumed while durable state still says pending/live because claim did not complete, record an exact `consumed` host-run receipt. This clears the stale live continuation/fence without claiming goal completion; an active goal then creates a fresh successor.
- A user request to stop scheduling cancels only the successor. The current run must still wait for recorded background tasks, inspect terminal results, complete acceptance, call `finish_goal`, and confirm `get_goal` is terminal.
- No completion response is valid while `get_goal` reports `active`.
- Setup and Portable package the same `lnwjud-scheduled-continuation` skill under `resources/agent-skills`.
- `skills_list` returns the union of bundled, configured, machine-global, Codex plugin, and active-workspace skills, including nested and symlinked skill collections. `skills_read` continues to require an unambiguous name or source-qualified ID.

## Invocation on another machine

When the client exposes installed skills directly:

```text
Use $lnwjud-scheduled-continuation in workspace D:\projects\my-app. Create or resume goalKey release-audit, do the requested work autonomously until get_goal is terminal, then cancel the exact remaining successor and report once.
```

When it does not, instruct the agent to call `skills_list`, select the source-qualified `lnwjud-scheduled-continuation`, call `skills_read`, and follow it. This is the same for Setup and Portable.

## Required verification

- Adaptive-delay, early-wake, collision, active-task waiting, and mandatory terminal-closure contract tests.
- Full application, storage, extensions, MCP-server, and packaging regression suites.
- Typecheck and Desktop build.
- Packaging contract asserts the bundled skill resource is included for both NSIS and Portable.
- Clean-machine smoke for Setup and Portable must call `skills_list`/`skills_read` and prove bundled + global + workspace skills coexist.
