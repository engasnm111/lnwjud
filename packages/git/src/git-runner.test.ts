import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { ProcessTreeTerminator } from '@lnwjud/process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { DirectGitRunner } from './git-runner.js';

function fakeChild(pid = 4_242): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function closeChild(child: ChildProcess, exitCode: number): void {
  Object.assign(child, { exitCode });
  child.emit('close', exitCode, null);
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('DirectGitRunner cancellation', () => {
  it('rejects oversized Git output instead of presenting an incomplete directory listing', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const terminator: ProcessTreeTerminator = { stop: vi.fn(async () => undefined) };
    const running = new DirectGitRunner(terminator).run(['status','--untracked-files=all'], 'C:\\workspace');
    child.stdout?.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    await expect(running).resolves.toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining('safe capture limit'),
    });
    expect(terminator.stop).toHaveBeenCalledTimes(1);
  });

  it('decodes UTF-8 filenames across output chunks without replacement characters', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const running = new DirectGitRunner().run(['status'], 'C:\\workspace');
    const bytes = Buffer.from('?? โฟลเดอร์/สินค้า.txt\0');
    child.stdout?.emit('data', bytes.subarray(0, 7));
    child.stdout?.emit('data', bytes.subarray(7));
    closeChild(child, 0);
    await expect(running).resolves.toMatchObject({ exitCode: 0, stdout: '?? โฟลเดอร์/สินค้า.txt\0' });
  });

  it('does not spawn Git when the invocation was already aborted', async () => {
    const child = fakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => closeChild(child, 0));
      return child;
    });
    const terminator: ProcessTreeTerminator = { stop: vi.fn(async () => undefined) };
    const controller = new AbortController();
    controller.abort();

    const result = await new DirectGitRunner(terminator).run(['status'], 'C:\\workspace', {
      signal: controller.signal,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(terminator.stop).not.toHaveBeenCalled();
    expect(result).toEqual({ exitCode: -1, stdout: '', stderr: 'Git command cancelled' });
  });

  it('terminates the exact spawned process tree and waits for verified exit', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let releaseTermination: (() => void) | undefined;
    const verifiedExit = new Promise<void>((resolve) => { releaseTermination = resolve; });
    const terminator: ProcessTreeTerminator = { stop: vi.fn(async () => verifiedExit) };
    const controller = new AbortController();
    const runner = new DirectGitRunner(terminator);
    let settled = false;

    const running = runner.run(['fetch'], 'C:\\workspace', { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    if (vi.mocked(terminator.stop).mock.calls.length === 0) {
      closeChild(child, 0);
      await running;
    }
    expect(terminator.stop).toHaveBeenCalledWith(child, 4_242);
    closeChild(child, 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTermination?.();
    await expect(running).resolves.toEqual({ exitCode: -1, stdout: '', stderr: 'Git command cancelled' });
  });

  it('removes the abort listener after normal completion', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const terminator: ProcessTreeTerminator = { stop: vi.fn(async () => undefined) };
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const running = new DirectGitRunner(terminator).run(['status'], 'C:\\workspace', {
      signal: controller.signal,
    });
    closeChild(child, 0);

    await expect(running).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps the run unsettled after a failed tree stop and retries until verification succeeds', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let attempts = 0;
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const terminator: ProcessTreeTerminator = {
      stop: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('tree verification unavailable');
        await verification;
      }),
    };
    const controller = new AbortController();
    let settled = false;
    const running = new DirectGitRunner(terminator, 1).run(['fetch'], 'C:\\workspace', { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });

    controller.abort();
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    closeChild(child, 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseVerification();
    await expect(running).resolves.toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining('tree verification unavailable'),
    });
  });
});
