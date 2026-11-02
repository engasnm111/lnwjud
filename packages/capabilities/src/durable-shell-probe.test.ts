import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: execFileMock }));

import { probeProcessIdentity } from './durable-shell-task-store.js';
import { createPosixProcessIdentityProbe } from '../../process/src/posix-process-identity.js';

afterEach(() => { vi.restoreAllMocks(); execFileMock.mockReset(); });

function failProbe(code: string): void {
  execFileMock.mockImplementation((...args: unknown[]): void => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error('probe unavailable'), { code }), '', '');
  });
}

describe('durable process identity probe failures', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('does not treat a missing probe executable as process exit on %s', async (platform) => {
    failProbe('ENOENT');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(await probeProcessIdentity(4242, platform)).toEqual({ state: 'unverifiable', reason: 'probe_failed' });
  });

  it('recognizes kernel-confirmed exit after an unavailable probe', async () => {
    failProbe('ENOENT');
    vi.spyOn(process, 'kill').mockImplementationOnce((): boolean => true)
      .mockImplementationOnce((): never => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(await probeProcessIdentity(4242, 'linux')).toEqual({ state: 'gone' });
  });

  it('does not treat a missing ps executable as a missing process in the POSIX identity probe', async () => {
    failProbe('ENOENT');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(createPosixProcessIdentityProbe('linux')(4242)).rejects.toThrow('could not be verified');
  });
});
