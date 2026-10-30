import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { readCapabilityTaskOwner } from '@lnwjud/capabilities';
import { UpgradeRuntimeService } from './upgrade-runtime.js';

const actor = { clientId: 'recovery-client', clientName: 'fixture', sessionId: 'recovery-session' };

describe('owned recovery plans', () => {
  it('separates declared recovery policy from observations that cannot be made', async () => {
    const runtime = new UpgradeRuntimeService({}, actor);
    await expect(runtime.execute('recovery_status', { workspaceId: 'ws-1', goalId: 'goal-1' })).resolves.toMatchObject({ ok: true, value: {
      policy: { safeReadRetry: true, destructiveRetry: false, staleContinuationDetection: 'owner-and-liveness-evidence-required' },
      observations: { index: { status: 'unavailable' }, durableTasks: { status: 'unavailable' }, goal: { status: 'unavailable' }, externalMcp: { status: 'unavailable' } },
      observationState: 'partial',
    } });
  });

  it('exposes held global reservations even with no scoped running tasks, without revealing private identities or claiming liveness', async () => {
    const runtime = new UpgradeRuntimeService({
      capabilities: { async execute(): Promise<ReturnType<typeof ok>> {
        return ok({
          tasks: [],
          admission: {
            capacity_population: 'durable_shell',
            durable_shell_limit: 16,
            durable_shell_reservations: 0,
            managed_writer_reservations: 2,
            unresolved_reservations: 2,
            unreadable_reservations: 0,
            exclusive_writer_blocked: true,
            status_basis: 'held_reservations_not_process_liveness',
            blockers: [
              { reservation_id: 'private-one', mutation_kind: 'opaque_uncontained', capacity_class: 'managed_writer', state: 'held', recovery_requirement: 'trusted_termination_evidence' },
              { reservation_id: 'private-two', mutation_kind: 'opaque_contained_process', capacity_class: 'managed_writer', state: 'held', recovery_requirement: 'trusted_termination_evidence' },
            ],
          },
        });
      } },
    }, actor);
    const result = await runtime.execute('recovery_status', { workspaceId: 'ws-1' });
    expect(result).toMatchObject({ ok: true, value: { observations: {
      durableTasks: { status: 'observed', total: 0, running: 0 },
      writerReservations: {
        status: 'observed', scope: 'global_shared_index', durable_shell_limit: 16,
        managed_writer_reservations: 2, unresolved_reservations: 2,
        exclusive_writer_blocked: true, terminal_proof: 'not_observed',
        recovery: 'no_automatic_reclamation',
        by_mutation_kind: { opaque_uncontained: 1, opaque_contained_process: 1 },
      },
    } } });
    expect(JSON.stringify(result)).not.toContain('private-one');
    expect(JSON.stringify(result)).not.toContain('private-two');
  });

  it('reads existing Goal and continuation receipts without claiming native liveness', async () => {
    const calls: string[] = [];
    const runtime = new UpgradeRuntimeService({
      workspaceIndex: { async status(): Promise<ReturnType<typeof ok>> { return ok({ indexed: true, snapshot: { entries: [] }, freshness: 'unverified', generation: 'fixture' }); } },
      capabilities: { async execute(): Promise<ReturnType<typeof ok>> { return ok({ tasks: [], admission: { capacity_population: 'durable_shell', durable_shell_limit: 16, durable_shell_reservations: 0, managed_writer_reservations: 0, unresolved_reservations: 0, unreadable_reservations: 0, exclusive_writer_blocked: false, status_basis: 'held_reservations_not_process_liveness', blockers: [] } }); } },
      goals: { async getGoal(receivedActor, request): Promise<ReturnType<typeof ok>> {
        expect(receivedActor).toEqual(actor);
        expect(request).toEqual({ goalId: 'goal-1' });
        calls.push('goal');
        return ok({ goalId: 'goal-1', workspaceId: 'ws-1', status: 'active', revision: 3, currentPhase: 'fixture' });
      } },
      scheduledContinuations: { async getScheduledContinuation(receivedActor, request): Promise<ReturnType<typeof ok>> {
        expect(receivedActor).toEqual(actor);
        expect(request).toEqual({ goalId: 'goal-1', latest: true });
        calls.push('continuation');
        return ok({ continuationId: 'continuation-1', status: 'scheduled', nativeTaskId: 'receipt-1' });
      } },
      extensions: { async listMcpServers(): Promise<ReturnType<typeof ok>> { calls.push('catalog'); return ok({ servers: [{ name: 'fixture', enabled: true, connected: false, excluded: false, env: { secret: 'never-return' } }] }); } },
    }, actor);
    const result = await runtime.execute('recovery_status', { workspaceId: 'ws-1', goalId: 'goal-1' });
    expect(result).toMatchObject({ ok: true, value: { observationState: 'complete', sideEffectsStarted: false, observations: {
      goal: { status: 'observed', state: 'active', revision: 3 },
      scheduledContinuation: { status: 'observed', state: 'scheduled', nativeTaskId: 'receipt-1', nativeRunnableState: 'requires-host-confirmation' },
      externalMcp: { status: 'observed', servers: [{ name: 'fixture', connected: false }] },
    } } });
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(calls).toEqual(['goal', 'continuation', 'catalog']);
    calls.length = 0;
    await expect(runtime.execute('recovery_status', { workspaceId: 'foreign-workspace', goalId: 'goal-1' })).resolves.toMatchObject({ ok: true, value: {
      observationState: 'partial', observations: { goal: { status: 'unknown', errorCode: 'PERMISSION_DENIED' }, scheduledContinuation: { status: 'unknown', reason: 'goal-state-unverified' } },
    } });
    expect(calls).toEqual(['goal', 'catalog']);
  });
  it('preserves old live tasks and scopes evidence reads to the trusted owner', async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const runtime = new UpgradeRuntimeService({
      capabilities: {
        async execute(tool, request, signal): Promise<ReturnType<typeof ok>> {
          calls.push(request);
          expect(tool).toBe('shell');
          expect(signal).toBe(controller.signal);
          expect(readCapabilityTaskOwner(request)).toEqual({ clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: 'ws-1' });
          return ok({ tasks: [
            { task_id: 'old-live', state: 'running', durable: true, started_at: '2000-01-01T00:00:00Z' },
            { task_id: 'done', state: 'completed', durable: true, started_at: '2000-01-01T00:00:00Z' },
          ] });
        },
      },
    }, actor);
    const plan = await runtime.execute('self_heal_plan', { workspaceId: 'ws-1' }, controller.signal);
    expect(plan).toMatchObject({ ok: true, value: {
      safeReversibleFixes: [], mutationRequired: false,
      evidence: { durableTasks: { status: 'observed', total: 2, running: 1, cancellationEligibility: 'requires-explicit-liveness-and-owner-review' } },
      manualIssues: [expect.objectContaining({ taskId: 'old-live', reason: 'Running duration does not prove abandonment' })],
    } });
    expect(calls).toHaveLength(1);
  });

  it('reports unknown evidence when providers are missing or fail', async () => {
    const missing = new UpgradeRuntimeService({}, actor);
    await expect(missing.execute('self_heal_plan', { workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: {
      evidence: { index: { status: 'unavailable' }, durableTasks: { status: 'unavailable' } },
      safeReversibleFixes: [], observationState: 'partial',
    } });
    const malformed = new UpgradeRuntimeService({ capabilities: { async execute(): Promise<ReturnType<typeof ok>> { return ok({ tasks: [], admission: { unresolved_reservations: 0 } }); } } }, actor);
    await expect(malformed.execute('recovery_status', { workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: {
      observationState: 'partial', observations: {
        durableTasks: { status: 'observed', total: 0 },
        writerReservations: { status: 'unknown', reason: 'admission-diagnostics-missing-or-invalid' },
      },
    } });
    const failing = new UpgradeRuntimeService({ capabilities: { async execute(): Promise<ReturnType<typeof err>> { return err(appError('INTERNAL_ERROR', 'fixture')); } } }, actor);
    await expect(failing.execute('self_heal_plan', { workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: {
      evidence: { durableTasks: { status: 'unknown', errorCode: 'INTERNAL_ERROR' } }, observationState: 'partial',
    } });
  });

  it('rejects unknown fixes and applies only an approved forced rebuild', async () => {
    const indexing: unknown[] = [];
    const controller = new AbortController();
    const runtime = new UpgradeRuntimeService({
      workspaceIndex: {
        async status(): Promise<ReturnType<typeof ok>> { return ok({ indexed: false, snapshot: null, generation: null, freshness: 'missing' }); },
        async indexWorkspace(workspaceId, options): Promise<ReturnType<typeof ok>> { indexing.push({ workspaceId, options }); return ok({ entries: [] }); },
      },
    }, actor);
    const plan = await runtime.execute('self_heal_plan', { workspaceId: 'ws-1' }, controller.signal);
    if (!plan.ok || typeof plan.value !== 'object' || plan.value === null || !('planId' in plan.value)) throw new Error('Fixture plan missing');
    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1', fixIds: ['cancel-stale-task-any'] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1', planId: plan.value.planId, fixIds: ['reindex-workspace'] })).resolves.toMatchObject({ ok: true, value: { dryRun: true, applied: [] } });
    expect(indexing).toHaveLength(0);
    await expect(runtime.execute('self_heal_apply', { workspaceId: 'ws-1', planId: plan.value.planId, fixIds: ['reindex-workspace'], dryRun: false, userConfirmed: true }, controller.signal)).resolves.toMatchObject({ ok: true, value: { applied: [{ id: 'reindex-workspace', ok: true }] } });
    expect(indexing).toEqual([{ workspaceId: 'ws-1', options: { rebuild: true, signal: controller.signal } }]);
  });
});
