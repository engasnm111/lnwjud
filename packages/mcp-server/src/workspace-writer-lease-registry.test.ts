import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteWorkspaceWriterLease, type WorkspaceWriterLeaseProof } from '@lnwjud/capabilities';
import { ActivityTracker } from './activity-tracker.js';
import { ToolRegistry } from './tool-registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{
  lease: SqliteWorkspaceWriterLease;
  owner: ToolRegistry;
  registry: (sessionId?: string) => ToolRegistry;
  proof: WorkspaceWriterLeaseProof & { expiresAt: string };
  recorded: unknown[];
  advance: () => void;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'lnwjud-registry-lease-'));
  roots.push(root);
  let now = Date.now();
  const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), () => now);
  const recorded: unknown[] = [];
  const tracker = new ActivityTracker({ async record(event): Promise<void> { recorded.push(event); } }, undefined, {
    async record(event, detail): Promise<void> { recorded.push({ event, detail }); },
  });
  const registry = (sessionId = 'session-a'): ToolRegistry => new ToolRegistry({ workspaceWriterLease: lease }, {
    clientId: 'client-a', clientName: 'test', sessionId,
  }, { activityTracker: tracker, authorizationModeProvider: (): 'full_bypass' => 'full_bypass' });
  const owner = registry();
  const acquired = await owner.invoke('workspace_writer_lease_acquire', { workspaceId: 'workspace-a', ttlSeconds: 60 });
  expect(acquired.isError).not.toBe(true);
  const proof = acquired.structuredContent as unknown as WorkspaceWriterLeaseProof & { expiresAt: string };
  expect(proof.leaseToken).toEqual(expect.any(String));
  return { lease, owner, registry, proof, recorded, advance: (): void => { now += 1_000; } };
}

describe('workspace writer lease control through the registry', () => {
  it('releases a freshly acquired proof through the control handler', async () => {
    const f = await fixture();
    expect((await f.owner.invoke('workspace_writer_lease_release', { workspaceId: 'workspace-a', writerLease: f.proof })).isError).not.toBe(true);
    expect(await f.lease.inspect('workspace-a')).toMatchObject({ ok: true, value: { state: 'unleased' } });
    expect(JSON.stringify(f.recorded)).not.toContain(f.proof.leaseToken);
  });

  it('renews persisted expiry and releases the acquired lease without recording credentials', async () => {
    const f = await fixture();
    f.advance();
    const renewed = await f.owner.invoke('workspace_writer_lease_renew', { workspaceId: 'workspace-a', writerLease: f.proof, ttlSeconds: 600 });
    expect(renewed.isError).not.toBe(true);
    const expiresAt = renewed.structuredContent?.expiresAt as string;
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(f.proof.expiresAt));
    expect(await f.lease.inspect('workspace-a')).toMatchObject({ ok: true, value: { state: 'active', expiresAt, activeCalls: 0 } });
    expect((await f.owner.invoke('workspace_writer_lease_release', { workspaceId: 'workspace-a', writerLease: f.proof })).isError).not.toBe(true);
    expect(await f.lease.inspect('workspace-a')).toMatchObject({ ok: true, value: { state: 'unleased', activeCalls: 0 } });
    expect(JSON.stringify(f.recorded)).not.toContain(f.proof.leaseToken);
  });

  it('rejects wrong tokens, stale generations and other sessions without leaking credentials', async () => {
    const f = await fixture();
    for (const tool of ['workspace_writer_lease_renew', 'workspace_writer_lease_release']) {
      for (const [registry, proof] of [
        [f.owner, { ...f.proof, leaseToken: 'wrong-private-token' }],
        [f.owner, { ...f.proof, generation: f.proof.generation + 1 }],
        [f.registry('session-b'), f.proof],
      ] as const) {
        expect(await registry.invoke(tool, { workspaceId: 'workspace-a', writerLease: proof, ttlSeconds: 600 }))
          .toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      }
    }
    expect(await f.lease.inspect('workspace-a')).toMatchObject({ ok: true, value: { state: 'active', expiresAt: f.proof.expiresAt } });
    expect(JSON.stringify(f.recorded)).not.toContain(f.proof.leaseToken);
    expect(JSON.stringify(f.recorded)).not.toContain('wrong-private-token');
    expect((await f.owner.invoke('workspace_writer_lease_renew', {
      workspaceId: 'workspace-a', writerLease: { ...f.proof, generation: -1 },
    })).isError).toBe(true);
    expect(JSON.stringify(f.recorded)).not.toContain(f.proof.leaseToken);
  });
});
