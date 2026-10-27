import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function fixture(now?: () => number): Promise<{ one: SqliteWorkspaceWriterLease; two: SqliteWorkspaceWriterLease }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-workspace-lease-'));
  roots.push(root);
  const filename = path.join(root, 'fences.sqlite');
  return {
    one: new SqliteWorkspaceWriterLease(filename, now),
    two: new SqliteWorkspaceWriterLease(filename, now),
  };
}

describe('durable multi-session workspace writer lease', () => {
  it('prevents a lease from racing a mutation admitted while no lease existed', async () => {
    const { one, two } = await fixture();
    const admitted = await one.begin('workspace', 'unleased-client', 'session-one', 'unleased-call');
    expect(admitted).toMatchObject({ ok: true, value: { required: false, generation: 0 } });
    expect(await two.inspect('workspace')).toMatchObject({
      ok: true, value: { state: 'blocked', activeCalls: 1, generation: 0 },
    });
    expect(await two.acquire('workspace', 'new-owner', 'session-two', 60))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await one.end('workspace', 'unleased-call', 0);
    expect(await two.acquire('workspace', 'new-owner', 'session-two', 60))
      .toMatchObject({ ok: true, value: { generation: 1 } });
  });

  it('rejects lease proof when there is no active lease instead of silently ignoring it', async () => {
    const { one } = await fixture();
    expect(await one.begin('workspace', 'owner', 'session', 'forged-call', {
      leaseId: 'none', leaseToken: 'none', generation: 0,
    })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('excludes independent processes/clients from the same workspace while allowing other workspaces', async () => {
    const { one, two } = await fixture();
    const acquired = await one.acquire('workspace', 'client-one', 'session-one', 60);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(await two.acquire('workspace', 'client-two', 'session-two', 60)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.begin('workspace', 'client-two', 'session-two', 'other-call')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.begin('workspace', 'client-one', 'wrong-session', 'other-call', acquired.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.begin('workspace-two', 'client-two', 'session-two', 'other-call')).toMatchObject({ ok: true, value: { required: false } });
    const admitted = await one.begin('workspace', 'client-one', 'session-one', 'owned-call', acquired.value);
    expect(admitted).toMatchObject({ ok: true, value: { required: true } });
    expect(await two.release('workspace', 'client-one', 'session-one', acquired.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await one.end('workspace', 'owned-call', acquired.value.generation);
    expect(await two.release('workspace', 'client-one', 'session-one', acquired.value)).toMatchObject({ ok: true });
    expect(await two.begin('workspace', 'client-two', 'session-two', 'next-call')).toMatchObject({ ok: true, value: { required: false } });
  });

  it('answers release and renew with INVALID_INPUT for null, primitive or malformed proofs without touching lease state', async () => {
    const { one } = await fixture();
    const acquired = await one.acquire('workspace', 'owner', 'session', 600);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const before = await one.inspect('workspace');
    const { leaseId, leaseToken, generation } = acquired.value;
    const malformedProofs: unknown[] = [
      null,
      undefined,
      'stale-token',
      42,
      true,
      {},
      [],
      { leaseId, leaseToken },
      { leaseId, leaseToken, generation: '1' },
      { leaseId, leaseToken, generation: 1.5 },
      { leaseId, leaseToken, generation: -1 },
      { leaseId: 'not-a-uuid', leaseToken, generation },
      { leaseId, leaseToken: '', generation },
      { leaseId, leaseToken: 'x'.repeat(257), generation },
      { leaseId, leaseToken: 42, generation },
      { leaseId, leaseToken: null, generation },
      { leaseId: '12345678-1234-0234-8234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-9234-8234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-a234-8234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-f234-8234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-4234-0234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-4234-7234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-4234-c234-123456789abc', leaseToken, generation },
      { leaseId: '12345678-1234-4234-f234-123456789abc', leaseToken, generation },
      { leaseId, leaseToken, generation: 2 ** 53 },
      { leaseId, leaseToken, generation: -(2 ** 53) },
      { leaseId, leaseToken, generation: 1e100 },
    ];
    for (const proof of malformedProofs) {
      expect(await one.release('workspace', 'owner', 'session', proof as never))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await one.renew('workspace', 'owner', 'session', proof as never, 600))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(await one.inspect('workspace')).toEqual(before);
  });

  it('still routes shape-valid but mismatched proofs to the fencing conflict instead of input validation', async () => {
    const { one } = await fixture();
    const acquired = await one.acquire('workspace', 'owner', 'session', 600);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const shapeValidMismatches: unknown[] = [
      { leaseId: acquired.value.leaseId.toUpperCase(), leaseToken: acquired.value.leaseToken, generation: acquired.value.generation },
      { leaseId: '00000000-0000-0000-0000-000000000000', leaseToken: acquired.value.leaseToken, generation: acquired.value.generation },
      { leaseId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', leaseToken: acquired.value.leaseToken, generation: acquired.value.generation },
      { leaseId: '018f3c44-9a1e-7cc0-9a1b-3d5e7f9a1b2c', leaseToken: acquired.value.leaseToken, generation: acquired.value.generation },
      { leaseId: acquired.value.leaseId, leaseToken: acquired.value.leaseToken, generation: 2 ** 53 - 1 },
      { leaseId: '00000000-0000-0000-0000-000000000000', leaseToken: acquired.value.leaseToken, generation: 0 },
    ];
    for (const proof of shapeValidMismatches) {
      expect(await one.release('workspace', 'owner', 'session', proof as never))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await one.renew('workspace', 'owner', 'session', proof as never, 600))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
    expect(await one.inspect('workspace')).toMatchObject({ ok: true, value: { state: 'active', generation: acquired.value.generation } });
  });

  it('rotates fencing generation on expiry, rejects stale proof and recovers a stopped owner', async () => {
    let time = 0;
    const { one, two } = await fixture(() => time);
    const first = await one.acquire('workspace', 'owner', 'session', 30);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    time = 40_000;
    const second = await two.acquire('workspace', 'new-owner', 'new-session', 30);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.generation).toBe(first.value.generation + 1);
    expect(await one.begin('workspace', 'owner', 'session', 'stale', first.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await one.release('workspace', 'owner', 'session', first.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.begin('workspace', 'new-owner', 'new-session', 'new-call', second.value)).toMatchObject({ ok: true });
    await two.end('workspace', 'new-call', second.value.generation);
  });

  it('refuses expiry takeover while a live prior invocation is still pinned', async () => {
    let time = 0;
    const { one, two } = await fixture(() => time);
    const first = await one.acquire('workspace', 'owner', 'session', 30);
    if (!first.ok) throw new Error('unexpected acquisition failure');
    expect(await one.begin('workspace', 'owner', 'session', 'running', first.value)).toMatchObject({ ok: true });
    time = 35_000;
    expect(await two.acquire('workspace', 'different', 'session-2', 30)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await one.end('workspace', 'running', first.value.generation);
    expect(await two.acquire('workspace', 'different', 'session-2', 30)).toMatchObject({ ok: true });
  });

  it('does not prematurely recover a pre-migration lease with unknown activity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-writer-upgrade-'));
    roots.push(root);
    const filename = path.join(root, 'existing.sqlite');
    const db = new DatabaseSync(filename);
    try {
      db.exec('CREATE TABLE workspace_writer_leases (workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, lease_id TEXT, token_hash TEXT, owner_client_id TEXT, owner_session_id TEXT, expires_at INTEGER NOT NULL DEFAULT 0)');
      db.prepare('INSERT INTO workspace_writer_leases VALUES (?,?,?,?,?,?,?)')
        .run('workspace', 12, 'old-lease', 'old-digest', 'owner', 'prior', 500_000);
    } finally {
      db.close();
    }
    const lease = new SqliteWorkspaceWriterLease(filename, () => 100_000);
    expect(await lease.inspect('workspace')).toMatchObject({ ok: true, value: { state: 'active', generation: 12 } });
    expect(await lease.acquire('workspace', 'owner', 'new-session', 600, true))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('recovers an idle same-client session after grace and revokes stale proof', async () => {
    let time = 100_000;
    const { one, two } = await fixture(() => time);
    const first = await one.acquire('workspace', 'owner', 'old-session', 600);
    if (!first.ok) throw new Error('unexpected lease failure');
    expect(await two.acquire('workspace', 'owner', 'new-session', 600, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    time += 61_000;
    expect(await two.acquire('workspace', 'other-owner', 'new-session', 600, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.acquire('workspace', 'owner', 'new-session', 600)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.acquire('workspace', 'owner', 'old-session', 600, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const second = await two.acquire('workspace', 'owner', 'new-session', 600, true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.generation).toBe(first.value.generation + 1);
    expect(await one.begin('workspace', 'owner', 'old-session', 'stale', first.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await one.release('workspace', 'owner', 'old-session', first.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await two.begin('workspace', 'owner', 'new-session', 'new-call', second.value)).toMatchObject({ ok: true });
    await two.end('workspace', 'new-call', second.value.generation);
  });

  it('blocks an active writer and waits another grace interval after it finishes', async () => {
    let time = 100_000;
    const { one, two } = await fixture(() => time);
    const owned = await one.acquire('workspace', 'owner', 'old-session', 600);
    if (!owned.ok) throw new Error('lease not acquired');
    expect(await one.begin('workspace', 'owner', 'old-session', 'active-call', owned.value)).toMatchObject({ ok: true });
    time += 61_000;
    expect(await two.acquire('workspace', 'owner', 'new-session', 600, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await one.end('workspace', 'active-call', owned.value.generation);
    expect(await two.acquire('workspace', 'owner', 'new-session', 600, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    time += 61_000;
    expect(await two.acquire('workspace', 'owner', 'new-session', 600, true)).toMatchObject({ ok: true, value: { generation: 2 } });
  });

  it('only grants one recovery when two same-client sessions race', async () => {
    let time = 100_000;
    const { one, two } = await fixture(() => time);
    const original = await one.acquire('workspace', 'owner', 'initial-session', 600);
    if (!original.ok) throw new Error('lease not acquired');
    time += 61_000;
    const result = await Promise.all([
      one.acquire('workspace', 'owner', 'next-a', 600, true),
      two.acquire('workspace', 'owner', 'next-b', 600, true),
    ]);
    expect(result.filter((entry) => entry.ok)).toHaveLength(1);
    expect(result.filter((entry) => !entry.ok)).toHaveLength(1);
    expect(result.find((entry) => entry.ok)).toMatchObject({ ok: true, value: { generation: 2 } });
    expect(result.find((entry) => !entry.ok)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
});
