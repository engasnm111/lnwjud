import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteWorkspaceWriterLease, type WorkspaceWriterLeaseProof } from '@lnwjud/capabilities';
import { permissionProfiles } from '@lnwjud/permissions';
import { ToolRegistry, type ToolRegistryOptions } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test' };
const workspaceId = 'workspace-a';

interface LeaseHarness {
  readonly root: string;
  readonly lease: SqliteWorkspaceWriterLease;
  readonly registryFor: (sessionId: string) => ToolRegistry;
  readonly acquire: (sessionId: string, ttlSeconds?: number) => Promise<WorkspaceWriterLeaseProof>;
  readonly release: (sessionId: string, proof: WorkspaceWriterLeaseProof) => Promise<{ isError?: boolean; structuredContent?: { error?: { code?: string } } }>;
  readonly renew: (sessionId: string, proof: WorkspaceWriterLeaseProof, ttlSeconds?: number) => Promise<{ isError?: boolean; structuredContent?: { error?: { code?: string }; expiresAt?: string } }>;
}

async function createHarness(clock?: () => number): Promise<LeaseHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-writer-lease-control-'));
  const lease = clock === undefined
    ? new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'))
    : new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), clock);
  const options = (sessionId: string): ToolRegistryOptions => ({
    sessionId,
    profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
    authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
  });
  return {
    root,
    lease,
    registryFor: (sessionId) => new ToolRegistry({ workspaceWriterLease: lease }, actor, options(sessionId)),
    acquire: async (sessionId: string, ttlSeconds = 600): Promise<WorkspaceWriterLeaseProof> => {
      const response = await new ToolRegistry({ workspaceWriterLease: lease }, actor, options(sessionId))
        .invoke('workspace_writer_lease_acquire', { workspaceId, ...(ttlSeconds === 600 ? {} : { ttlSeconds }) });
      if (response.isError) throw new Error(`acquire failed: ${JSON.stringify(response.structuredContent)}`);
      const { leaseId, leaseToken, generation } = response.structuredContent as WorkspaceWriterLeaseProof;
      return { leaseId, leaseToken, generation };
    },
    release: (sessionId, proof) => new ToolRegistry({ workspaceWriterLease: lease }, actor, options(sessionId))
      .invoke('workspace_writer_lease_release', { workspaceId, writerLease: proof }) as never,
    renew: (sessionId, proof, ttlSeconds = 600) => new ToolRegistry({ workspaceWriterLease: lease }, actor, options(sessionId))
      .invoke('workspace_writer_lease_renew', { workspaceId, writerLease: proof, ttlSeconds }) as never,
  };
}

describe('workspace writer lease control tools through the tool registry', () => {
  it('releases an owned lease with the exact proof the caller sent (proof survives the registry pipeline)', async () => {
    const harness = await createHarness();
    try {
      const proof = await harness.acquire('session-a');
      const response = await harness.release('session-a', proof);
      expect(response.isError).not.toBe(true);
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'unleased', activeCalls: 0 } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('renews an owned lease with the exact proof the caller sent', async () => {
    let time = 100_000;
    const harness = await createHarness(() => time);
    try {
      const proof = await harness.acquire('session-a', 600);
      time += 120_000;
      const response = await harness.renew('session-a', proof, 600);
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ expiresAt: new Date(time + 600_000).toISOString() });
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'active', generation: proof.generation } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('answers a second release with the contract conflict, never an internal error', async () => {
    const harness = await createHarness();
    try {
      const proof = await harness.acquire('session-a');
      expect((await harness.release('session-a', proof)).isError).not.toBe(true);
      const second = await harness.release('session-a', proof);
      expect(second.isError).toBe(true);
      expect(second.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('requires the proof on the wire and rejects a missing or malformed proof as invalid input', async () => {
    const harness = await createHarness();
    try {
      await harness.acquire('session-a');
      const registry = harness.registryFor('session-a');
      const missing = await registry.invoke('workspace_writer_lease_release', { workspaceId });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(await harness.lease.release(workspaceId, actor.clientId, 'session-a', undefined as never))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await harness.lease.release(workspaceId, actor.clientId, 'session-a', { leaseId: '', leaseToken: '', generation: -1 }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await harness.lease.renew(workspaceId, actor.clientId, 'session-a', undefined as never, 600))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'active' } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('refuses release and renew from another session of the same client (ownership preserved)', async () => {
    const harness = await createHarness();
    try {
      const proof = await harness.acquire('session-a');
      const foreignRelease = await harness.release('session-b', proof);
      expect(foreignRelease.isError).toBe(true);
      expect(foreignRelease.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
      const foreignRenew = await harness.renew('session-b', proof);
      expect(foreignRenew.isError).toBe(true);
      expect(foreignRenew.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'active', generation: proof.generation } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('fences an old generation after expiry and re-acquire; the new generation releases', async () => {
    let time = 100_000;
    const harness = await createHarness(() => time);
    try {
      const stale = await harness.acquire('session-a', 600);
      time += 601_000;
      const fresh = await harness.acquire('session-a', 600);
      expect(fresh.generation).toBe(stale.generation + 1);
      const staleRelease = await harness.release('session-a', stale);
      expect(staleRelease.isError).toBe(true);
      expect(staleRelease.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
      expect((await harness.release('session-a', fresh)).isError).not.toBe(true);
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'unleased' } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('refuses release while a fenced mutation is still in flight, and releases after it ends', async () => {
    const harness = await createHarness();
    try {
      const proof = await harness.acquire('session-a');
      const begin = await harness.lease.begin(workspaceId, actor.clientId, 'session-a', 'call-1', proof);
      if (!begin.ok) throw new Error(`begin failed: ${JSON.stringify(begin)}`);
      const blocked = await harness.release('session-a', proof);
      expect(blocked.isError).toBe(true);
      expect(blocked.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
      await harness.lease.end(workspaceId, 'call-1', begin.value.generation);
      expect((await harness.release('session-a', proof)).isError).not.toBe(true);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it('lets exactly one of two concurrent releases win and reports the loser as a conflict', async () => {
    const harness = await createHarness();
    try {
      const proof = await harness.acquire('session-a');
      const [first, second] = await Promise.all([
        harness.release('session-a', proof),
        harness.release('session-a', proof),
      ]);
      const winner = [first, second].filter((response) => !response.isError);
      const loser = [first, second].filter((response) => response.isError);
      expect(winner).toHaveLength(1);
      expect(loser).toHaveLength(1);
      expect(loser[0]!.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await harness.lease.inspect(workspaceId))
        .toMatchObject({ ok: true, value: { state: 'unleased', activeCalls: 0 } });
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});
