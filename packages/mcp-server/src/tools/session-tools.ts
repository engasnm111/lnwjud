import { z } from 'zod';
import { Redactor } from '@lnwjud/audit';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { IncrementalVerifier } from '../incremental-verifier.js';
import { withCapabilityOwnerMetadata } from '../request-scope.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const DEFAULT_TRACKER_PATH = 'docs/PHASE_PROGRESS.md';
const DEFAULT_MAX_DIFF_BYTES = 16_000;
const MAX_TRACKER_EXCERPT_CHARS = 4_000;
const MAX_BACKGROUND_TASKS = 8;
const MAX_TASK_RECEIPT_CHARS = 1_200;
const MAX_TASK_RECEIPT_LINES = 12;
const redactor = new Redactor();

interface SourceIssue {
  readonly operation: string;
  readonly code: string;
}

type SourceObservation<T> =
  | { readonly status: 'ready'; readonly value: T; readonly errors: readonly SourceIssue[] }
  | { readonly status: 'unavailable' | 'unknown'; readonly value: null; readonly errors: readonly SourceIssue[] };

interface BackgroundTaskObservation {
  readonly status: 'ready' | 'partial' | 'unavailable' | 'unknown';
  readonly receipts: readonly Record<string, unknown>[];
  readonly errors: readonly SourceIssue[];
  readonly omittedTasks: number;
  readonly exclusiveWriterBlocked?: boolean;
}

const recordSchema = z.record(z.string(), z.unknown());
const goalHandoffSchema = z.object({
  goalId: z.string().min(1).max(128),
  goalKey: z.string(),
  workspaceId: z.string().min(1).max(128),
  status: z.enum(['active', 'completed', 'cancelled', 'failed', 'blocked']),
  revision: z.number().int().nonnegative(),
  userIntentRevision: z.number().int().nonnegative(),
  objective: z.string(),
  currentPhase: z.string(),
  plan: z.object({ steps: z.array(recordSchema) }),
  acceptanceCriteria: z.array(recordSchema),
  blockers: z.array(z.string()),
  trackedTasks: z.array(recordSchema),
  nextAction: z.string(),
  lastCheckpoint: recordSchema.nullable().optional(),
  updatedAt: z.string().optional(),
  terminalSummary: z.string().optional(),
  terminalEvidence: z.array(recordSchema).optional(),
  terminalAt: z.string().optional(),
  currentContextCapsuleId: z.string().optional(),
  engineering: recordSchema.optional(),
});
const capsuleHandoffSchema = z.object({
  id: z.string().min(1).max(128),
  goalId: z.string().optional(),
  sourceGoalRevision: z.number().int().nonnegative(),
  sourceUserIntentRevision: z.number().int().nonnegative(),
  previousCapsuleId: z.string().optional(),
  payload: recordSchema,
  createdAt: z.string(),
});
const taskSnapshotSchema = z.object({
  task_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'cancelled', 'termination_unverified']),
  durable: z.boolean().optional(),
  started_at: z.string().max(128).optional(),
  finished_at: z.string().max(128).optional(),
  exit_code: z.number().int().optional(),
  error: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

const sessionHandoffSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  goalId: z.string().trim().min(1).max(128).optional(),
  verifyTransfer: z.boolean().optional(),
  trackerPath: z.string().trim().min(1).max(4096).optional(),
  maxDiffBytes: z.number().int().min(1_000).max(100_000).optional(),
}).strict();

const verifyIncrementalSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  userConfirmed: z.boolean().optional(),
}).strict();

export function sessionTools(context: McpToolContext, verifier: IncrementalVerifier): McpToolDefinition[] {
  return [
    defineTool({
      name: 'session_handoff',
      description: 'Create recovery state for the selected durable goal or the most recent goal in this workspace, with bounded task and Git state. Pass goalId and verifyTransfer to require an exact source receipt, released goal and workspace writer leases, no live schedule or unknown blocking jobs, and clear native writer admission. The transfer receipt is read-only and grants no writer access. The next executor must acquire its own authorized lease and revalidate evidence.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: sessionHandoffSchema,
      handler: async (input, signal) => createSessionHandoff(context, input, signal),
    }),
    defineTool({
      name: 'verify_incremental',
      description: 'Run the detected project typecheck only when the current git status/diff fingerprint changed. Starting a new verification process requires explicit user confirmation in standard mode; trusted Full Bypass skips that lnwjud gate. Returns cache=hit when unchanged and cache=miss after a new verification. Prefer this during iterative edits; use project_test/project_lint/project_build only when that specific verification is needed. For full suites or packaging expected to exceed ~5 minutes, launch a durable shell background task and record its task_id in the tracker.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: verifyIncrementalSchema,
      handler: async (input, signal, authorization) => verifier.verify(context, input.workspaceId, signal, input.userConfirmed === true, authorization),
    }),
  ];
}

export async function createSessionHandoff(
  context: McpToolContext,
  input: z.infer<typeof sessionHandoffSchema>,
  signal: AbortSignal,
): Promise<Result<Record<string, unknown>>> {
  if (signal.aborted) return cancelledHandoff();
  const trackerPath = input.trackerPath ?? DEFAULT_TRACKER_PATH;
  const maxDiffBytes = input.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;

  const goals = context.services.goals;
  if (input.verifyTransfer === true && input.goalId === undefined) return err(appError('INVALID_INPUT', 'Verified transfer requires an exact goalId.'));
  const goalListSchema = z.object({ goals: z.array(goalHandoffSchema.refine((goal) => goal.workspaceId === input.workspaceId)) });
  const explicitGoal = input.goalId === undefined ? null : await observeSource('requested_goal', goals === undefined
    ? undefined : (): Promise<Result<unknown>> => goals.getGoal(context.actor, { goalId: input.goalId! }),
  goalHandoffSchema.refine((goal) => goal.workspaceId === input.workspaceId && goal.goalId === input.goalId));
  if (explicitGoal !== null && explicitGoal.value === null) return err(appError('CONFLICT', 'The exact goal is unavailable in the requested workspace.'));
  const activeGoals = explicitGoal === null ? await observeSource('active_goals', goals === undefined ? undefined : (): Promise<Result<unknown>> => goals.listGoals(context.actor, {
    workspaceId: input.workspaceId,
    status: 'active',
    limit: 5,
  }), goalListSchema) : null;
  if (signal.aborted) return cancelledHandoff();
  const activeGoal = explicitGoal?.value ?? activeGoals?.value?.goals[0];
  const latestGoals = activeGoal == null
    ? await observeSource('latest_goals', goals === undefined ? undefined : (): Promise<Result<unknown>> => goals.listGoals(context.actor, { workspaceId: input.workspaceId, limit: 1 }), goalListSchema)
    : null;
  const goalState = activeGoal ?? latestGoals?.value?.goals[0] ?? null;
  const goalErrors = [...(activeGoals?.errors ?? []), ...(latestGoals?.errors ?? [])];
  const goalObservation = {
    status: goalErrors.length === 0 ? 'ready' : goalState === null ? (latestGoals?.status ?? activeGoals?.status ?? 'unavailable') : 'partial',
    errors: goalErrors,
  };
  if (signal.aborted) return cancelledHandoff();
  const capsules = await observeSource('context_capsule', goals === undefined || goalState === null ? undefined : (): Promise<Result<unknown>> => goals.listContextCapsules(context.actor, goalState.goalId, 1),
    z.array(capsuleHandoffSchema.refine((capsule) => capsule.goalId === undefined || capsule.goalId === goalState?.goalId)));
  const capsuleState = capsules.value?.[0] ?? null;
  const goalExcerpt = goalState === null ? '' : formatGoalHandoff(goalState, capsuleState, capsules.status);
  if (signal.aborted) return cancelledHandoff();

  const file = context.services.file;
  const tracker = await observeSource('legacy_tracker', file === undefined ? undefined : (): Promise<Result<unknown>> => file.readFile(context.actor, input.workspaceId, { path: trackerPath }),
    z.object({ content: z.string(), encoding: z.literal('utf8').optional() }));
  const trackerExcerpt = tracker.value === null ? '' : compactTracker(tracker.value.content);
  if (signal.aborted) return cancelledHandoff();

  const git = context.services.git;
  const unavailableGit = (): Result<never> => err(appError('INTERNAL_ERROR', 'Git service is unavailable for recovery'));
  const status = git === undefined
    ? unavailableGit()
    : await git.status(context.actor, input.workspaceId, signal).catch(unavailableGit);
  if (signal.aborted) return cancelledHandoff();
  const unstaged = git === undefined
    ? unavailableGit()
    : await git.diff(context.actor, input.workspaceId, { maxBytes: maxDiffBytes }, signal).catch(unavailableGit);
  if (signal.aborted) return cancelledHandoff();
  const staged = git === undefined
    ? unavailableGit()
    : await git.diff(context.actor, input.workspaceId, { staged: true, maxBytes: maxDiffBytes }, signal).catch(unavailableGit);
  if (signal.aborted) return cancelledHandoff();
  const gitErrors = [{ operation: 'status', result: status }, { operation: 'unstaged_diff', result: unstaged }, { operation: 'staged_diff', result: staged }]
    .flatMap(({ operation, result }) => result.ok ? [] : [{ operation, error: { code: result.error.code } }]);
  let gitState: 'ready' | 'partial' | 'unavailable' = 'partial';
  if (gitErrors.length === 0) gitState = 'ready';
  else if (gitErrors.length === 3) gitState = 'unavailable';

  let transfer: Record<string, unknown> | undefined;
  if (input.verifyTransfer === true && goalState !== null) {
    if (goals?.inspectEngineeringHandoff === undefined || context.services.workspaceWriterLease === undefined || gitState !== 'ready') {
      return err(appError('CONFLICT', 'The host cannot verify the checkout, goal and writer state for transfer.'));
    }
    const verified = await goals.inspectEngineeringHandoff(context.actor, input.workspaceId, goalState.goalId, goalState.revision);
    if (!verified.ok) return verified;
    transfer = { kind: 'host_observed', ...verified.value, goalRevision: goalState.revision, nextExecutorMustAcquireWriterLease: true };
  }
  const backgroundTasks = await readBackgroundTasks(context, input.workspaceId, signal);
  if (signal.aborted) return cancelledHandoff();
  if (transfer !== undefined) {
    const writer = await context.services.workspaceWriterLease!.inspect(input.workspaceId);
    if (!writer.ok) return writer;
    if (writer.value.state !== 'unleased' || writer.value.activeCalls !== 0 || backgroundTasks.exclusiveWriterBlocked !== false) {
      return err(appError('CONFLICT', 'Release the workspace writer lease and inspect recovery_status for active or unresolved reservations before transfer.', true));
    }
  }
  const changedFiles = status.ok ? [...new Set(status.value.entries.map((entry) => entry.path))].sort() : [];
  const diffSummary = compactDiff(unstaged.ok ? unstaged.value.patch : '', staged.ok ? staged.value.patch : '', maxDiffBytes);
  const hasCheckpointResumeContext = goalState !== null
    && isRecord(goalState.lastCheckpoint)
    && isRecord(goalState.lastCheckpoint.resumeContext);
  const prompt = buildHandoffPrompt({
    goalExcerpt,
    trackerPath,
    trackerExcerpt,
    trackerAvailable: tracker.status === 'ready',
    goalObservationStatus: goalObservation.status,
    changedFiles,
    gitState,
    gitStatusAvailable: status.ok,
    diffSummary,
    backgroundTasks,
  });
  const recoveryReceipt = buildRecoveryReceipt(goalState, backgroundTasks.receipts);

  return ok({
    prompt,
    recovery_state: prompt,
    recovery_format: 'task_state',
    recovery_receipt: recoveryReceipt,
    persistent_instructions: false,
    ...(transfer === undefined ? {} : { transfer }),
    source_priority: goalState === null
      ? ['git_workspace', 'legacy_tracker']
      : hasCheckpointResumeContext
        ? ['durable_goal', 'checkpoint_resume_context', 'context_capsule', 'git_workspace', 'legacy_tracker']
        : ['durable_goal', 'context_capsule', 'git_workspace', 'legacy_tracker'],
    goal_state: goalState,
    context_capsule: capsuleState,
    source_observations: {
      durable_goal: goalObservation,
      context_capsule: { status: capsules.status, errors: capsules.errors },
      legacy_tracker: { status: tracker.status, errors: tracker.errors },
    },
    tracker_path: trackerPath,
    tracker_available: tracker.status === 'ready',
    tracker_excerpt: trackerExcerpt,
    changed_files: changedFiles,
    git_state: { status: gitState, errors: gitErrors },
    git_status: status.ok ? status.value.entries : null,
    git_diff: {
      unstaged: unstaged.ok ? unstaged.value.patch : null,
      staged: staged.ok ? staged.value.patch : null,
      truncated: unstaged.ok && staged.ok ? unstaged.value.truncated || staged.value.truncated : null,
    },
    background_tasks: backgroundTasks.receipts,
    background_tasks_state: { status: backgroundTasks.status, errors: backgroundTasks.errors, omitted_tasks: backgroundTasks.omittedTasks },
  });
}

async function observeSource<T>(
  operation: string,
  read: (() => Promise<Result<unknown>>) | undefined,
  schema: z.ZodType<T>,
): Promise<SourceObservation<T>> {
  if (read === undefined) return { status: 'unavailable', value: null, errors: [{ operation, code: 'PROVIDER_UNAVAILABLE' }] };
  try {
    const result = await read();
    if (!isRecord(result) || typeof result.ok !== 'boolean') return { status: 'unknown', value: null, errors: [{ operation, code: 'MALFORMED_RESULT' }] };
    if (!result.ok) {
      const code = isRecord(result.error) && typeof result.error.code === 'string' && /^[A-Z_]{1,64}$/.test(result.error.code)
        ? result.error.code : 'PROVIDER_ERROR';
      return { status: 'unavailable', value: null, errors: [{ operation, code }] };
    }
    const parsed = schema.safeParse(result.value);
    return parsed.success
      ? { status: 'ready', value: parsed.data, errors: [] }
      : { status: 'unknown', value: null, errors: [{ operation, code: 'MALFORMED_RESULT' }] };
  } catch {
    return { status: 'unavailable', value: null, errors: [{ operation, code: 'PROVIDER_REJECTED' }] };
  }
}

async function readBackgroundTasks(
  context: McpToolContext,
  workspaceId: string,
  signal: AbortSignal,
): Promise<BackgroundTaskObservation> {
  const capabilities = context.services.capabilities;
  const listed = await observeSource('task_list', capabilities === undefined || signal.aborted ? undefined : (): Promise<Result<unknown>> => capabilities.execute('shell', withCapabilityOwnerMetadata({
    operation: 'list',
    workspaceId,
    limit: MAX_BACKGROUND_TASKS,
  }, context.actor), signal), z.object({
    tasks: z.array(z.unknown()),
    admission: z.object({ status_basis: z.literal('held_reservations_not_process_liveness'), exclusive_writer_blocked: z.boolean() }).optional(),
  }));
  if (listed.value === null) return { status: listed.status, receipts: [], errors: listed.errors, omittedTasks: 0 };
  const selected: z.infer<typeof taskSnapshotSchema>[] = [];
  const errors: SourceIssue[] = [];
  let omittedTasks = Math.max(0, listed.value.tasks.length - MAX_BACKGROUND_TASKS);
  for (const task of listed.value.tasks.slice(0, MAX_BACKGROUND_TASKS)) {
    const parsed = taskSnapshotSchema.safeParse(task);
    if (!parsed.success || parsed.data.durable === undefined) {
      errors.push({ operation: 'task_list', code: 'MALFORMED_TASK' });
      omittedTasks += 1;
    } else if (parsed.data.durable === true) selected.push(parsed.data);
  }
  const receipts = await Promise.all(selected.map(async (task) => {
    const observed = await observeSource('task_status', capabilities === undefined || signal.aborted ? undefined : (): Promise<Result<unknown>> => capabilities.execute('shell', withCapabilityOwnerMetadata({
      operation: 'status',
      workspaceId,
      task_id: task.task_id,
      tail_lines: MAX_TASK_RECEIPT_LINES,
      include_stdout: true,
      include_stderr: true,
    }, context.actor), signal), taskSnapshotSchema.refine((snapshot) => snapshot.task_id === task.task_id));
    return {
      receipt: { ...taskReceipt(observed.value ?? task), observation_status: observed.status === 'ready' ? 'ready' : 'partial',
        status_observation: { status: observed.status, errors: observed.errors } },
      errors: observed.errors,
    };
  }));
  errors.push(...receipts.flatMap((entry) => entry.errors));
  const exclusiveWriterBlocked = listed.value.admission?.exclusive_writer_blocked;
  return { status: errors.length === 0 && omittedTasks === 0 ? 'ready' : 'partial', receipts: receipts.map((entry) => entry.receipt), errors, omittedTasks,
    ...(exclusiveWriterBlocked === undefined ? {} : { exclusiveWriterBlocked }) };
}

function taskReceipt(task: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: task.task_id,
    state: task.state,
    ...(task.started_at === undefined ? {} : { started_at: task.started_at }),
    ...(task.finished_at === undefined ? {} : { finished_at: task.finished_at }),
    ...(task.exit_code === undefined ? {} : { exit_code: task.exit_code }),
    ...(typeof task.error === 'string' && task.error.trim().length > 0 ? { error: compactTaskOutput(task.error) } : {}),
    ...(typeof task.stdout === 'string' ? { stdout_tail: compactTaskOutput(task.stdout) } : {}),
    ...(typeof task.stderr === 'string' ? { stderr_tail: compactTaskOutput(task.stderr) } : {}),
  };
}

function compactTaskOutput(value: string): string {
  const normalized = redactor.redactText(value);
  if (normalized.length <= MAX_TASK_RECEIPT_CHARS) return normalized;
  return `... task output truncated ...\n${normalized.slice(-MAX_TASK_RECEIPT_CHARS)}`;
}

function formatGoalHandoff(goal: Record<string, unknown>, capsule: Record<string, unknown> | null, capsuleStatus: SourceObservation<unknown>['status']): string {
  const evidenceList = (value: unknown, limit = 20): string => {
    if (!Array.isArray(value) || value.length === 0) return '(none)';
    return value.slice(0, limit).map((entry) => {
      if (!isRecord(entry)) return 'invalid evidence';
      return `${String(entry.kind ?? 'note')}: ${String(entry.value ?? '')}`;
    }).join(' | ');
  };
  const plan = isRecord(goal.plan) && Array.isArray(goal.plan.steps)
    ? goal.plan.steps.map((step) => {
        if (!isRecord(step)) return '- invalid plan entry';
        return `- [${String(step.status ?? 'unknown')}] ${String(step.id ?? '?')}: ${String(step.title ?? '')}${step.summary === undefined ? '' : ` — ${String(step.summary)}`}`;
      }).join('\n')
    : '- no plan';
  const acceptance = Array.isArray(goal.acceptanceCriteria)
    ? goal.acceptanceCriteria.map((criterion) => {
        if (!isRecord(criterion)) return '- invalid acceptance entry';
        return `- [${String(criterion.status ?? 'unknown')}] ${String(criterion.id ?? '?')}: ${String(criterion.title ?? '')}; evidence: ${evidenceList(criterion.evidence, 10)}`;
      }).join('\n')
    : '- none';
  const blockers = Array.isArray(goal.blockers) && goal.blockers.length > 0 ? goal.blockers.map((entry) => `- ${String(entry)}`).join('\n') : '- none';
  const trackedTasks = Array.isArray(goal.trackedTasks) && goal.trackedTasks.length > 0
    ? goal.trackedTasks.slice(0, 50).map((entry) => {
        if (!isRecord(entry)) return '- invalid tracked task';
        return `- ${String(entry.taskId ?? '?')} [${String(entry.provider ?? 'unknown')}/${String(entry.role ?? 'unknown')}] cancelWithGoal=${String(entry.cancelWithGoal ?? false)}`;
      }).join('\n')
    : '- none';
  const checkpoint = isRecord(goal.lastCheckpoint) ? goal.lastCheckpoint : null;
  const resumeContext = checkpoint !== null && isRecord(checkpoint.resumeContext) ? checkpoint.resumeContext : null;
  const resumeList = (key: string): string => {
    const value = resumeContext?.[key];
    return Array.isArray(value) && value.length > 0 ? value.slice(0, 20).map(String).join(' | ') : '(none)';
  };
  const resumeCommands = resumeContext !== null && Array.isArray(resumeContext.commands) && resumeContext.commands.length > 0
    ? resumeContext.commands.slice(0, 20).map((entry) => {
        if (!isRecord(entry)) return 'invalid command record';
        return `${String(entry.status ?? 'unknown')}: ${String(entry.command ?? '')}${entry.exitCode === undefined ? '' : ` (exit ${String(entry.exitCode)})`}${entry.result === undefined ? '' : ` => ${String(entry.result)}`}`;
      }).join(' | ')
    : '(none)';
  const capsulePayload = capsule !== null && isRecord(capsule.payload) ? capsule.payload : null;
  const capsuleList = (key: string): string => {
    const value = capsulePayload?.[key];
    return Array.isArray(value) && value.length > 0 ? value.slice(0, 10).map(String).join(' | ') : '(none)';
  };
  return [
    `Goal: ${String(goal.goalKey ?? '')} (${String(goal.goalId ?? '')})`,
    `Goal status: ${String(goal.status ?? 'unknown')}`,
    `Goal revision: ${String(goal.revision ?? '')}; user intent revision: ${String(goal.userIntentRevision ?? '')}`,
    `Objective: ${String(goal.objective ?? '')}`,
    `Current phase: ${String(goal.currentPhase ?? '')}`,
    'Plan:',
    plan,
    'Acceptance criteria:',
    acceptance,
    'Blockers:',
    blockers,
    'Tracked goal tasks:',
    trackedTasks,
    `Next action: ${String(goal.nextAction ?? '')}`,
    ...(goal.terminalSummary === undefined ? [] : [
      `Terminal summary: ${String(goal.terminalSummary)}`,
      `Terminal evidence: ${evidenceList(goal.terminalEvidence)}`,
      `Terminal at: ${String(goal.terminalAt ?? '')}`,
    ]),
    checkpoint === null ? 'Latest checkpoint: none' : `Latest checkpoint: revision ${String(checkpoint.revision ?? '')} — ${String(checkpoint.summary ?? '')}`,
    ...(checkpoint === null ? [] : [
      `Checkpoint evidence: ${evidenceList(checkpoint.evidence)}`,
    ]),
    ...(resumeContext === null ? ['Checkpoint resume context: none recorded'] : [
      `Checkpoint changed files: ${resumeList('changedFiles')}`,
      `Checkpoint commands: ${resumeCommands}`,
      `Checkpoint decisions: ${resumeList('decisions')}`,
      `Checkpoint failed attempts: ${resumeList('failedAttempts')}`,
      `Checkpoint pending validation: ${resumeList('pendingValidation')}`,
      `Checkpoint resume prerequisites: ${resumeList('resumePrerequisites')}`,
      `Checkpoint state facts: ${evidenceList(resumeContext.stateFacts)}`,
      `Checkpoint artifacts: ${evidenceList(resumeContext.artifacts)}`,
    ]),
    capsule === null ? `Context capsule: ${capsuleStatus === 'ready' ? 'none published' : `${capsuleStatus}; no verified capsule observation`}` : `Context capsule: ${String(capsule.id ?? '')} (goal rev ${String(capsule.sourceGoalRevision ?? '')}, intent rev ${String(capsule.sourceUserIntentRevision ?? '')})`,
    ...(capsulePayload === null ? [] : [
      `Capsule user steering: ${capsuleList('userSteering')}`,
      `Capsule completed work: ${capsuleList('completedWork')}`,
      `Capsule remaining work: ${capsuleList('remainingWork')}`,
      `Capsule decisions: ${capsuleList('decisions')}`,
      `Capsule validation: ${evidenceList(capsulePayload.validation, 10)}`,
      `Capsule artifacts: ${evidenceList(capsulePayload.artifacts, 10)}`,
      `Capsule next action: ${String(capsulePayload.nextAction ?? '')}`,
    ]),
  ].join('\n');
}

function buildHandoffPrompt(input: {
  readonly goalExcerpt: string;
  readonly trackerPath: string;
  readonly trackerExcerpt: string;
  readonly trackerAvailable: boolean;
  readonly goalObservationStatus: string;
  readonly changedFiles: readonly string[];
  readonly gitState: 'ready' | 'partial' | 'unavailable';
  readonly gitStatusAvailable: boolean;
  readonly diffSummary: string;
  readonly backgroundTasks: BackgroundTaskObservation;
}): string {
  const tasks = input.backgroundTasks.receipts.length === 0
    ? input.backgroundTasks.status === 'ready'
      ? '- none recorded by the durable shell task store'
      : `- task store ${input.backgroundTasks.status}; no verified empty-store observation`
    : input.backgroundTasks.receipts.map(formatTaskReceipt).join('\n');
  const changed = input.changedFiles.length === 0 ? '(clean)' : input.changedFiles.join(', ');
  return [
    'Recovery state from lnwjud durable task state.',
    'This is task state only, not persistent user or agent instructions.',
    input.goalExcerpt.length === 0
      ? input.goalObservationStatus === 'ready'
        ? 'No Durable Goal recovery receipt was found; use the Git/workspace fallback below.'
        : `Durable Goal observation ${input.goalObservationStatus}; use the available workspace evidence below.`
      : input.goalExcerpt,
    '',
    `Legacy tracker (${input.trackerPath}):`,
    input.trackerAvailable ? (input.trackerExcerpt || '(tracker is empty)') : '(tracker unavailable; this is not fatal when durable goal/Git state exists)',
    '',
    `Git state ${input.gitState}.`,
    `Current Git changes: ${input.gitStatusAvailable ? changed : '(unknown; Git status unavailable)'}`,
    input.diffSummary.length === 0
      ? `Git diff summary: ${input.gitState === 'ready' ? '(no diff)' : '(unknown; one or more Git reads unavailable)'}`
      : `Git diff summary:\n${input.diffSummary}`,
    '',
    'Durable task receipts (status-only recovery; no task was relaunched):',
    `Task observation ${input.backgroundTasks.status}. Omitted entries ${input.backgroundTasks.omittedTasks}.`,
    tasks,
    '',
    'Resume rules:',
    '1. If a Durable Goal is present, read/reacquire or claim that same goal before any mutation; do not create a duplicate goal.',
    '2. Prefer the latest Context Capsule plus the latest durable goal revision over legacy tracker prose.',
    '3. If a task or goal is terminal, summarize the persisted receipt first; do not rerun completed work merely to recreate a missing assistant summary.',
    '4. Recover live durable jobs by task_id with shell status/logs/result; do not tight-poll or duplicate a live job.',
    '5. Inspect Git status/diff only as needed for the current phase and continue from the recorded next action.',
    '6. Do not redo completed phases unless verification proves a regression or the user explicitly requests a rerun.',
    '7. Do not persist this recovery state as USER_INSTRUCTIONS or generic handoff history.',
    '8. Never use browser/DOM automation to create, type into, switch, or resume ChatGPT conversations; use supported host-native turns/chats only.',
  ].join('\n');
}

function formatTaskReceipt(task: Record<string, unknown>): string {
  const exit = task.exit_code === undefined ? '' : ` exit=${String(task.exit_code)}`;
  const finished = task.finished_at === undefined ? '' : ` finished=${String(task.finished_at)}`;
  const details = [
    typeof task.error === 'string' ? `error: ${task.error}` : '',
    typeof task.stdout_tail === 'string' ? `stdout tail:\n${task.stdout_tail}` : '',
    typeof task.stderr_tail === 'string' ? `stderr tail:\n${task.stderr_tail}` : '',
  ].filter((value) => value.length > 0);
  return [`- ${String(task.task_id)} (${String(task.state ?? 'unknown')}${exit}${finished})${task.observation_status === 'partial' ? ' latest status unavailable; showing the prior list receipt' : ''}`, ...details.map((value) => `  ${value}`)].join('\n');
}

function buildRecoveryReceipt(
  goal: Record<string, unknown> | null,
  backgroundTasks: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const status = typeof goal?.status === 'string' ? goal.status : undefined;
  let mode = 'report_terminal_goal';
  if (status === 'active') mode = 'resume_active_goal';
  else if (status === undefined) mode = 'workspace_fallback';
  return {
    mode,
    rerun_completed_work: false,
    ...(goal === null ? {} : {
      goal_id: goal.goalId,
      goal_key: goal.goalKey,
      goal_status: goal.status,
      goal_revision: goal.revision,
      next_action: goal.nextAction,
      ...(goal.terminalSummary === undefined ? {} : { terminal_summary: goal.terminalSummary }),
      ...(goal.terminalEvidence === undefined ? {} : { terminal_evidence: goal.terminalEvidence }),
      ...(goal.terminalAt === undefined ? {} : { terminal_at: goal.terminalAt }),
    }),
    task_receipts: backgroundTasks,
  };
}

function compactTracker(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= MAX_TRACKER_EXCERPT_CHARS) return normalized;
  const half = Math.floor((MAX_TRACKER_EXCERPT_CHARS - 64) / 2);
  return `${normalized.slice(0, half)}\n... tracker excerpt truncated ...\n${normalized.slice(-half)}`;
}

function compactDiff(unstaged: string, staged: string, maxBytes: number): string {
  const combined = [
    unstaged.trim().length === 0 ? '' : `UNSTAGED\n${unstaged.trim()}`,
    staged.trim().length === 0 ? '' : `STAGED\n${staged.trim()}`,
  ].filter((value) => value.length > 0).join('\n\n');
  const maxChars = Math.min(maxBytes, 4_000);
  return combined.length <= maxChars ? combined : `${combined.slice(0, maxChars)}\n... diff truncated for handoff ...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cancelledHandoff(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Session handoff was cancelled', true));
}
