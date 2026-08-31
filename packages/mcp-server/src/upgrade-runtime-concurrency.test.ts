import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { UpgradeRuntimeStateStore } from './upgrade-runtime-state-store.js';

const actorA: FileActor = { clientId: 'client', clientName: 'test', sessionId: 'session-a' };
const actorB: FileActor = { clientId: 'client', clientName: 'test', sessionId: 'session-b' };

describe('upgrade runtime multi-session persistence', () => {
  it('merges concurrent checkpoints for the same session while isolating another session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const first = new UpgradeRuntimeService({ runtimeStatePath }, actorA);
    const second = new UpgradeRuntimeService({ runtimeStatePath }, actorA);

    await Promise.all([
      first.execute('session_checkpoint', { summary: 'checkpoint-a' }),
      second.execute('session_checkpoint', { summary: 'checkpoint-b' }),
    ]);

    const resumed = await new UpgradeRuntimeService({ runtimeStatePath }, actorA).execute('session_history', {});
    expect(resumed).toMatchObject({ ok: true, value: { checkpoints: expect.arrayContaining([
      expect.objectContaining({ summary: 'checkpoint-a' }),
      expect.objectContaining({ summary: 'checkpoint-b' }),
    ]) } });
    if (resumed.ok) expect(resumed.value.checkpoints).toHaveLength(2);

    const isolated = await new UpgradeRuntimeService({ runtimeStatePath }, actorB).execute('session_context', {});
    expect(isolated).toMatchObject({ ok: true, value: { session: {}, checkpoints: [] } });
  });

  it('does not synthesize global plugin mutations from independent sessions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const first = new UpgradeRuntimeService({ runtimeStatePath }, actorA);
    const second = new UpgradeRuntimeService({ runtimeStatePath }, actorB);

    const results = await Promise.all([
      first.execute('plugin_install', { name: 'plugin-a' }),
      second.execute('plugin_install', { name: 'plugin-b' }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'disabled', executed: false }) }),
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'disabled', executed: false }) }),
    ]);
    const shared = await new UpgradeRuntimeStateStore(runtimeStatePath, 'audit').readShared();
    expect(shared.plugins).toEqual([]);
  });

  it('keeps shared worktree ledger entries session-owned', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const calls: unknown[] = [];
    const services = {
      runtimeStatePath,
      git: {
        async run(_actor: FileActor, request: unknown): Promise<ReturnType<typeof ok>> {
          calls.push(request);
          return ok({ exitCode: 0, stdout: 'ok', stderr: '' });
        },
      },
    };
    const first = new UpgradeRuntimeService(services, actorA);
    const second = new UpgradeRuntimeService(services, actorB);
    const [spawnA, spawnB] = await Promise.all([
      first.execute('git_worktree_spawn', {
        workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', ref: 'main', dryRun: false, userConfirmed: true,
      }),
      second.execute('git_worktree_spawn', {
        workspaceId: 'ws-1', worktreePath: '.worktrees/session-b', ref: 'main', dryRun: false, userConfirmed: true,
      }),
    ]);
    expect(spawnA).toMatchObject({ ok: true, value: { status: 'completed', ownerSessionId: 'session-a' } });
    expect(spawnB).toMatchObject({ ok: true, value: { status: 'completed', ownerSessionId: 'session-b' } });

    const other = new UpgradeRuntimeService(services, actorB);
    await expect(other.execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toHaveLength(2);

    await expect(new UpgradeRuntimeService(services, actorA).execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    await expect(new UpgradeRuntimeService(services, actorB).execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-b', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(calls).toHaveLength(4);
  });
});
