import { mkdir, mkdtemp, rm, writeFile, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EngineeringPreparationService, GoalContinuationService, engineeringGoalMetadata, type RunGoalResult } from '@lnwjud/application';
import { DEFAULT_ENGINEERING_HARNESS_SETTINGS, type EngineeringHarnessSettings } from '@lnwjud/shared';
import { ok, type EngineeringDeliveryContract, type EngineeringGateEvidence, type AuthorizationMode } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import type { ManagedProcess } from '@lnwjud/process';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { EngineeringBuildCaptureService, type EngineeringBuildCaptureOptions } from './engineering-build-capture.js';
import { CloudflareEngineeringObservationProvider, LocalEngineeringObservationProvider, createEngineeringReceiptArtifactVerifier, type EngineeringBuildReceipt } from './engineering-delivery-observations.js';
import { ToolRegistry } from './tool-registry.js';

// The SQLite-backed fixture can start slowly in the concurrent hosted Windows suite.
// Keep an explicit per-file bound without relaxing any result assertions.
vi.setConfig({ testTimeout: 30_000 });

const actor = { clientId: 'owner', clientName: 'Owner', sessionId: 'session' };
const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('lnwjud-capture-')) throw new Error('Unexpected cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
const bundle = {
  schemaVersion: 1,
  metadata: { main_module: 'worker.js', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: 'b'.repeat(32) }], limits: { cpu_ms: 100 } },
  modules: [{ name: 'worker.js', type: 'application/javascript+module', base64: Buffer.from('export default {fetch(){return new Response("captured")}}').toString('base64') }],
};
const version = { id: '11111111-1111-4111-8111-111111111111', resources: { script: { etag: 'exact-etag' } } };

interface CaptureFixture {
  readonly root: string;
  readonly source: string;
  readonly database: SqliteDatabase;
  readonly goals: GoalContinuationService;
  readonly receipts: SqliteGoalRepository;
  readonly goal: RunGoalResult;
  readonly contract: EngineeringDeliveryContract;
  readonly handle: Parameters<EngineeringBuildCaptureService['complete']>[1];
  readonly request: Parameters<EngineeringBuildCaptureService['start']>[1];
  readonly capture: EngineeringBuildCaptureService;
  readonly process: { start: Mock<EngineeringBuildCaptureOptions['process']['start']>; status: Mock<EngineeringBuildCaptureOptions['process']['status']> };
  readonly fetch: Mock<typeof globalThis.fetch>;
  readonly options: EngineeringBuildCaptureOptions;
  readonly finish: () => Promise<void>;
  readonly built: () => Promise<EngineeringBuildReceipt>;
}
async function fixture(): Promise<CaptureFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-capture-')); roots.push(root);
  const source = path.join(root, 'project'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'capture-fixture', private: true, scripts: { build: 'node build.js' } }));
  await writeFile(path.join(source, 'wrangler.json'), JSON.stringify({ name: 'worker-production', account_id: 'a'.repeat(32), main: 'worker.js' }));
  await writeFile(path.join(source, 'worker.js'), 'export default {fetch(){return new Response("captured")}}');
  const database = new SqliteDatabase(path.join(root, 'state.sqlite')); databases.push(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({ id: 'workspace', displayName: 'Fixture', rootPath: source, realRootPath: source, createdAt: new Date().toISOString() });
  const receipts = new SqliteGoalRepository(database);
  const preparation = new EngineeringPreparationService(workspaces, { globalSettingsProvider: (): EngineeringHarnessSettings => ({ ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, enabled: true, allowNoGit: true, hostedCi: 'local_only' }) });
  const goals = new GoalContinuationService(workspaces, receipts, { engineeringPreparation: preparation });
  const prepared = await preparation.prepare('workspace', 'Build and deploy Worker');
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const started = await goals.runGoal(actor, { workspaceId: 'workspace', goalKey: 'capture', objective: 'Build and deploy Worker', plan: { steps: [] }, engineering: engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow) });
  if (!started.ok) throw new Error(`Goal fixture failed: ${JSON.stringify(started.error)}`);
  if (started.value.leaseToken === undefined || started.value.engineering?.contract === undefined) throw new Error('Goal fixture lacks lease or contract');
  const goal = started.value;
  const handle = { workspaceId: 'workspace', observationId: 'build-1', goalLease: { goalId: goal.goalId, leaseToken: started.value.leaseToken, leaseGeneration: goal.leaseGeneration }, expectedRevision: goal.revision, expectedUserIntentRevision: goal.userIntentRevision };
  let state: ManagedProcess = { processId: 'process-1', executable: 'node', args: ['build.js'], cwd: source, state: 'running', startedAt: new Date().toISOString() };
  const process = { start: vi.fn<EngineeringBuildCaptureOptions['process']['start']>(async () => ok(state)), status: vi.fn<EngineeringBuildCaptureOptions['process']['status']>(async () => ok(state)) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, result: version })));
  const options: EngineeringBuildCaptureOptions = { goals, receipts, process, workspaceRoot: async () => source, signingKey: () => Buffer.alloc(32, 7), cloudflareToken: () => 'host-only-secret', fetch };
  const capture = new EngineeringBuildCaptureService(options);
  const request = { ...handle, artifactPath: 'dist/worker-bundle.json', executable: 'node', args: ['build.js'] };
  async function finish(): Promise<void> { await mkdir(path.join(source, 'dist'), { recursive: true }); await writeFile(path.join(source, request.artifactPath), JSON.stringify(bundle)); state = { ...state, state: 'exited', exitCode: 0, finishedAt: new Date().toISOString() }; }
  async function built(): Promise<EngineeringBuildReceipt> {
    expect(await capture.start(actor, request)).toMatchObject({ ok: true });
    await finish();
    const result = await capture.complete(actor, handle);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  }
  return { root, source, database, goals, receipts, goal, contract: started.value.engineering.contract, handle, request, capture, process, fetch, options, finish, built };
}
function observation(receipt: EngineeringBuildReceipt): EngineeringGateEvidence { return { source: 'host_observed', observedAt: new Date().toISOString(), workspaceId: receipt.workspaceId, sourceDigest: receipt.sourceDigest, artifactDigest: receipt.artifactDigest, contractDigest: receipt.contractDigest, observationId: receipt.id }; }

describe('host build capture authority', () => {
  it('refuses existing artifacts before a touch command can qualify unchanged bytes', async () => {
    const f = await fixture();
    await f.finish();
    const artifact = path.join(f.source, f.request.artifactPath);
    const before = await readFile(artifact);
    f.process.start.mockImplementationOnce(async () => {
      await utimes(artifact, new Date(), new Date(Date.now() + 10_000));
      return ok({ processId: 'touch', executable: 'node', args: ['touch.js'], cwd: f.source, state: 'exited', exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    });
    expect(await f.capture.start(actor, { ...f.request, args: ['touch.js'] })).toMatchObject({ ok: false, error: { code: 'ENGINEERING_EVIDENCE_REJECTED' } });
    expect(f.process.start).not.toHaveBeenCalled();
    expect(await readFile(artifact)).toEqual(before);
    expect(await f.capture.resolveReceipt('workspace', f.handle.observationId)).toBeUndefined();
    expect(await f.receipts.getDeliveryReceipt(f.handle.observationId)).toBeNull();
  });
  it('runs through the public registry and persists a receipt that survives restart and verifies the artifact', async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ goals: f.goals, engineeringCapture: f.capture }, actor, { profileProvider: (): PermissionProfile => permissionProfiles.full, authorizationModeProvider: (): AuthorizationMode => 'full_bypass' });
    const start = await registry.invoke('engineering_build_artifact', f.request);
    expect(start.isError, JSON.stringify(start)).not.toBe(true);
    expect(await f.capture.complete(actor, f.handle)).toMatchObject({ ok: false, error: { code: 'ENGINEERING_EVIDENCE_REJECTED' } });
    await f.finish();
    const complete = await registry.invoke('engineering_complete_build', f.handle);
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    f.database.close();
    const reopened = new SqliteDatabase(path.join(f.root, 'state.sqlite')); databases.push(reopened);
    const reopenedReceipts = new SqliteGoalRepository(reopened);
    const restarted = new EngineeringBuildCaptureService({ ...f.options, receipts: reopenedReceipts, goals: new GoalContinuationService(new SqliteWorkspaceRepository(reopened), reopenedReceipts), process: { start: vi.fn(), status: vi.fn() } });
    const receipt = await restarted.resolveReceipt('workspace', 'build-1');
    expect(receipt).toBeDefined(); if (receipt === undefined) throw new Error('missing receipt');
    const provider = new LocalEngineeringObservationProvider((workspace, id) => restarted.resolveReceipt(workspace, id), createEngineeringReceiptArtifactVerifier(() => f.source));
    expect(await provider.verify({ workspaceId: 'workspace', gateId: 'package', contract: f.contract, evidence: observation(receipt) })).toBe(true);
    await writeFile(path.join(f.source, f.request.artifactPath), 'changed');
    expect(await provider.verify({ workspaceId: 'workspace', gateId: 'package', contract: f.contract, evidence: observation(receipt) })).toBe(false);
    expect((await restarted.complete(actor, f.handle)).ok).toBe(false);
  });

  it('keeps required lease proof under Full Bypass and rejects paths outside the workspace', async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ goals: f.goals, engineeringCapture: f.capture }, actor, { profileProvider: (): PermissionProfile => permissionProfiles.full, authorizationModeProvider: (): AuthorizationMode => 'full_bypass' });
    const unbound = Object.fromEntries(Object.entries(f.request).filter(([key]) => key !== 'goalLease'));
    expect((await registry.invoke('engineering_build_artifact', unbound)).isError).toBe(true);
    expect((await registry.invoke('engineering_build_artifact', { ...f.request, goalLease: { ...f.handle.goalLease, leaseToken: 'stale' } })).isError).toBe(true);
    for (const artifactPath of ['../outside.json', 'C:\\outside.json', '/outside.json']) expect((await f.capture.start(actor, { ...f.request, artifactPath })).ok).toBe(false);
    expect((await f.capture.start(actor, { ...f.request, cwd: '..' })).ok).toBe(false);
    expect(f.process.start).not.toHaveBeenCalled();
  });

  it('reserves once under concurrent services and never replays an unknown attempt after restart', async () => {
    const f = await fixture();
    const other = new EngineeringBuildCaptureService(f.options);
    const results = await Promise.all([f.capture.start(actor, f.request), other.start(actor, f.request)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.process.start).toHaveBeenCalledTimes(1);
    const restarted = new EngineeringBuildCaptureService(f.options);
    expect((await restarted.start(actor, f.request)).ok).toBe(false);
    await f.finish();
    expect((await restarted.complete(actor, f.handle)).ok).toBe(false);
    expect(f.process.start).toHaveBeenCalledTimes(1);
  });

  it('rejects changed source, stale intent and stale generation after a successful command', async () => {
    const f = await fixture();
    expect((await f.capture.start(actor, f.request)).ok).toBe(true);
    expect((await f.capture.complete(actor, f.handle)).ok).toBe(false);
    await f.finish();
    await writeFile(path.join(f.source, 'worker.js'), 'source changed');
    expect(await f.capture.complete(actor, f.handle)).toMatchObject({ ok: false, error: { code: 'ENGINEERING_SOURCE_CHANGED' } });
    expect((await f.capture.start(actor, { ...f.request, observationId: 'new', expectedUserIntentRevision: 999 })).ok).toBe(false);
    expect((await f.capture.start(actor, { ...f.request, observationId: 'new', goalLease: { ...f.handle.goalLease, leaseGeneration: 999 } })).ok).toBe(false);
    expect(f.process.start).toHaveBeenCalledTimes(1);
  });

  it('rejects intent changes at the transactional reservation seam before dispatch', async () => {
    const f = await fixture();
    const write = f.receipts.recordDeliveryReceipt.bind(f.receipts);
    vi.spyOn(f.receipts, 'recordDeliveryReceipt').mockImplementationOnce(async (request) => {
      const revised = await f.goals.reviseGoalIntent(actor, { goalId: f.goal.goalId, leaseToken: f.handle.goalLease.leaseToken, expectedRevision: f.goal.revision, expectedUserIntentRevision: f.goal.userIntentRevision, steering: 'Stop the pending build and review the requirements' });
      expect(revised.ok).toBe(true);
      return write(request);
    });
    expect((await f.capture.start(actor, f.request)).ok).toBe(false);
    expect(await f.receipts.getDeliveryReceipt(f.request.observationId)).toBeNull();
    expect(f.process.start).not.toHaveBeenCalled();
  });

  it('invalidates completed receipt authority when accepted user intent changes', async () => {
    const f = await fixture(); await f.built();
    const revised = await f.goals.reviseGoalIntent(actor, { goalId: f.goal.goalId, leaseToken: f.handle.goalLease.leaseToken, expectedRevision: f.goal.revision, expectedUserIntentRevision: f.goal.userIntentRevision, steering: 'Change the deployment target before further delivery' });
    expect(revised.ok).toBe(true);
    expect(await f.capture.resolveReceipt('workspace', 'build-1')).toBeUndefined();
    expect((await f.capture.complete(actor, f.handle)).ok).toBe(false);
  });

  it.each(['running', 'termination_unverified', 'failed', 'timed_out', 'stopped'] as const)('does not attest a %s process as successful completion', async (state) => {
    const f = await fixture();
    expect((await f.capture.start(actor, f.request)).ok).toBe(true); await f.finish();
    f.process.status.mockResolvedValue(ok({ processId: 'process-1', executable: 'node', args: ['build.js'], cwd: f.source, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, state }));
    expect((await f.capture.complete(actor, f.handle)).ok).toBe(false);
    expect(await f.capture.resolveReceipt('workspace', 'build-1')).toBeUndefined();
  });

  it('reports unavailable secure storage without dispatch, and missing provider token without an upload', async () => {
    const f = await fixture();
    const noKey = new EngineeringBuildCaptureService({ ...f.options, signingKey: (): never => { throw new Error('private-key-secret'); } });
    const result = await noKey.start(actor, f.request);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PLATFORM' } });
    expect(JSON.stringify(result)).not.toContain('private-key-secret');
    expect(f.process.start).not.toHaveBeenCalled();
    expect(await f.receipts.getDeliveryReceipt(f.request.observationId)).toBeNull();
    await f.built();
    const noToken = new EngineeringBuildCaptureService({ ...f.options, cloudflareToken: (): undefined => undefined });
    expect(await noToken.uploadWorker(actor, { ...f.handle, observationId: 'upload-1', buildObservationId: 'build-1' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PLATFORM' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...bundle, modules: [...bundle.modules, ...bundle.modules] },
    { ...bundle, modules: [{ ...bundle.modules[0], name: '../outside.js' }] },
    { ...bundle, modules: [{ ...bundle.modules[0], base64: 'invalid!' }] },
    { ...bundle, metadata: { ...bundle.metadata, main_module: 'absent.js' } },
    { ...bundle, modules: [{ ...bundle.modules[0], type: 'unknown/type' }] },
  ])('rejects malformed Worker manifests without attestation or upload', async (manifest) => {
    const f = await fixture();
    expect((await f.capture.start(actor, f.request)).ok).toBe(true); await f.finish();
    await writeFile(path.join(f.source, f.request.artifactPath), JSON.stringify(manifest));
    expect((await f.capture.complete(actor, f.handle)).ok).toBe(false);
    expect(await f.capture.resolveReceipt('workspace', 'build-1')).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rejects forged public delivery JSON and signed receipt identity replay', async () => {
    const f = await fixture();
    const receipt = await f.built();
    expect(await new EngineeringBuildCaptureService({ ...f.options, signingKey: (): Buffer => Buffer.alloc(32, 8) }).resolveReceipt('workspace', receipt.id)).toBeUndefined();
    const original = await f.receipts.getDeliveryReceipt(receipt.id);
    expect(original?.detail).toBeDefined();
    for (const state of ['reserved', 'attempted_unresolved', 'host_confirmed'] as const) {
      const forged = await f.goals.recordDeliveryReceipt(actor, { receiptId: 'forged', goalId: f.goal.goalId, channel: 'engineering.host-build.v1', state, basedOnUserIntentRevision: f.goal.userIntentRevision, detail: original?.detail });
      expect(forged.ok).toBe(true);
    }
    expect(await f.capture.resolveReceipt('workspace', 'forged')).toBeUndefined();
    await f.receipts.recordDeliveryReceipt({ id: receipt.id, goalId: f.goal.goalId, channel: 'engineering.host-build.v1', state: 'host_confirmed', basedOnUserIntentRevision: f.goal.userIntentRevision, now: new Date().toISOString(), detail: JSON.stringify({ payload: JSON.stringify({ receipt }), signature: '0'.repeat(64) }) });
    expect(await f.capture.resolveReceipt('workspace', receipt.id)).toBeUndefined();
  });

  it('uploads exact captured metadata and modules then verifies version readback without claiming traffic deployment', async () => {
    const f = await fixture(); await f.built();
    f.fetch.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(FormData);
        if (!(init.body instanceof FormData)) throw new Error('missing upload body');
        const metadata = init.body.get('metadata'); const module = init.body.get('worker.js');
        if (!(metadata instanceof Blob) || !(module instanceof Blob)) throw new Error('missing parts');
        expect(JSON.parse(await metadata.text())).toEqual(bundle.metadata);
        expect(Buffer.from(await module.arrayBuffer()).toString('base64')).toBe(bundle.modules[0]?.base64);
      }
      return new Response(JSON.stringify({ success: true, result: version }));
    });
    const uploaded = await f.capture.uploadWorker(actor, { ...f.handle, observationId: 'upload-1', buildObservationId: 'build-1' });
    expect(uploaded.ok, JSON.stringify(uploaded)).toBe(true); if (!uploaded.ok) return;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const provider = new CloudflareEngineeringObservationProvider({ receipt: (workspace, id): Promise<EngineeringBuildReceipt | undefined> => f.capture.resolveReceipt(workspace, id), token: f.options.cloudflareToken, verifyArtifact: createEngineeringReceiptArtifactVerifier(() => f.source), fetch: f.fetch });
    expect(await provider.verify({ workspaceId: 'workspace', gateId: 'package', contract: f.contract, evidence: observation(uploaded.value) })).toBe(true);
    expect(await provider.verify({ workspaceId: 'workspace', gateId: 'deployment', contract: f.contract, evidence: observation(uploaded.value) })).toBe(false);
    expect(JSON.stringify(uploaded)).not.toContain('host-only-secret');
    const priorCalls = f.fetch.mock.calls.length;
    expect((await f.capture.uploadWorker(actor, { ...f.handle, observationId: 'upload-1', buildObservationId: 'build-1' })).ok).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(priorCalls);
  });

  it('does not sign a successful upload if source changes during provider work', async () => {
    const f = await fixture(); await f.built();
    f.fetch.mockImplementation(async () => {
      await writeFile(path.join(f.source, 'worker.js'), 'changed while uploading');
      return new Response(JSON.stringify({ success: true, result: version }));
    });
    const result = await f.capture.uploadWorker(actor, { ...f.handle, observationId: 'upload-1', buildObservationId: 'build-1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'ENGINEERING_SOURCE_CHANGED' } });
    expect(await f.capture.resolveReceipt('workspace', 'upload-1')).toBeUndefined();
    expect(await f.receipts.getDeliveryReceipt('upload-1')).toMatchObject({ state: 'attempted_unresolved' });
  });

  it.each(['failure', 'http', 'oversize', 'mismatch'])('keeps a %s upload reserved and does not issue another POST', async (mode) => {
    const f = await fixture(); await f.built();
    f.fetch.mockImplementation(async (_url, init) => {
      if (mode === 'failure') throw new Error('token=host-only-secret');
      if (mode === 'http') return new Response('provider failed', { status: 503 });
      if (mode === 'oversize') return new Response('x'.repeat(256 * 1024 + 1));
      return new Response(JSON.stringify({ success: true, result: init?.method === 'POST' ? version : { ...version, resources: { script: { etag: 'wrong' } } } }));
    });
    const request = { ...f.handle, observationId: 'upload-1', buildObservationId: 'build-1' };
    const result = await f.capture.uploadWorker(actor, request);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('host-only-secret');
    const calls = f.fetch.mock.calls.length;
    expect((await new EngineeringBuildCaptureService(f.options).uploadWorker(actor, request)).ok).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
    expect(await f.capture.resolveReceipt('workspace', 'upload-1')).toBeUndefined();
  });
});
