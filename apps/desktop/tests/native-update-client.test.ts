import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeUpdateBootstrapClient, parseUpdateWorkerReply } from '../src/main/native-update-client.js';
import { UPDATE_WORKER_BUILD_ID } from '../src/main/update-worker-integrity.generated.js';

const installationId = '1'.repeat(64);
const requestId = 'native-update-client-test';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function reply(result: unknown): Record<string, unknown> {
  return { protocol: 1, buildId: UPDATE_WORKER_BUILD_ID, installationId, requestId, generation: '0', revision: '0', result };
}

async function unavailableAuthority(): Promise<{ client: NativeUpdateBootstrapClient; stateRoot: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-client-'));
  temporaryDirectories.push(directory);
  const stateRoot = path.join(directory, 'state');
  return {
    stateRoot,
    client: new NativeUpdateBootstrapClient({
      executable: path.join(directory, 'missing-worker.exe'), executableSha256: '2'.repeat(64),
      pinModule: path.join(directory, 'missing-pin.node'), pinSha256: '3'.repeat(64),
      stateRoot, installationId,
    }),
  };
}

describe('native update bootstrap boundary', () => {
  it('rejects a safe-start response for a different installation or request', () => {
    const value = reply({ kind: 'none', safeToStart: true });
    expect(() => parseUpdateWorkerReply(value, { installationId: '4'.repeat(64), requestId })).toThrow('UPDATE_WORKER_RESPONSE_INVALID');
    expect(() => parseUpdateWorkerReply(value, { installationId, requestId: 'other-request' })).toThrow('UPDATE_WORKER_RESPONSE_INVALID');
  });

  it('never accepts invented safe startup from an unknown or overflowing journal position', () => {
    for (const generation of [null, '01', '-1', '18446744073709551616']) {
      expect(() => parseUpdateWorkerReply({ ...reply({ kind: 'none', safeToStart: true }), generation }, { installationId, requestId }))
        .toThrow('UPDATE_WORKER_RESPONSE_INVALID');
    }
  });

  it('rejects unsupported installation capability and future success replies', () => {
    for (const result of [
      { kind: 'capabilities', platform: 'windows', architecture: 'x64', automaticInstallation: 'available' },
      { kind: 'committed', safeToStart: true },
      { kind: 'none', safeToStart: false },
    ]) {
      expect(() => parseUpdateWorkerReply(reply(result), { installationId, requestId })).toThrow('UPDATE_WORKER_RESPONSE_INVALID');
    }
  });

  it('refuses fabricated recovery without a durable transaction and advanced position', () => {
    for (const transactionId of ['', 'invented-transaction', '8d71de52-7cf0-4ce0-b678-a823e795b7a9']) {
      expect(() => parseUpdateWorkerReply(reply({ kind: 'recovered', reason: 'PREAUTH_OWNER_RECOVERED', safeToStart: true,
        transactionId, phase: 'unavailable' }), { installationId, requestId })).toThrow('UPDATE_WORKER_RESPONSE_INVALID');
    }
    expect(() => parseUpdateWorkerReply({ ...reply({ kind: 'held', reason: 'OWNER_BUSY', safeToStart: false }), generation: null },
      { installationId, requestId })).toThrow('UPDATE_WORKER_RESPONSE_INVALID');
  });

  it('keeps ordinary startup available when no update store or worker exists', async () => {
    const { client } = await unavailableAuthority();
    await expect(client.recoverBeforeStartup()).resolves.toEqual({ kind: 'ready' });
    await expect(client.automaticCapability()).resolves.toEqual({ kind: 'unavailable', reason: 'UPDATE_WORKER_UNAVAILABLE' });
  });

  it('holds writable startup and preserves uncertain pending state when authority is unavailable', async () => {
    const { client, stateRoot } = await unavailableAuthority();
    await mkdir(stateRoot);
    const journal = path.join(stateRoot, 'journal.json');
    await writeFile(journal, '{corrupt pending update');
    await expect(client.recoverBeforeStartup()).resolves.toEqual({ kind: 'held', reason: 'UPDATE_RECOVERY_AUTHORITY_UNAVAILABLE' });
    expect(await readFile(journal, 'utf8')).toBe('{corrupt pending update');
  });
});
