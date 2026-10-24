import { copyFile, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeUpdateBootstrapClient, NativeUpdateBootstrapClient } from '../src/main/native-update-client.js';
import { UPDATE_WORKER_PIN_SHA256, UPDATE_WORKER_SHA256 } from '../src/main/update-worker-integrity.generated.js';

const resourceDirectory = path.resolve(import.meta.dirname, '../build');
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('published native update worker', () => {
  it('uses the real prepared worker for startup and advertises bootstrap-only capability', async () => {
    const directory = await temporaryDirectory();
    const client = createNativeUpdateBootstrapClient(directory, process.execPath, resourceDirectory);
    await expect(client.recoverBeforeStartup()).resolves.toEqual({ kind: 'ready' });
    await expect(client.automaticCapability()).resolves.toEqual({ kind: 'unavailable', reason: 'TRANSACTION_BOOTSTRAP_ONLY' });
    expect((await lstat(path.join(directory, 'update-transactions', 'owner.lock'))).isFile()).toBe(true);
  });

  it('holds corrupt pending state using the actual worker and preserves the evidence', async () => {
    const directory = await temporaryDirectory();
    const client = createNativeUpdateBootstrapClient(directory, process.execPath, resourceDirectory);
    await expect(client.recoverBeforeStartup()).resolves.toEqual({ kind: 'ready' });
    const journal = path.join(directory, 'update-transactions', 'journal.json');
    await writeFile(journal, '{invalid pending transaction');
    expect((await client.recoverBeforeStartup()).kind).toBe('held');
    expect(await readFile(journal, 'utf8')).toBe('{invalid pending transaction');
  });

  it('rejects changed executable bytes before spawning any worker', async () => {
    const directory = await temporaryDirectory();
    const executable = path.join(directory, 'changed-worker.exe');
    await copyFile(path.join(resourceDirectory, 'update-worker', 'lnwjud-update-worker.exe'), executable);
    await writeFile(executable, Buffer.from('changed'), { flag: 'a' });
    const stateRoot = path.join(directory, 'state');
    const client = new NativeUpdateBootstrapClient({
      executable, executableSha256: UPDATE_WORKER_SHA256,
      pinModule: path.join(resourceDirectory, 'native-containment', 'lnwjud-containment-pin.node'),
      pinSha256: UPDATE_WORKER_PIN_SHA256, stateRoot, installationId: 'a'.repeat(64),
    });
    await expect(client.automaticCapability()).resolves.toEqual({ kind: 'unavailable', reason: 'UPDATE_WORKER_UNAVAILABLE' });
    await expect(lstat(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not inherit managed runtime injection controls into the pinned child', async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv('DOTNET_STARTUP_HOOKS', path.join(directory, 'untrusted-hook.dll'));
    vi.stubEnv('DOTNET_ADDITIONAL_DEPS', path.join(directory, 'untrusted-dependencies.json'));
    vi.stubEnv('CORECLR_ENABLE_PROFILING', '1');
    const client = createNativeUpdateBootstrapClient(directory, process.execPath, resourceDirectory);
    await expect(client.automaticCapability()).resolves.toEqual({ kind: 'unavailable', reason: 'TRANSACTION_BOOTSTRAP_ONLY' });
  });
});
