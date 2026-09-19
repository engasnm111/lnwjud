# Native Automation Engine Design

Date: 2026-09-19
Status: M0 architecture contract
Branch: `feat/native-automation-engine`
Base: `1e112c1a9bd8c0fecec9d7326fa22a2747769af2`

## Context

lnwjud already has the hard runtime primitives needed for long-running coding automation:
durable goals, revision-CAS checkpoints, lease fencing, tracked background tasks,
scheduled continuation, durable shell tasks, recovery state, audit/activity logging,
recipes, skills, and ToolRegistry authorization.

The missing piece is a native coordinator that turns those primitives into one
deterministic, recoverable, multi-milestone execution model. The current hook
registry stores lifecycle descriptors only, and the current plugin registry stores
validated metadata/state only; neither is an executable orchestration runtime.

This design adds a Native Automation Engine as an additive application subsystem.
It does not replace primitive tools, Durable Goal Continuation, MCP Tasks, or
Native ChatGPT Scheduled Tasks.

## Goals

1. Execute a user-authorized multi-milestone plan until a verified terminal outcome.
2. Survive MCP reconnects, ChatGPT turn boundaries, runtime restarts, and task timeouts.
3. Reuse the existing durable goal as the ownership and user-intent authority.
4. Make milestone transitions deterministic and revision-fenced.
5. Track background jobs by durable task identity and never restart them merely because a poll timed out.
6. Distinguish observation timeout, task timeout, transport loss, lease expiry, and ambiguous side effects.
7. Advance to the next ready milestone automatically after verification and checkpointing.
8. Preserve existing ToolRegistry authorization, Active Project scope, command policy, audit, and recovery behavior.
9. Make browser/desktop control and repository/folder deletion denyable by runtime policy, not prompt convention.
10. Remain upstream-friendly: the subsystem must be separable enough to rebase future lnwjud releases.

## Non-goals

- Replacing ChatGPT or another model with an in-process autonomous model.
- Creating a second scheduler.
- Treating a checkpoint as a reason to stop useful work.
- Claiming exactly-once external side effects when the provider cannot prove them.
- Bypassing ToolRegistry, permission profiles, goal leases, Active Project rules, or command policy.
- Rewriting the existing durable-goal schema into an automation-specific goal system.

## Architectural position

The engine sits between MCP/CLI entrypoints and existing application services.

```text
ChatGPT / Codex / CLI
        |
        v
Automation MCP tools
        |
        v
Native Automation Engine
  |       |        |        |
  |       |        |        +--> Verification / acceptance evaluator
  |       |        +-----------> Background task supervisor
  |       +--------------------> Milestone state machine
  +----------------------------> Execution policy
        |
        v
GoalContinuationService + GoalMutationFenceService
        |
        v
ToolRegistry / application services / task backends
        |
        v
SQLite + audit/activity + Live Logs
```

The Automation Engine is an application-layer coordinator. Domain types remain
policy-neutral. Storage persists authoritative automation state. MCP adapters
validate and translate requests but do not own orchestration semantics.

## Package boundaries

### `packages/domain`

Add policy-neutral automation types and state-transition errors. No SQLite, MCP,
Electron, React, or concrete tool calls.

### `packages/application`

Own the orchestration state machine, milestone selection, task supervision,
recovery decisions, acceptance evaluation, and policy decision interface.

### `packages/storage`

Persist automation runs, milestone attempts, journal events, and idempotency /
dispatch receipts with transactional CAS.

### `packages/mcp-server`

Expose automation tools and route every child operation back through ToolRegistry.
No child mutation may bypass the same authorization/fence path used by primitive tools.

### `packages/audit`

Emit parent automation run ID, milestone ID, attempt ID, child call ID, transition,
recovery reason, and policy decision as bounded structured metadata.

### `apps/desktop`

Later milestones may project read-only run/milestone state into a dashboard.
The desktop renderer does not become orchestration authority.

## Authority model

The existing durable goal is the root authority.

Every automation run is bound 1:1 to:
- `goalId`
- `workspaceId`
- stable `goalKey`
- current `userIntentRevision`
- current goal `revision`
- current lease token/generation for mutation

The Automation Engine must not invent an independent lease. Workspace-changing
automation dispatch is valid only while the existing goal mutation fence accepts
the current `GoalLeaseProof`.

User steering continues to advance `userIntentRevision`. An automation transition
based on an older intent revision fails closed and must reload the latest goal
before continuing.

Full Bypass does not bypass the automation ownership fence, matching the current
goal-mutation-fence contract.

## Durable state model

### AutomationRun

```ts
type AutomationRunStatus =
  | 'planned'
  | 'running'
  | 'waiting_task'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

An AutomationRun stores identity, goal binding, revision, status, current milestone,
policy profile, current attempt, timestamps, and last durable recovery decision.

It deliberately does not duplicate the goal objective, user steering, acceptance
criteria, blockers, or goal lease. Those remain authoritative in GoalRecord.

### AutomationMilestone

A milestone is a DAG node with:
- stable milestone ID
- title
- dependency IDs
- execution intent
- verification requirements
- completion evidence requirements
- optional retry policy for proven-safe operations

AutomationMilestone is the execution graph, not a second user-intent authority.
GoalPlan remains the durable user-facing plan/acceptance surface. The engine may
project coarse milestone progress back through the existing goal-plan APIs, while
DAG dependencies, attempts, dispatch receipts, and recovery state remain native
automation data.

Milestone status:

```text
pending -> ready -> running
                    |
                    +-> waiting_task
                    |
                    +-> verifying
                           |
                           +-> completed
                           +-> retry_ready
                           +-> blocked
                           +-> failed
```

Only dependency-complete milestones may become `ready`. Selection is deterministic:
topological order, then declaration order as the tie breaker.

### AutomationAttempt

Every milestone execution gets an immutable attempt ID. Attempts record:
- based-on run revision
- based-on goal revision / user intent revision
- child invocation IDs
- durable task bindings
- dispatch reservation / observation receipts
- verification evidence
- terminal disposition

A retry always creates a new attempt. It never overwrites the historical attempt.

## Append-only journal

Every meaningful transition writes an append-only AutomationEvent in the same
transaction as the authoritative run mutation.

Minimum event fields:
- event ID
- run ID
- milestone ID when applicable
- attempt ID when applicable
- run revision before / after
- transition type
- reason code
- bounded metadata
- createdAt

Required transition families include:
`run_created`, `milestone_ready`, `attempt_started`, `task_bound`,
`task_observed`, `verification_started`, `verification_passed`,
`verification_failed`, `checkpoint_committed`, `milestone_completed`,
`recovery_reconciled`, `policy_denied`, `run_paused`, and `run_terminal`.

The journal is audit/recovery evidence. It is not authority to bypass GoalRecord
revision/lease checks.

## Transaction and CAS rules

Every AutomationRun mutation requires `expectedRevision`.

For workspace-changing dispatch:
1. read current AutomationRun;
2. read current GoalRecord;
3. validate expected run revision and user intent revision;
4. validate the current goal lease/fence;
5. reserve the attempt/dispatch identity transactionally;
6. dispatch exactly once through ToolRegistry;
7. persist observation/receipt;
8. checkpoint the durable goal after meaningful progress.

If step 6 has an ambiguous external outcome, the attempt becomes
`dispatch_unresolved`. It must be reconciled before any retry.

A storage transaction may atomically update automation tables and automation
journal rows. It must not pretend to atomically include an external filesystem,
Git, network, host UI, or child MCP side effect.

## Work-conserving orchestration loop

A normal worker behaves as:

```text
acquire/reacquire goal lease
  -> recover existing automation state
  -> reconcile bound tasks / unresolved attempts
  -> select deterministic next ready milestone
  -> execute or bind background task
  -> observe terminal result when available
  -> verify acceptance for the milestone
  -> checkpoint durable goal
  -> mark milestone completed
  -> immediately select next ready milestone
  -> repeat until terminal, paused, or truly blocked
```

A checkpoint is persistence, not a turn boundary.

The engine may return/yield only when:
- the user must make a decision or grant new authority;
- an external dependency is truly blocking;
- a durable background job is still running and no independent work is ready;
- the host turn ends unavoidably and scheduled continuation coverage is truthful;
- the automation run is terminal.

## Background task supervisor

The engine reuses existing durable task providers.

A bound task is recorded both:
- in AutomationAttempt with provider/task identity; and
- in GoalRecord `trackedTasks` when it participates in goal liveness.

Roles remain:
- `blocking_job`: build/test/package/migration/watch operation required for progress.
- `supporting_service`: dev server or shared service that must not block takeover by itself.

Rules:
1. Never start the same logical task merely because status/result polling timed out.
2. Read the existing task by task ID first after reconnect or new turn.
3. A terminal task result must be consumed before deciding retry/failure.
4. `termination_unverified` or unknown liveness fails closed.
5. Cancellation targets only task bindings explicitly owned by the automation/goal.
6. Task timeout is not the same thing as MCP request timeout.

## Timeout and recovery taxonomy

### Observation timeout

A bounded status/result request expired, but the durable task may still be running.
Action: preserve task ID, checkpoint observation state if useful, and poll later.
No payload restart.

### Task deadline timeout

The durable backend reports the task itself as timed out.
Action: consume terminal evidence, classify retry safety, and create a new attempt
only when policy explicitly allows the logical operation to be repeated.

### Transport interruption

MCP/HTTP/tunnel disconnect with a durable operation already launched.
Action: reconnect, read durable state, then reconcile. Do not infer failure from
the disconnected transport.

### Goal lease expiry

Action: reacquire the same `workspaceId + goalKey` under existing liveness rules.
A new lease generation invalidates stale mutation authority.

### Ambiguous side effect

A mutating provider may have succeeded although the response was lost.
Action: mark unresolved, inspect provider/state evidence, and prohibit blind retry.

## Retry classes

```text
SAFE_READ
  automatic bounded retry allowed

IDEMPOTENT_LOCAL_STATE
  retry allowed with CAS/idempotency key

DURABLE_TASK_OBSERVATION
  retry observation only; never restart payload

WORKSPACE_MUTATION
  no automatic replay unless the exact operation has a proven idempotency contract

OPAQUE_EXTERNAL_MUTATION
  never blind retry; reconcile first

DESTRUCTIVE_OPERATION
  denied by this fork's default automation policy
```

Retry budget is attached to an attempt policy, not implemented as an unbounded loop.
Backoff affects observation cadence only; increasing a timeout is not a root-cause fix.

## Execution policy

The first fork-specific policy profile is `coding_guarded`.

Default hard denies for automated dispatch:
- browser / DOM / CDP control
- computer-use / desktop input
- keyboard/mouse input events
- user workspace directory deletion
- local repository deletion
- recursive project-folder deletion
- `delete_file` against repository content
- `git clean`
- destructive `git reset --hard`
- destructive restore/remove forms that discard project work

Explicit human authorization required:
- push
- force-push is denied by default even with ordinary push authority
- merge
- tag
- release/publish
- deploy
- remote destructive mutation
Allowed by default when normal ToolRegistry policy also allows them:
- read/search/index
- source edits inside the active project
- dependency install/update when requested by the milestone
- tests/typecheck/lint/build
- local non-destructive Git status/diff/commit operations
- durable background build/test/package jobs

The automation policy is an additional restriction layer. It may deny an operation
that ToolRegistry would otherwise allow, but it may never grant an operation that
ToolRegistry denies.

Policy decisions must be structured and auditable with a stable reason code.

## Scheduled continuation integration

The Automation Engine does not create another scheduler.

It reuses the existing rolling durable-goal contract:
- one Native ChatGPT hourly recurring watchdog for an active goal;
- `claim_scheduled_continuation` is the first durable continuation action on wake;
- only `recurring_acquired` grants automatic native-automation recovery authority;
- ordinary recurring wakes reuse the same native task;
- `worker_busy_noop`, `already_claimed`, and orphan-probe no-op outcomes never advance automation state;
- stale orphan takeover follows existing bounded liveness rules before automation recovery is attempted;
- scheduler transport degradation does not fail the work goal by itself.

A successful recurring claim may include an additive `automationResume` projection
derived entirely from persisted GoalRecord, AutomationRun, dispatch receipt, and
durable task state. The worker does not reconstruct milestones or task identity
from chat text. A waiting task is observed by its exact provider/task ID; an
unresolved dispatch is reconciled before any retry; and a ready attempt advances
only to a durable dispatch boundary until an explicit execution descriptor is
supplied through `automation_run`.

Crash windows are reconciled from durable facts rather than replayed:
- task completion after disconnect is consumed from the existing bound task;
- a GoalRecord verification checkpoint committed before AutomationRun milestone
  completion is recognized by its exact run/milestone/attempt evidence marker;
- a successful `finish_goal` committed before AutomationRun terminal persistence
  is recovered from terminal GoalRecord readback;
- duplicate scheduled delivery performs no automation mutation.

Historical one-time continuation rows remain compatibility-only and do not
auto-resume native automation until their existing scheduler handoff contract is safe.

## Verification and completion

Each milestone defines deterministic verification requirements.

Verification may include:
- exact test command and exit code
- typecheck/lint/build
- file/hash evidence
- Git diff assertions
- domain-specific read-only checks

A milestone cannot become `completed` until verification evidence is persisted.

The run cannot become `completed` until:
1. all required milestones are completed;
2. goal acceptance criteria are completed;
3. goal blockers are empty;
4. no `blocking_job` remains running/unknown;
5. no attempt remains `dispatch_unresolved`;
6. required final review has passed;
7. `finish_goal(status: completed)` succeeds;
8. terminal goal state is read back and confirmed.

## Native MCP surface

Initial tools:

```text
automation_create
automation_status
automation_events
automation_run
automation_observe
automation_recover
automation_verify
automation_finalize
automation_pause
automation_resume
```

`automation_create` binds to an existing or newly acquired durable goal and persists
the milestone DAG. `automation_run` is immediate-return orchestration: it advances
useful synchronous work and may return durable task bindings when the next step is
background work.

`automation_status` and `automation_events` are read-only. `automation_observe` records one exact durable-task observation; `automation_recover` reconciles a previously unresolved dispatch without blind replay. Successful task dispatch is projected into durable GoalRecord tracked tasks. `automation_verify` checkpoints durable goal progress before committing milestone completion. `automation_finalize` performs final acceptance and final-review checkpointing, invokes the existing durable goal finish path, and marks the AutomationRun completed only after terminal GoalRecord readback confirms success.

Pause/resume changes orchestration eligibility only. It does not delete the goal,
kill shared services, or cancel the Native ChatGPT recurring watchdog unless the
separate scheduling contract explicitly requests that change.

## Extension strategy

M0 explicitly does not make the existing hook/plugin descriptor registries execute code.

Automation extensibility will use typed in-process interfaces first:

```ts
interface AutomationPolicyPort {
  decide(input: AutomationPolicyInput): Promise<AutomationPolicyDecision>;
}

interface AutomationVerifier {
  verify(input: AutomationVerificationInput): Promise<AutomationVerificationResult>;
}

interface AutomationTaskObserver {
  observe(binding: AutomationTaskBinding): Promise<AutomationTaskObservation>;
}
```

A later milestone may expose a reviewed plugin SDK or child-MCP extension adapter.
External extensions may propose plans/verifications, but they do not receive direct
lease authority and cannot bypass ToolRegistry.

Forking core is justified here because the required atomic orchestration semantics
belong inside the application/storage boundary, not in the descriptor-only hook registry.

## Persistence proposal

Additive SQLite tables:

- `automation_runs`
- `automation_milestones`
- `automation_attempts`
- `automation_task_bindings`
- `automation_events`
- `automation_dispatch_receipts`

All tables use stable IDs and explicit versions/revisions. Foreign keys bind runs
to `goals.id` and children to their run/milestone/attempt.

Large logs stay in existing task/activity stores; automation tables store bounded
references/evidence only.

Migrations are additive. Existing goals without an automation run remain valid and
behave exactly as before.

## Recovery algorithm

On `automation_run` / resume / scheduled wake:

1. on a scheduled wake, claim the existing continuation first and require the
   existing lease/liveness contract to return `recurring_acquired`;
2. load current goal and automation run from durable storage;
3. reject terminal/cancelled mismatch states and validate current user-intent revision;
4. synchronize the AutomationRun goal revision only after the claimed GoalRecord
   proves the same user intent;
5. inspect unresolved dispatch receipts and reconcile them before any replay;
6. inspect every bound blocking task by exact provider/task ID and consume terminal
   task evidence without launching a replacement;
7. if verification was durably checkpointed before a crash, complete the same
   milestone from its exact persisted verification marker;
8. if GoalRecord became terminal before AutomationRun terminal persistence,
   reconcile the run from terminal readback;
9. recompute DAG readiness deterministically and advance only to a safe dispatch boundary;
10. checkpoint any recovered durable facts and continue useful work.

Busy/duplicate scheduled claims are idempotent no-ops. Recovery never creates,
retimes, or replaces the recurring watchdog, never steals a healthy lease, and
never infers an external payload that is not durably represented.

Recovery must be idempotent. Running recovery twice over the same observations
must produce the same authoritative state and no duplicate side effect.

## Observability

Every run must be traceable from Live Logs without reading raw SQLite.

Required dimensions:
- run ID / goal ID / workspace ID
- milestone / attempt
- transition and reason
- child tool/task identity
- lease generation, never raw lease token
- policy decision
- timeout/recovery classification
- verification outcome
- elapsed duration and retry count

Raw secrets, raw lease tokens, and private chain-of-thought are never recorded.
Context capsules may contain bounded decisions/results only under the existing goal contract.

## Compatibility guarantees

1. Primitive tools remain callable.
2. Existing `run_goal` workflows remain valid without creating an automation run.
3. Existing scheduled continuation remains authoritative for turn-to-turn wakeup.
4. Existing task IDs and MCP Tasks semantics remain unchanged.
5. No browser/desktop capability is removed globally; the new default automation policy denies its automated use.
6. No repository/folder deletion path is added.
7. The installed v5.3.0 application is not modified by developing this branch.
8. Upstream `main` remains the merge base; fork-specific behavior is isolated behind additive modules and policy profiles.

## Failure philosophy

The engine optimizes for truthful state, not cosmetic success.

Unknown means unknown.
Dispatched-but-unconfirmed is not failed.
Prepared is not executed.
Process exit without a terminal task record is not success.
Checkpoint written without verification is not milestone completion.
A scheduler problem is not a work failure.

## Test strategy

### Domain tests
- DAG validation and deterministic ready selection
- legal/illegal transitions
- retry classification
- policy reason codes

### Storage integration
- create/run CAS
- attempt reservation idempotency
- append-only event transactionality
- crash between reservation and observation
- unresolved dispatch replay protection
- concurrent worker conflict

### Application integration
- multi-milestone happy path
- background task completes after reconnect
- observation timeout without restart
- task deadline timeout
- lease expiry and generation rotation
- user steering revision conflict
- blocking/supporting task liveness
### Fault injection
- crash immediately before child dispatch
- crash immediately after child dispatch but before receipt persistence
- crash after task terminal but before checkpoint
- storage failure during checkpoint
- duplicate scheduled wake
- stale worker attempts mutation after takeover
- transport disconnect during long build
- verification failure after successful mutation
- ambiguous external mutation outcome

### Contract tests
- MCP schemas/descriptions
- ToolRegistry child authorization preservation
- audit metadata
- scheduled-continuation compatibility
- no browser/desktop dispatch under `coding_guarded`
- no repository/folder delete dispatch under `coding_guarded`

## Implementation milestones

M0 — architecture contract and invariants.
M1 — domain model + SQLite schema/repositories.
M2 — application orchestrator + deterministic milestone DAG.
M3 — durable task supervisor + timeout/recovery taxonomy.
M4 — runtime adapter + native MCP tool surface + `coding_guarded` policy/fence integration.
M5 — durable-goal/checkpoint integration + final acceptance/terminal readback.
M6 — scheduled-continuation resume projection + crash-window reconciliation.
M7 — observability, audit projection, Live Logs/dashboard read model.
M8 — fault-injection suite, packaging isolation, migration/upgrade verification.

### M7 acceptance criteria

M7 is complete when:
- committed automation journal events are projected into the existing audit/Live Logs pipeline without changing authoritative run state;
- the read model exposes run/goal/workspace, milestone/attempt, transition/reason, child tool/task identity, lease generation, policy decision, recovery classification, verification outcome, elapsed duration, and retry count;
- child dispatches carry a stable internal call ID derived from the durable dispatch receipt so journal events correlate to the exact child Live Log entry;
- raw lease tokens, idempotency keys, execution payloads, raw secrets, and private reasoning are excluded from the dashboard/read model and automation audit details;
- dashboard projection is bounded and read-only, and observability/audit failure cannot roll back committed automation work;
- existing primitive tools, durable goals, task IDs, and scheduled continuation semantics remain unchanged;
- targeted audit/application/storage/MCP/Desktop integration tests, typecheck, lint, build, and diff review pass.

### M8 acceptance criteria

M8 is complete when:
- a dedicated fault-injection suite covers both dispatch crash windows, task-terminal-before-checkpoint recovery, checkpoint storage failure, duplicate scheduled wake, stale worker takeover fencing, long-task observation transport loss, verification failure after mutation, and ambiguous external mutation outcomes;
- no injected ambiguity causes blind child relaunch or treats unknown state as success;
- a v018-style database upgrades additively through migrations 019 and 020 while preserving existing settings, workspaces, and durable goals, and a pre-migration backup remains restorable at schema version 18;
- reopening an already-upgraded database is idempotent and does not create a second migration backup;
- Desktop packaging contains compiled native-automation code and migrations but excludes mutable SQLite state, backups, and automation runtime state from installation resources;
- Desktop and direct STDIO automation persistence remain rooted in their runtime data path rather than package resources or the source checkout;
- the packaging verification command includes the native-automation isolation contract;
- targeted M8 tests, full affected-package tests, lint, typecheck, build, packaging verification, and diff review pass.

Each milestone must finish with targeted tests, diff review, and a durable checkpoint
before advancing. A checkpoint never implies a mandatory stop if the same worker
can continue safely.

## M0 acceptance criteria

M0 is complete when:
- this design matches current package boundaries and durable-goal semantics;
- no second lease/scheduler/goal authority is introduced;
- timeout/retry semantics prohibit blind replay of ambiguous mutations;
- browser/desktop control is denied in the default automation policy;
- repository/folder deletion is denied in the default automation policy;
- compatibility with existing goals/tasks/scheduled continuation is explicit;
- M1 has a concrete domain/storage target;
- the working tree contains documentation only and passes `git diff --check`.

No push, merge, release, deploy, or installed-application replacement is part of M0.
