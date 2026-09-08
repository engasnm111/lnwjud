import { describe, expect, it } from 'vitest';
import { MacosProcessBridge, unavailableMacosHost } from './macos-process-bridge.js';

describe('MacosProcessBridge', () => {
  it('rejects an invalid operation before attempting to start the helper', async (): Promise<void> => {
    let started = false;
    const bridge = new MacosProcessBridge({
      executablePath: '/missing/lnwjud-macos-host',
      terminator: { stop: async (): Promise<void> => undefined },
      spawnProcess: (): never => {
        started = true;
        throw new Error('must not start');
      },
    });

    await expect(bridge.execute('../escape', {})).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(started).toBe(false);
  });

  it('exposes a stable missing-host result for composition diagnostics', (): void => {
    expect(unavailableMacosHost()).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
  });
});
