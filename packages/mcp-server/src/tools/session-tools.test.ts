import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { IncrementalVerifier } from '../incremental-verifier.js';
import { sessionTools } from './session-tools.js';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test', sessionId: 'test-session' };

function findTool(context: McpToolContext, verifier: IncrementalVerifier, name: string): McpToolDefinition {
  const tool = sessionTools(context, verifier).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool;
}

const recoveryGoal = {
  goalId: 'goal-recovery', goalKey: 'recovery', workspaceId: 'workspace-1', objective: 'Keep completed work',
  status: 'active', revision: 9, userIntentRevision: 1, currentPhase: 'verify',
  plan: { steps: [] }, acceptanceCriteria: [], blockers: [], trackedTasks: [], nextAction: 'Continue validation',
  lastCheckpoint: { revision: 9, summary: 'Changes verified', resumeContext: { changedFiles: ['src/ไทย.ts'], pendingValidation: ['Release gate'] } },
};

function supplementalFixture(services: Record<string, unknown> = {}): McpToolContext {
  return {
    actor,
    contextEconomy: new ContextEconomyRuntime(),
    services: {
      goals: {
        async listGoals() { return ok({ goals: [recoveryGoal] }); },
        async listContextCapsules() { return ok([]); },
      },
      git: {
        async status() { return ok({ entries: [] }); },
        async diff() { return ok({ patch: '', truncated: false }); },
      },
      capabilities: { async execute() { return ok({ tasks: [] }); } },
      ...services,
    },
  } as unknown as McpToolContext;
}

async function failedRead(mode: string): Promise<Result<unknown>> {
  if (mode === 'throw') throw new Error('secret=do-not-publish provider failed');
  if (mode === 'error') return err(appError('INTERNAL_ERROR', 'password=do-not-publish', true, { token: 'do-not-publish' }));
  return ok({ malformed: 'do-not-publish' });
}

describe('session tools', () => {
  it.each(['ready', 'native-blocker', 'lease-held', 'provider-missing'])('verifies an exact transfer with %s writer state', async (state) => {
    const head = 'a'.repeat(40);
    const context = supplementalFixture({
      goals: {
        async getGoal() { return ok({ ...recoveryGoal, engineering: { reviewFindings: [{ id: 'finding' }] } }); },
        async listContextCapsules() { return ok([]); },
        async inspectEngineeringHandoff() { return ok({ head, sourceDigest: 'b'.repeat(64), evidenceRevalidationRequired: true }); },
      },
      capabilities: { async execute() { return ok({
        tasks: [],
        ...(state === 'provider-missing' ? {} : {
          admission: { status_basis: 'held_reservations_not_process_liveness', exclusive_writer_blocked: state === 'native-blocker' },
        }),
      }); } },
      workspaceWriterLease: { async inspect() { return ok({ state: state === 'lease-held' ? 'active' : 'unleased', activeCalls: 0 }); } },
    });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({
      workspaceId: 'workspace-1', goalId: 'goal-recovery', verifyTransfer: true,
    }, new AbortController().signal);
    if (state === 'ready') {
      expect(response).toMatchObject({ ok: true, value: {
        goal_state: { engineering: { reviewFindings: [{ id: 'finding' }] } },
        transfer: { kind: 'host_observed', head, goalRevision: 9, evidenceRevalidationRequired: true, nextExecutorMustAcquireWriterLease: true },
      } });
    } else {
      expect(response).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
  });

  it.each(['  ไทย 😀\nDONE  ', ' \t\r\n  ', ''])('preserves exact bounded task output %j during recovery', async (output) => {
    const context = supplementalFixture({ capabilities: { async execute(_tool: string, request: Record<string, unknown>) {
      return request.operation === 'list' ? ok({ tasks: [{ task_id: 'exact-output', state: 'completed', durable: true }] })
        : ok({ task_id: 'exact-output', state: 'completed', durable: true, stdout: output, stderr: output, exit_code: 0 });
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: { background_tasks: [{ task_id: 'exact-output', stdout_tail: output, stderr_tail: output }] } });
  });
  it.each(['throw', 'error', 'malformed'])('keeps Goal/checkpoint recovery when a tracker read is %s', async (mode) => {
    const context = supplementalFixture({ file: { async readFile() { return failedRead(mode); } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: { goalId: 'goal-recovery', revision: 9, lastCheckpoint: recoveryGoal.lastCheckpoint },
      tracker_available: false,
      source_observations: { legacy_tracker: { status: mode === 'malformed' ? 'unknown' : 'unavailable' } },
    } });
    if (!response.ok) return;
    expect(JSON.stringify(response.value)).not.toContain('do-not-publish');
  });

  it.each(['throw', 'error', 'malformed'])('keeps Goal/checkpoint recovery when capsule lookup is %s', async (mode) => {
    const context = supplementalFixture({ goals: {
      async listGoals() { return ok({ goals: [recoveryGoal] }); },
      async listContextCapsules() { return failedRead(mode); },
    } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: { goalId: 'goal-recovery', revision: 9, lastCheckpoint: recoveryGoal.lastCheckpoint },
      context_capsule: null,
      source_observations: { context_capsule: { status: mode === 'malformed' ? 'unknown' : 'unavailable' } },
    } });
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint pending validation: Release gate'));
    expect(value.prompt).not.toEqual(expect.stringContaining('Context capsule: none published'));
    expect(JSON.stringify(response.value)).not.toContain('do-not-publish');
  });

  it.each(['missing', 'throw', 'error', 'malformed'])('reports task-store observation failure rather than empty store when provider is %s', async (mode) => {
    const context = supplementalFixture({ capabilities: mode === 'missing' ? undefined : { async execute(): Promise<Result<unknown>> { return failedRead(mode); } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: { goalId: 'goal-recovery', lastCheckpoint: recoveryGoal.lastCheckpoint },
      background_tasks: [],
      background_tasks_state: { status: mode === 'malformed' ? 'unknown' : 'unavailable' },
    } });
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.prompt).not.toEqual(expect.stringContaining('none recorded by the durable shell task store'));
    expect(JSON.stringify(value)).not.toContain('do-not-publish');
  });

  it('reports verified empty task store separately from unavailable observations', async () => {
    const response = await findTool(supplementalFixture(), new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: { background_tasks: [], background_tasks_state: { status: 'ready', errors: [] } } });
    if (!response.ok) return;
    expect((response.value as Record<string, unknown>).prompt).toEqual(expect.stringContaining('none recorded by the durable shell task store'));
  });

  it.each(['throw', 'error', 'malformed', 'wrong_identity'])('keeps independent task receipts when one status lookup is %s', async (mode) => {
    const signal = new AbortController().signal;
    const requests: Record<string, unknown>[] = [];
    const context = supplementalFixture({ capabilities: { async execute(name: string, request: Record<string, unknown>, receivedSignal: AbortSignal) {
      expect(name).toBe('shell');
      expect(receivedSignal).toBe(signal);
      requests.push(request);
      expect(request.metadata).toMatchObject({ 'lnwjud.taskOwner.v1': { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: 'workspace-1' } });
      if (request.operation === 'list') return ok({ tasks: [
        { task_id: 'task-good', durable: true, state: 'running' },
        { task_id: 'task-failed-observation', durable: true, state: 'running', started_at: '2026-10-12T01:00:00Z' },
      ] });
      if (request.task_id === 'task-good') return ok({ task_id: 'task-good', state: 'completed', exit_code: 0, stdout: 'ไทย 😀\nDONE' });
      if (mode === 'wrong_identity') return ok({ task_id: 'foreign-task', state: 'completed', stdout: 'foreign-output' });
      return failedRead(mode);
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: { goalId: 'goal-recovery' },
      background_tasks_state: { status: 'partial' },
      background_tasks: [
        { task_id: 'task-good', state: 'completed', exit_code: 0, stdout_tail: 'ไทย 😀\nDONE', observation_status: 'ready' },
        { task_id: 'task-failed-observation', state: 'running', started_at: '2026-10-12T01:00:00Z', observation_status: 'partial' },
      ],
    } });
    expect(requests.map((request) => request.operation)).toEqual(['list', 'status', 'status']);
    if (!response.ok) return;
    const serialized = JSON.stringify(response.value);
    expect(serialized).not.toContain('do-not-publish');
    expect(serialized).not.toContain('foreign-output');
    expect(serialized).not.toContain('foreign-task');
  });

  it.each(['completed', 'failed', 'blocked', 'cancelled'])('preserves a latest %s Goal while capsule observations fail', async (status) => {
    const goal = { ...recoveryGoal, status, terminalSummary: 'Persisted final receipt', terminalEvidence: [{ kind: 'task', value: 'verified-job' }] };
    const context = supplementalFixture({ goals: {
      async listGoals(_actor: unknown, input: Record<string, unknown>) { return ok({ goals: input.status === 'active' ? [] : [goal] }); },
      async listContextCapsules() { throw new Error('capsule unavailable'); },
    } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: goal,
      recovery_receipt: { mode: 'report_terminal_goal', goal_status: status, terminal_summary: 'Persisted final receipt' },
      source_observations: { durable_goal: { status: 'ready' }, context_capsule: { status: 'unavailable' } },
    } });
  });

  it('retains valid listed receipts and reports omitted malformed or excess entries without claiming an empty store', async () => {
    let statusReads = 0;
    const context = supplementalFixture({ capabilities: { async execute(_name: string, request: Record<string, unknown>) {
      if (request.operation === 'list') return ok({ tasks: [
        { task_id: 'valid', state: 'running', durable: true },
        { task_id: 'missing-durability', state: 'running' },
        null,
        ...Array.from({ length: 10 }, (_value, index) => ({ task_id: `ephemeral-${index}`, state: 'running', durable: false })),
      ] });
      statusReads += 1;
      return ok({ task_id: 'valid', state: 'completed', exit_code: 0, stdout: 'RESULT-BOUND' });
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      background_tasks_state: { status: 'partial', omitted_tasks: 7, errors: [{ operation: 'task_list', code: 'MALFORMED_TASK' }, { operation: 'task_list', code: 'MALFORMED_TASK' }] },
      background_tasks: [{ task_id: 'valid', state: 'completed', stdout_tail: 'RESULT-BOUND' }],
    } });
    expect(statusReads).toBe(1);
  });

  it('redacts secrets in bounded task tails and excludes unselected provider fields', async () => {
    const context = supplementalFixture({ capabilities: { async execute(_name: string, request: Record<string, unknown>) {
      if (request.operation === 'list') return ok({ tasks: [{ task_id: 'redacted', state: 'running', durable: true }] });
      return ok({ task_id: 'redacted', state: 'completed', exit_code: 0, token: 'hidden-extra', stdout: `${'x'.repeat(2000)}\nAPI_TOKEN=hidden-tail\nVISIBLE-END` });
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const serialized = JSON.stringify(response.value);
    expect(serialized).toContain('VISIBLE-END');
    expect(serialized).toContain('task output truncated');
    expect(serialized).not.toContain('hidden-extra');
    expect(serialized).not.toContain('hidden-tail');
    expect(serialized).not.toContain('x'.repeat(1201));
  });

  it('returns cancellation rather than a ready receipt if the caller aborts during status collection', async () => {
    const controller = new AbortController();
    const context = supplementalFixture({ capabilities: { async execute(_name: string, request: Record<string, unknown>, signal: AbortSignal) {
      expect(signal).toBe(controller.signal);
      if (request.operation === 'list') return ok({ tasks: [{ task_id: 'cancelled-observation', state: 'running', durable: true }] });
      controller.abort();
      throw new Error('cancelled');
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, controller.signal);
    expect(response).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it.each(['throw', 'error', 'malformed'])('preserves Git and task receipts when Goal discovery is %s', async (mode) => {
    const context = supplementalFixture({ goals: {
      async listGoals() { return failedRead(mode); },
      async listContextCapsules() { throw new Error('No selected Goal should query capsules'); },
    }, capabilities: { async execute(_name: string, request: Record<string, unknown>) {
      return request.operation === 'list'
        ? ok({ tasks: [{ task_id: 'independent-job', state: 'completed', durable: true }] })
        : ok({ task_id: 'independent-job', state: 'completed', exit_code: 0, stdout: 'ALREADY-DONE' });
    } } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: {
      goal_state: null,
      git_state: { status: 'ready' },
      source_observations: { durable_goal: { status: mode === 'malformed' ? 'unknown' : 'unavailable' } },
      background_tasks: [{ task_id: 'independent-job', state: 'completed', exit_code: 0, stdout_tail: 'ALREADY-DONE' }],
    } });
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.prompt).not.toEqual(expect.stringContaining('No Durable Goal recovery receipt was found'));
    expect(JSON.stringify(value)).not.toContain('do-not-publish');
  });

  it('does not start provider reads for a pre-cancelled handoff', async () => {
    let reads = 0;
    const context = supplementalFixture({ goals: { async listGoals() { reads += 1; return ok({ goals: [recoveryGoal] }); } } });
    const controller = new AbortController();
    controller.abort();
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, controller.signal);
    expect(response).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(reads).toBe(0);
  });

  it('keeps Git failure diagnostics bounded without echoing provider messages or details', async () => {
    const context = supplementalFixture({ git: {
      async status() { return err(appError('INTERNAL_ERROR', 'password=hidden-git-message', true, { token: 'hidden-git-details', value: 'x'.repeat(10000) })); },
      async diff() { return err(appError('INTERNAL_ERROR', 'secret=hidden-git-message', true, { token: 'hidden-git-details' })); },
    } });
    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, value: { goal_state: { goalId: 'goal-recovery' }, git_state: { status: 'unavailable', errors: [
      { operation: 'status', error: { code: 'INTERNAL_ERROR' } },
      { operation: 'unstaged_diff', error: { code: 'INTERNAL_ERROR' } },
      { operation: 'staged_diff', error: { code: 'INTERNAL_ERROR' } },
    ] } } });
    if (!response.ok) return;
    const serialized = JSON.stringify(response.value);
    expect(serialized).not.toContain('hidden-git');
    expect(serialized).not.toContain('x'.repeat(10000));
  });
  it('creates a same-chat handoff from the real tracker content, git changes, and durable task IDs', async () => {
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        file: {
          async readFile() {
            return ok({
              path: 'docs/PHASE_PROGRESS.md',
              content: '# Tracker\n## Next chat startup probe\nRUN-SMOKE-42\n## Current phase\nPhase budget guard',
              startLine: 1,
              endLine: 5,
            });
          },
        },
        git: {
          async status() {
            return ok({ entries: [{ path: 'packages/mcp-server/src/run-budget.ts', index: ' ', worktree: 'M' }] });
          },
          async diff(_actor: unknown, _workspaceId: string, request: { staged?: boolean }) {
            return ok({ patch: request.staged === true ? '' : '+RUN-BUDGET-DIFF', truncated: false });
          },
        },
        capabilities: {
          async execute(tool: string, request: Record<string, unknown>) {
            expect(tool).toBe('shell');
            expect(request.workspaceId).toBe('workspace-1');
            expect(request.metadata).toMatchObject({
              'lnwjud.taskOwner.v1': { clientId: 'test-client', sessionId: 'test-session', workspaceId: 'workspace-1' },
            });
            if (request.operation === 'list') {
              expect(request.limit).toBe(8);
              return ok({
                tasks: [
                  { task_id: 'durable-123', state: 'completed', durable: true, started_at: '2026-08-22T01:00:00.000Z' },
                  { task_id: 'ephemeral-1', state: 'running', durable: false },
                ],
              });
            }
            expect(request).toMatchObject({ operation: 'status', task_id: 'durable-123', tail_lines: 12 });
            return ok({
              task_id: 'durable-123', state: 'completed', durable: true,
              started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:00:05.000Z', exit_code: 0,
              stdout: `${'x'.repeat(1_400)}\nRESULT-42`,
            });
          },
        },
      },
    } as unknown as McpToolContext;

    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.tracker_excerpt).toContain('RUN-SMOKE-42');
    expect(value.changed_files).toContain('packages/mcp-server/src/run-budget.ts');
    expect(value.background_tasks).toEqual([expect.objectContaining({ task_id: 'durable-123', state: 'completed', exit_code: 0, stdout_tail: expect.stringContaining('RESULT-42') })]);
    expect(value.background_tasks).toEqual([expect.objectContaining({ stdout_tail: expect.stringContaining('task output truncated') })]);
    expect(value.prompt).toEqual(expect.stringContaining('Recovery state from lnwjud durable task state'));
    expect(value.recovery_state).toBe(value.prompt);
    expect(value.recovery_format).toBe('task_state');
    expect(value.persistent_instructions).toBe(false);
    expect(value.prompt).toEqual(expect.stringContaining('not persistent user or agent instructions'));
    expect(value.prompt).toEqual(expect.stringContaining('durable-123'));
    expect(value.prompt).toEqual(expect.stringContaining('Recover live durable jobs by task_id'));
    expect(value.prompt).toEqual(expect.stringContaining('do not rerun completed work'));
    expect(value.prompt).toEqual(expect.stringContaining('RESULT-42'));
    expect(value.recovery_receipt).toMatchObject({ mode: 'workspace_fallback', rerun_completed_work: false, task_receipts: [expect.objectContaining({ task_id: 'durable-123', state: 'completed' })] });
    expect(value.prompt).toEqual(expect.stringContaining('Do not redo completed phases'));
    expect(value.prompt).toEqual(expect.stringContaining('Never use browser/DOM automation'));
    expect(value.prompt).not.toEqual(expect.stringContaining('Before ending'));
  });

  it.each(['ready', 'missing', 'error', 'throw'])('preserves durable goal recovery when Git is %s and the legacy tracker is unavailable', async (gitMode) => {
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        goals: {
          async listGoals() {
            return ok({ goals: [{
              goalId: 'goal-v5', goalKey: 'v5', workspaceId: 'workspace-1', objective: 'Ship v5 safely', status: 'active', revision: 7,
              userIntentRevision: 2, currentPhase: 'verify', plan: { steps: [{ id: 'verify', title: 'Verify', status: 'in_progress' }] },
              acceptanceCriteria: [{ id: 'tests', title: 'Tests pass', status: 'pending', evidence: [{ kind: 'task', value: 'unit-tests-42' }] }], blockers: [], trackedTasks: [{ taskId: 'shell-verify-7', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }], nextAction: 'Run tests.',
              currentContextCapsuleId: 'capsule-v5', completedSteps: [], pendingSteps: [], activeTaskIds: [],
              lastCheckpoint: {
                revision: 7, summary: 'Implementation done; verification remains.', evidence: [{ kind: 'hash', value: 'abc123' }],
                resumeContext: {
                  changedFiles: ['src/runtime.ts'],
                  commands: [{ command: 'pnpm test:unit', status: 'passed', exitCode: 0, result: '42 passed' }],
                  decisions: ['Do not rerun implementation.'], failedAttempts: ['Old flaky probe discarded.'],
                  pendingValidation: ['Run release gate.'], resumePrerequisites: ['Keep current dev branch.'],
                  stateFacts: [{ kind: 'note', value: 'branch=dev HEAD=abc123' }], artifacts: [{ kind: 'path', value: 'dist/lnwjud-Setup-5.4.3.exe' }],
                },
              },
            }] });
          },
          async listContextCapsules() {
            return ok([{ id: 'capsule-v5', goalId: 'goal-v5', sourceGoalRevision: 7, sourceUserIntentRevision: 2,
              payload: { objective: 'Ship v5 safely', userSteering: ['No browser automation'], currentPhase: 'verify', plan: { steps: [] }, acceptanceCriteria: [],
                completedWork: ['Implementation'], remainingWork: ['Verification'], decisions: ['Native scheduled tasks only'], validation: [{ kind: 'task', value: 'focused tests passed' }], changedFiles: [], artifacts: [{ kind: 'path', value: 'capsule-artifact.txt' }], blockers: [], nextAction: 'Run tests.' },
              createdAt: '2026-09-15T00:00:00.000Z' }]);
          },
        },
        ...(gitMode === 'missing' ? {} : { git: {
          async status(): Promise<Result<unknown>> {
            if (gitMode === 'error') return err(appError('INTERNAL_ERROR', 'Git fixture unavailable'));
            if (gitMode === 'throw') throw new Error('Git fixture failed');
            return ok({ entries: [] });
          },
          async diff(): Promise<Result<unknown>> {
            if (gitMode === 'error') return err(appError('INTERNAL_ERROR', 'Git fixture unavailable'));
            if (gitMode === 'throw') throw new Error('Git fixture failed');
            return ok({ patch: '', truncated: false });
          },
        } }),
        capabilities: {
          async execute() { return ok({ tasks: [] }); },
        },
      },
    } as unknown as McpToolContext;

    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );
    expect(response).toMatchObject({
      ok: true,
      value: {
        source_priority: ['durable_goal', 'checkpoint_resume_context', 'context_capsule', 'git_workspace', 'legacy_tracker'],
        tracker_available: false,
        goal_state: { goalId: 'goal-v5', revision: 7, userIntentRevision: 2 },
        context_capsule: { id: 'capsule-v5', sourceGoalRevision: 7 },
      },
    });
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.prompt).toEqual(expect.stringContaining('Ship v5 safely'));
    expect(value.prompt).toEqual(expect.stringContaining('Native scheduled tasks only'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint commands: passed: pnpm test:unit (exit 0) => 42 passed'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint failed attempts: Old flaky probe discarded.'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint pending validation: Run release gate.'));
    expect(value.prompt).toEqual(expect.stringContaining('evidence: task: unit-tests-42'));
    expect(value.prompt).toEqual(expect.stringContaining('shell-verify-7 [shell/blocking_job] cancelWithGoal=true'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint evidence: hash: abc123'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint state facts: note: branch=dev HEAD=abc123'));
    expect(value.prompt).toEqual(expect.stringContaining('Checkpoint artifacts: path: dist/lnwjud-Setup-5.4.3.exe'));
    expect(value.prompt).toEqual(expect.stringContaining('Capsule validation: task: focused tests passed'));
    expect(value.prompt).toEqual(expect.stringContaining('Capsule artifacts: path: capsule-artifact.txt'));
    expect(value.prompt).toEqual(expect.stringContaining('Never use browser/DOM automation'));
    expect(value.git_state).toMatchObject({ status: gitMode === 'ready' ? 'ready' : 'unavailable' });
    if (gitMode !== 'ready') {
      expect(value.git_status).toBeNull();
      expect(value.prompt).toEqual(expect.stringContaining('Git state unavailable'));
      expect(value.prompt).not.toEqual(expect.stringContaining('Current Git changes: (clean)'));
    }
  });

  it('falls back to the latest terminal durable goal and returns its persisted receipt without rerunning work', async () => {
    const listRequests: Array<Record<string, unknown>> = [];
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        goals: {
          async listGoals(_actor: unknown, request: Record<string, unknown>) {
            listRequests.push(request);
            if (request.status === 'active') return ok({ goals: [] });
            return ok({ goals: [{
              goalId: 'goal-terminal', goalKey: 'release-fix', workspaceId: 'workspace-1', objective: 'Finish release fix', status: 'completed', revision: 4,
              userIntentRevision: 0, currentPhase: 'completed', plan: { steps: [{ id: 'ship', title: 'Ship', status: 'completed', summary: 'Done' }] },
              acceptanceCriteria: [], blockers: [], trackedTasks: [], nextAction: '', currentContextCapsuleId: undefined,
              completedSteps: [], pendingSteps: [], activeTaskIds: [], lastCheckpoint: { revision: 4, summary: 'Everything finished.', evidence: [{ kind: 'hash', value: 'deadbeef' }] },
              updatedAt: '2026-09-23T03:13:23.070Z', terminalSummary: 'Release fix completed and verified.',
              terminalEvidence: [{ kind: 'task', value: 'CI 35813031616 succeeded' }], terminalAt: '2026-09-23T03:13:23.070Z',
            }] });
          },
          async listContextCapsules() { return ok([]); },
        },
        git: {
          async status() { return ok({ entries: [] }); },
          async diff() { return ok({ patch: '', truncated: false }); },
        },
        capabilities: { async execute() { return ok({ tasks: [] }); } },
      },
    } as unknown as McpToolContext;

    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(listRequests).toEqual([
      { workspaceId: 'workspace-1', status: 'active', limit: 5 },
      { workspaceId: 'workspace-1', limit: 1 },
    ]);
    expect(value.goal_state).toMatchObject({ goalId: 'goal-terminal', status: 'completed', terminalSummary: 'Release fix completed and verified.' });
    expect(value.recovery_receipt).toMatchObject({
      mode: 'report_terminal_goal', rerun_completed_work: false, goal_id: 'goal-terminal', goal_status: 'completed', terminal_summary: 'Release fix completed and verified.',
    });
    expect(value.prompt).toEqual(expect.stringContaining('Goal status: completed'));
    expect(value.prompt).toEqual(expect.stringContaining('Terminal summary: Release fix completed and verified.'));
    expect(value.prompt).toEqual(expect.stringContaining('Terminal evidence: task: CI 35813031616 succeeded'));
    expect(value.prompt).toEqual(expect.stringContaining('do not rerun completed work'));
  });

  it('returns verify_incremental cache hit for unchanged diff and miss after the diff changes', async () => {
    let patch = '+first-diff';
    let starts = 0;
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async status() {
            return ok({ entries: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }] });
          },
          async diff(_actor: unknown, _workspaceId: string, request: { staged?: boolean }) {
            return ok({ patch: request.staged === true ? '' : patch, truncated: false });
          },
        },
        process: {
          async startProjectCommand() {
            starts += 1;
            return ok({
              processId: `typecheck-${starts}`,
              executable: 'pnpm',
              args: ['typecheck'],
              cwd: 'E:/repo',
              state: 'exited' as const,
              startedAt: '2026-08-22T01:00:00.000Z',
              finishedAt: '2026-08-22T01:00:01.000Z',
              exitCode: 0,
            });
          },
          async status() {
            throw new Error('status should not be needed for an already-terminal start result');
          },
          async logs(_actor: unknown, _workspaceId: string, processId: string) {
            return ok({
              entries: [{ sequence: 1, stream: 'stdout' as const, text: `${processId}: typecheck passed` }],
              truncated: false,
              nextSequence: 2,
            });
          },
        },
      },
    } as unknown as McpToolContext;
    const verifier = new IncrementalVerifier();
    const tool = findTool(context, verifier, 'verify_incremental');
    const signal = new AbortController().signal;

    const first = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    const second = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    patch = '+second-diff';
    const third = await tool.execute({ workspaceId: 'workspace-1' }, signal);

    expect(first).toMatchObject({ ok: true, value: { cache: 'miss', passed: true } });
    expect(second).toMatchObject({ ok: true, value: { cache: 'hit', passed: true } });
    expect(third).toMatchObject({ ok: true, value: { cache: 'miss', passed: true } });
    expect(verifier.stats()).toMatchObject({ entries: 1, hits: 1, misses: 2, hitRate: 1 / 3 });
    expect(verifier.stats().bytesSaved).toBeGreaterThan(0);
    expect(verifier.invalidate('workspace-1')).toBe(1);
    expect(verifier.stats()).toMatchObject({ entries: 0, hits: 1, misses: 2 });
    expect(starts).toBe(2);
  });
});
