import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { removeTemporaryDirectory, waitForProcessExit } from '../scripts/electron-startup-cleanup.mjs';

describe('Electron startup diagnostic cleanup', () => {
  it.each(['EBUSY', 'EPERM', 'ENOTEMPTY'])('retries temporary directory removal after %s', async (code) => {
    let attempts = 0;
    const delays: number[] = [];

    await removeTemporaryDirectory('C:\\Temp\\lnwjud-electron-startup', {
      remove: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error(code), { code });
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(attempts).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it('waits for the Electron process to emit close before cleanup continues', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null });
    const waiting = waitForProcessExit(child, 100);

    child.exitCode = 0;
    child.emit('close', 0);

    await expect(waiting).resolves.toBeUndefined();
  });
});
