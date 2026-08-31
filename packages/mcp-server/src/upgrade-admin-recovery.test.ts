import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';

const actor: FileActor = { clientId: 'admin-recovery', clientName: 'admin-recovery-test', sessionId: 'session-a' };

describe('upgrade administrative recovery snapshots', () => {
  it('does not create plugin recovery state for disabled plugin operations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-upgrade-admin-'));
    const runtimeStatePath = path.join(directory, 'runtime.json');
    const recoveryDirectory = path.join(directory, 'runtime.state-v2', 'recovery');
    const runtime = new UpgradeRuntimeService({ runtimeStatePath }, actor);

    await expect(runtime.execute('plugin_install', { name: 'safe-plugin' }))
      .resolves.toMatchObject({ ok: true, value: { status: 'disabled', executed: false } });
    await expect(runtime.execute('plugin_remove', { name: 'safe-plugin', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { status: 'disabled', executed: false } });

    const snapshots = await readRecoverySnapshots(recoveryDirectory).catch(() => []);
    expect(snapshots.some((snapshot) => snapshot.plugins?.some((plugin) => plugin.name === 'safe-plugin'))).toBe(false);
  });

  it('keeps a recoverable worktree-ledger pre-image when a ledger entry is removed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-upgrade-admin-'));
    const runtimeStatePath = path.join(directory, 'runtime.json');
    const recoveryDirectory = path.join(directory, 'runtime.state-v2', 'recovery');
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runtime = new UpgradeRuntimeService({
      runtimeStatePath,
      git: {
        async run(_actor, request): Promise<ReturnType<typeof ok>> {
          mutableCalls.push([...(request as { args?: readonly string[] }).args ?? []]);
          return ok({ exitCode: 0, stdout: 'ok', stderr: '' });
        },
      },
    }, actor);

    await expect(runtime.execute('git_worktree_spawn', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', ref: 'main', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    await expect(runtime.execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/agent-1', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });

    expect(mutableCalls.at(-1)).toEqual(['worktree', 'remove', '.worktrees/agent-1']);
    const snapshots = await readRecoverySnapshots(recoveryDirectory);
    expect(snapshots.some((snapshot) => snapshot.worktrees?.some((worktree) => worktree.worktreePath === '.worktrees/agent-1'))).toBe(true);
  });
});

async function readRecoverySnapshots(directory: string): Promise<Array<{
  plugins?: Array<{ name?: string }>;
  worktrees?: Array<{ worktreePath?: string }>;
}>> {
  const names = await readdir(directory);
  return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => (
    JSON.parse(await readFile(path.join(directory, name), 'utf8')) as {
      plugins?: Array<{ name?: string }>;
      worktrees?: Array<{ worktreePath?: string }>;
    }
  )));
}
