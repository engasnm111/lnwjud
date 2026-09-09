import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_DRAINING_ERROR, DesktopIpcDrainBarrier } from '../src/main/desktop-ipc-drain.js';

describe('Desktop IPC drain barrier', () => {
  it('waits for in-flight IPC before allowing runtime shutdown to continue', async () => {
    const barrier = new DesktopIpcDrainBarrier();
    const pending = deferred<void>();
    const started = vi.fn();

    const invocation = barrier.run(async () => {
      started();
      await pending.promise;
      return 'done';
    });

    expect(started).toHaveBeenCalledOnce();
    expect(barrier.activeCount()).toBe(1);
    const draining = barrier.beginDrain();
    expect(barrier.isDraining()).toBe(true);

    let drained = false;
    void draining.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    pending.resolve();
    await expect(invocation).resolves.toBe('done');
    await expect(draining).resolves.toBeUndefined();
    expect(barrier.activeCount()).toBe(0);
  });

  it('rejects new IPC while draining and permits work again after resume', async () => {
    const barrier = new DesktopIpcDrainBarrier();
    await barrier.beginDrain();

    await expect(barrier.run(async () => 'blocked')).rejects.toThrow(DESKTOP_IPC_DRAINING_ERROR);
    barrier.resume();
    await expect(barrier.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('coalesces concurrent drain requests onto the same in-flight barrier', async () => {
    const barrier = new DesktopIpcDrainBarrier();
    const pending = deferred<void>();
    const invocation = barrier.run(async () => pending.promise);

    const first = barrier.beginDrain();
    const second = barrier.beginDrain();
    expect(second).toBe(first);

    pending.resolve();
    await invocation;
    await Promise.all([first, second]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void } {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
