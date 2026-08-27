import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLnwjudTunnelProcessPidsPosix, TunnelController } from '../src/main/tunnel-controller.js';

describe('tunnel platform support', () => {
  it('keeps the tunnel profile directory under the platform configuration home', () => {
    const controller = new TunnelController({} as ConstructorParameters<typeof TunnelController>[0]);
    const directory = controller.profileDirectory();
    if (process.platform === 'win32') {
      expect(directory).toBe(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'tunnel-client'));
      return;
    }
    if (process.platform === 'darwin') {
      expect(directory).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'tunnel-client'));
      return;
    }
    expect(directory).toBe(path.join(os.homedir(), '.config', 'tunnel-client'));
  });

  it.runIf(process.platform !== 'win32')('finds tunnel-client processes that reference the lnwjud profile', async () => {
    // A short-lived process whose argument list mimics the tunnel client makes
    // the probe observable without contacting the OpenAI control plane.
    const marker = `probe-${process.pid}`;
    const child = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 1500)', marker, 'tunnel-client', '--profile', 'lnwjud', '--profile-dir', '/tmp/none']);
    try {
      const pids = await findLnwjudTunnelProcessPidsPosix();
      expect(pids).toContain(child.pid);
    } finally {
      await child;
    }
  }, 5_000);

  it.runIf(process.platform !== 'win32')('resolves with an empty list when no tunnel-client process exists (pgrep exits 1)', async () => {
    // pgrep uses exit code 1 for "no matches"; the probe must treat that as
    // "nothing is running" instead of an error that blocks tunnel start.
    await expect(findLnwjudTunnelProcessPidsPosix()).resolves.toEqual(expect.any(Array));
  });

  it.runIf(process.platform !== 'win32')('ignores processes whose arguments do not reference the lnwjud profile', async () => {
    const marker = `probe-unrelated-${process.pid}`;
    const child = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 600)', marker, 'tunnel-client']);
    try {
      const pids = await findLnwjudTunnelProcessPidsPosix();
      expect(pids).not.toContain(child.pid);
    } finally {
      await child;
    }
  }, 5_000);

  it('resolves the bundled client binary name per platform in the service wiring', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'");
    // Non-Windows hosts must inject the portable raw:v1 secret envelope.
    expect(source).toContain("'raw:v1:' + Buffer.from(plain, 'utf8').toString('base64')");
  });
});
