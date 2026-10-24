import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EngineeringPreparationService, GoalContinuationService, engineeringGoalMetadata, type RunGoalResult } from '@lnwjud/application';
import { DEFAULT_ENGINEERING_HARNESS_SETTINGS, type EngineeringHarnessSettings } from '@lnwjud/shared';
import type { ScheduledContinuationWorkerLiveness } from '@lnwjud/domain';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteBackupService, applyPendingSqliteRestoreSync } from './backup-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor = { clientId: 'owner', clientName: 'Owner', sessionId: 'session' };
async function fixture(): Promise<{ database: SqliteDatabase; filename: string; repository: SqliteGoalRepository; service: GoalContinuationService; source: string; goal: RunGoalResult; token: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'engineering-v2-')); roots.push(root);
  const source = path.join(root, 'project'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), '{"name":"fixture","scripts":{"test":"node test.js"}}');
  await writeFile(path.join(source, 'test.js'), 'console.log("pass");');
  const filename = path.join(root, 'state.sqlite');
  const database = new SqliteDatabase(filename);
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({ id: 'workspace', displayName: 'Fixture', rootPath: source, realRootPath: source, createdAt: '2026-10-18T00:00:00Z' });
  const repository = new SqliteGoalRepository(database);
  const preparation = new EngineeringPreparationService(workspaces, { globalSettingsProvider: (): EngineeringHarnessSettings => ({ ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, enabled: true, allowNoGit: true, hostedCi: 'local_only' }) });
  const service = new GoalContinuationService(workspaces, repository, { engineeringPreparation: preparation, now: (): Date => new Date('2026-10-18T00:00:00Z'), engineeringEvidenceVerifier: { verify: async (): Promise<boolean> => true }, workerLiveness: { observe: async (goalId): Promise<ScheduledContinuationWorkerLiveness> => {
    const goal = await repository.getById(goalId); if (goal === null) throw new Error('missing');
    return { trustworthy: true, observedAt: '2026-10-18T00:00:00Z', leaseGeneration: goal.leaseGeneration, leaseActivitySeq: goal.leaseActivitySeq, liveFencedCallCount: 0, blockingTaskStates: [] };
  } } });
  const prepared = await preparation.prepare('workspace', 'Fix code behavior'); if (!prepared.ok) throw new Error('prepare failed');
  const started = await service.runGoal(actor, { workspaceId: 'workspace', goalKey: 'engineering', objective: 'Fix code behavior', plan: { steps: [] }, engineering: engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow) });
  if (!started.ok || started.value.leaseToken === undefined) throw new Error('start failed');
  return { database, filename, repository, service, source, goal: started.value, token: started.value.leaseToken };
}

describe('versioned Engineering authority', () => {
  it('prevents an older SQLite client from discarding the versioned Goal contract', async () => {
    const f = await fixture();
    const legacy = new DatabaseSync(f.filename);
    try {
      const before = await f.repository.getById(f.goal.goalId);
      expect(() => legacy.prepare('UPDATE goals SET engineering_metadata_json = NULL WHERE id = ?').run(f.goal.goalId)).toThrow('lnwjud_goal_contract_schema');
      expect(() => legacy.prepare('DELETE FROM goals WHERE id = ?').run(f.goal.goalId)).toThrow('lnwjud_goal_contract_schema');
      expect((await f.repository.getById(f.goal.goalId))?.engineering).toEqual(before?.engineering);
      f.database.connection.prepare('UPDATE goals SET current_phase = ? WHERE id = ?').run('compatible host', f.goal.goalId);
      expect((await f.repository.getById(f.goal.goalId))?.currentPhase).toBe('compatible host');
    } finally { legacy.close(); f.database.close(); }
  });

  it('refuses a newer profile reader floor before migrations or journal setup', async () => {
    const f = await fixture();
    try {
      f.database.connection.exec('CREATE TABLE IF NOT EXISTS runtime_compatibility (scope TEXT PRIMARY KEY, minimum_reader INTEGER NOT NULL);');
      f.database.connection.prepare('INSERT OR REPLACE INTO runtime_compatibility VALUES (?, ?)').run('goal_contract', 3);
      expect(() => f.database.connection.prepare('UPDATE goals SET current_phase = ? WHERE id = ?').run('stale reader', f.goal.goalId)).toThrow('requires a newer lnwjud');
      f.database.close();
      expect(() => { const incompatible = new SqliteDatabase(f.filename); incompatible.close(); }).toThrow('requires a newer lnwjud');
      const legacy = new DatabaseSync(f.filename, { readOnly: true });
      try {
        expect(legacy.prepare('SELECT minimum_reader FROM runtime_compatibility WHERE scope = ?').get('goal_contract')).toEqual({ minimum_reader: 3 });
        expect(legacy.prepare('SELECT engineering_metadata_json FROM goals WHERE id = ?').get(f.goal.goalId)).toBeDefined();
      } finally { legacy.close(); }
    } finally { f.database.close(); }
  });

  it('rejects a newer profile backup before replacing the current profile', async () => {
    const f = await fixture();
    const backupDirectory = path.join(path.dirname(f.filename), 'backups');
    try {
      const backup = new SqliteBackupService(f.database, { backupDirectory, databaseFilename: f.filename, platform: 'win32', arch: 'x64' });
      const snapshot = await backup.create('manual');
      await backup.scheduleRestore(snapshot.id);
      const future = new DatabaseSync(path.join(backupDirectory, snapshot.id + '.sqlite'));
      try { future.prepare('UPDATE runtime_compatibility SET minimum_reader = 3 WHERE scope = ?').run('goal_contract'); }
      finally { future.close(); }
      f.database.connection.prepare('UPDATE goals SET current_phase = ? WHERE id = ?').run('preserve current data', f.goal.goalId);
      await expect(backup.scheduleRestore(snapshot.id)).rejects.toThrow('requires a newer lnwjud');
      f.database.close();
      expect(applyPendingSqliteRestoreSync(f.filename, backupDirectory, { platform: 'win32', arch: 'x64' })).toMatchObject({ applied: false, error: expect.stringContaining('requires a newer lnwjud') });
      const reopened = new SqliteDatabase(f.filename);
      try { expect((await new SqliteGoalRepository(reopened).getById(f.goal.goalId))?.currentPhase).toBe('preserve current data'); }
      finally { reopened.close(); }
    } finally { f.database.close(); }
  });

  it('atomically fences host capture receipt writes by current lease generation, session, revision and intent', async () => {
    const f = await fixture();
    try {
      const mutationFence = { ownerClientId: actor.clientId, ownerSessionId: actor.sessionId, leaseTokenHash: createHash('sha256').update(f.token).digest('hex'), leaseGeneration: f.goal.leaseGeneration, expectedRevision: f.goal.revision };
      const request = { id: 'fenced-capture', goalId: f.goal.goalId, channel: 'engineering_build_v1', state: 'reserved' as const, basedOnUserIntentRevision: f.goal.userIntentRevision, now: '2026-10-18T00:00:00Z', mutationFence };
      for (const changed of [{ expectedRevision: -1 }, { ownerSessionId: 'stale-session' }, { leaseGeneration: f.goal.leaseGeneration + 1 }, { leaseTokenHash: '0'.repeat(64) }]) {
        await expect(f.repository.recordDeliveryReceipt({ ...request, mutationFence: { ...mutationFence, ...changed } })).rejects.toThrow();
        expect(await f.repository.getDeliveryReceipt(request.id)).toBe(null);
      }
      await expect(f.repository.recordDeliveryReceipt({ ...request, basedOnUserIntentRevision: f.goal.userIntentRevision + 1 })).rejects.toThrow();
      expect(await f.repository.recordDeliveryReceipt(request)).toMatchObject({ id: request.id, state: 'reserved' });
    } finally { f.database.close(); }
  });

  it('reserves a delivery identity once across repository instances', async () => {
    const f = await fixture();
    const second = new SqliteDatabase(f.filename);
    try {
      const request = { id: 'capture-once', goalId: f.goal.goalId, channel: 'engineering_build_v1', state: 'reserved' as const, basedOnUserIntentRevision: f.goal.userIntentRevision, detail: 'first', now: '2026-10-18T00:00:00Z', createOnly: true };
      await f.repository.recordDeliveryReceipt(request);
      await expect(new SqliteGoalRepository(second).recordDeliveryReceipt({ ...request, detail: 'duplicate' })).rejects.toThrow('already reserved');
      expect((await f.repository.getDeliveryReceipt(request.id))?.detail).toBe('first');
    } finally { second.close(); f.database.close(); }
  });

  it('round-trips source/decision bindings and preserves unchanged proof; changes stale it on run_goal', async () => {
    const f = await fixture();
    try {
      const contract = f.goal.engineering?.contract; if (contract === undefined) throw new Error('missing contract');
      const checkpoint = await f.service.checkpointGoal(actor, { goalId: f.goal.goalId, leaseToken: f.token, expectedRevision: f.goal.revision, currentPhase: 'validation', summary: 'Observed source', stepUpdates: [], nextAction: 'Continue', blockers: [], evidence: [], trackedTasks: [], releaseLease: true,
        engineeringGateUpdates: [{ gateId: 'source_identity', status: 'passed', evidence: { source: 'host_observed', observedAt: '2026-10-18T00:00:00Z', workspaceId: 'workspace', sourceDigest: contract.sourceDigest, contractDigest: contract.digest } }],
      });
      expect(checkpoint.ok).toBe(true);
      const resumed = await f.service.runGoal(actor, { workspaceId: 'workspace', goalKey: 'engineering' });
      if (!resumed.ok || resumed.value.leaseToken === undefined) throw new Error('resume failed');
      expect(resumed.value.engineering?.gates.find((gate) => gate.id === 'source_identity')?.status).toBe('passed');
      const release = await f.service.checkpointGoal(actor, { goalId: f.goal.goalId, leaseToken: resumed.value.leaseToken, expectedRevision: resumed.value.revision, currentPhase: 'validation', summary: 'Release lease', stepUpdates: [], nextAction: 'Continue', blockers: [], evidence: [], trackedTasks: [], releaseLease: true });
      expect(release.ok).toBe(true);
      await writeFile(path.join(f.source, 'untracked.js'), 'new input');
      const changed = await f.service.runGoal(actor, { workspaceId: 'workspace', goalKey: 'engineering' });
      if (!changed.ok) throw new Error('changed resume failed');
      expect(changed.value.goalId).toBe(f.goal.goalId);
      expect(changed.value.engineering?.gates.find((gate) => gate.id === 'source_identity')?.status).toBe('stale');
      expect(changed.value.engineering?.contract?.digest).not.toBe(contract.digest);
      f.database.close();
      const reopened = new SqliteDatabase(f.filename);
      try { expect((await new SqliteGoalRepository(reopened).getById(f.goal.goalId))?.engineering).toEqual(changed.value.engineering); } finally { reopened.close(); }
    } finally { f.database.close(); }
  });

  it('keeps an unchanged stale gate stable across checkpoint, run_goal and finish revalidation', async () => {
    const f = await fixture();
    try {
      const engineering = f.goal.engineering;
      if (engineering === undefined) throw new Error('missing Engineering metadata');
      const stale = {
        ...engineering,
        gates: engineering.gates.map((gate) => ({
          ...gate,
          status: 'stale' as const,
          reason: `Engineering gate contract changed; revalidate. ${gate.reason}`,
        })),
      };
      const checkpoint = await f.service.checkpointGoal(actor, {
        goalId: f.goal.goalId, leaseToken: f.token, expectedRevision: f.goal.revision,
        currentPhase: 'revalidate', summary: 'Persist stale gates', stepUpdates: [], nextAction: 'Recheck the same contract', blockers: [], evidence: [], trackedTasks: [],
        engineering: stale, releaseLease: true,
      });
      if (!checkpoint.ok) throw new Error(`checkpoint failed: ${checkpoint.error.message}`);

      const resumed = await f.service.runGoal(actor, { workspaceId: 'workspace', goalKey: 'engineering' });
      if (!resumed.ok || resumed.value.leaseToken === undefined) throw new Error('resume failed');
      expect(resumed.value.engineering?.gates.every((gate) => gate.status === 'stale')).toBe(true);
      expect(resumed.value.engineering?.gates.map((gate) => gate.reason)).toEqual(stale.gates.map((gate) => gate.reason));

      const finished = await f.service.finishGoal(actor, {
        goalId: f.goal.goalId, leaseToken: resumed.value.leaseToken, expectedRevision: resumed.value.revision,
        status: 'completed', summary: 'Complete unchanged contract', evidence: [],
      });
      expect(finished.ok).toBe(false);
      if (!finished.ok) expect(finished.error.code).toBe('ENGINEERING_SOURCE_CHANGED');
    } finally { f.database.close(); }
  });

  it('recovers only the same blocked goal with owner, explicit confirmation and exact revision', async () => {
    const f = await fixture();
    try {
      const blocked = await f.service.finishGoal(actor, { goalId: f.goal.goalId, leaseToken: f.token, expectedRevision: f.goal.revision, status: 'blocked', summary: 'Await required proof', evidence: [] });
      if (!blocked.ok) throw new Error('block failed');
      const request = { goalId: f.goal.goalId, expectedRevision: blocked.value.revision, reason: 'User requests recovery after local policy correction', userConfirmed: true };
      expect((await f.service.recoverBlockedGoal({ ...actor, clientId: 'other' }, request)).ok).toBe(false);
      expect((await f.service.recoverBlockedGoal(actor, { ...request, userConfirmed: false })).ok).toBe(false);
      expect((await f.service.recoverBlockedGoal(actor, { ...request, expectedRevision: 0 })).ok).toBe(false);
      const recovered = await f.service.recoverBlockedGoal(actor, request);
      if (!recovered.ok) throw new Error(JSON.stringify(recovered.error));
      expect(recovered.value).toMatchObject({ goalId: f.goal.goalId, status: 'active', acquired: true });
      expect(recovered.value.leaseToken).not.toBe(f.token);
      expect(recovered.value.leaseGeneration).toBeGreaterThan(f.goal.leaseGeneration);
      expect((await f.service.recoverBlockedGoal(actor, request)).ok).toBe(false);
      const history = await f.repository.getById(f.goal.goalId);
      expect(history?.checkpoints.some((entry) => entry.summary.includes('Explicit blocked goal recovery'))).toBe(true);
    } finally { f.database.close(); }
  });
});
