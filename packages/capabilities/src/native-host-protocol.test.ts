import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeHostProcessBridge } from './native-host-protocol.js';
import type { ProcessTreeTerminator } from '@lnwjud/process';

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 45_678;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;

  public constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as { id: string; input?: { order?: number } };
        const delay = request.input?.order === 1 ? 20 : 1;
        setTimeout(() => this.stdout.write(JSON.stringify({ id: request.id, ok: true, value: request.input })) && this.stdout.write('\n'), delay);
      }
    });
  }

  public kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('close');
    return true;
  }
}

const terminator: ProcessTreeTerminator = {
  stop: async (child) => { child.kill(); },
};

const children: FakeChild[] = [];
afterEach(() => {
  for (const child of children) child.kill();
  children.splice(0);
});

describe('NativeHostProcessBridge', () => {
  it.each(['darwin', 'linux'] as const)('preserves split UTF-8 responses on %s', async (platform) => {
    const bridge = new NativeHostProcessBridge({
      platform,
      executablePath: '/opt/lnwjud-native-host',
      terminator,
      spawnProcess: (): never => {
        const child = new FakeChild();
        child.stdin.removeAllListeners('data');
        child.stdin.on('data', (chunk: Buffer) => {
          const request = JSON.parse(chunk.toString('utf8')) as { id: string; input: unknown };
          const response = Buffer.from(`${JSON.stringify({ id: request.id, ok: true, value: request.input })}\n`, 'utf8');
          // Force every two-, three-, and four-byte character across stream
          // boundaries, exercising the bridge's public request/response path.
          for (const byte of response) child.stdout.write(Buffer.from([byte]));
        });
        children.push(child);
        return child as never;
      },
    });
    try {
      for (const text of ['ภาษาไทย café 😀', '次の応答 — naïve 🚀']) {
        await expect(bridge.execute('observe', { text })).resolves.toEqual({ ok: true, value: { text } });
      }
    } finally {
      await bridge.close();
    }
  });

  it('matches concurrent out-of-order responses by request id', async () => {
    const bridge = new NativeHostProcessBridge({
      platform: 'linux',
      executablePath: '/opt/lnwjud-native-host',
      terminator,
      spawnProcess: (): never => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
    });
    const first = bridge.execute('observe', { order: 1 });
    const second = bridge.execute('observe', { order: 2 });
    await expect(first).resolves.toMatchObject({ ok: true, value: { order: 1 } });
    await expect(second).resolves.toMatchObject({ ok: true, value: { order: 2 } });
    await bridge.close();
  });

  it('bounds each unfinished response instead of accumulating lifetime output', async () => {
    const bridge = new NativeHostProcessBridge({
      platform: 'linux',
      executablePath: '/opt/lnwjud-native-host',
      maxPayloadBytes: 1024,
      terminator,
      spawnProcess: (): never => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
    });
    const requests = Array.from({ length: 32 }, (_, order) => bridge.execute('observe', { order }));
    await expect(Promise.all(requests)).resolves.toHaveLength(32);
    await expect(bridge.close()).resolves.toMatchObject({ ok: true });
  });

  it('does not spawn a replacement while a signalled helper has not exited', async () => {
    let starts = 0;
    let child: FakeChild | undefined;
    const bridge = new NativeHostProcessBridge({
      platform: 'linux',
      executablePath: '/opt/lnwjud-native-host',
      terminator,
      spawnProcess: (): never => {
        starts += 1;
        child = new FakeChild();
        children.push(child);
        return child as never;
      },
    });
    await expect(bridge.execute('observe', { order: 1 })).resolves.toMatchObject({ ok: true });
    child!.killed = true;
    await expect(bridge.execute('observe', { order: 2 })).resolves.toMatchObject({ ok: true });
    expect(starts).toBe(1);
    await expect(bridge.close()).resolves.toMatchObject({ ok: true });
  });

  it('rejects oversized requests before spawning a helper', async () => {
    let starts = 0;
    const bridge = new NativeHostProcessBridge({
      platform: 'darwin',
      executablePath: '/opt/lnwjud-native-host',
      maxPayloadBytes: 1024,
      terminator,
      spawnProcess: (): never => { starts += 1; return new FakeChild() as never; },
    });
    await expect(bridge.execute('observe', 'x'.repeat(2_000))).resolves.toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
    expect(starts).toBe(0);
  });

  it('does not inherit credential-looking environment variables into the native helper', async () => {
    const originalApiKey = process.env.CONTROL_PLANE_API_KEY;
    const originalDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.CONTROL_PLANE_API_KEY = 'must-not-reach-native-host';
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/session-bus';
    let spawnEnvironment: NodeJS.ProcessEnv | undefined;
    try {
      const bridge = new NativeHostProcessBridge({
        platform: 'linux',
        executablePath: '/opt/lnwjud-native-host',
        terminator,
        spawnProcess: (_executable, _args, options): never => {
          spawnEnvironment = options.env;
          const child = new FakeChild();
          children.push(child);
          return child as never;
        },
      });
      await expect(bridge.execute('observe', {})).resolves.toMatchObject({ ok: true });
      await bridge.close();
    } finally {
      if (originalApiKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = originalApiKey;
      if (originalDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = originalDbus;
    }
    expect(spawnEnvironment?.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(spawnEnvironment?.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/session-bus');
  });

  it('does not claim cancellation while helper termination is unverified', async () => {
    const controller = new AbortController();
    const bridge = new NativeHostProcessBridge({
      platform: 'linux',
      executablePath: '/opt/lnwjud-native-host',
      timeoutMs: 5_000,
      terminator: { stop: async (): Promise<void> => { throw new Error('still alive'); } },
      spawnProcess: (): never => {
        const child = new FakeChild();
        child.stdin.removeAllListeners('data');
        children.push(child);
        return child as never;
      },
    });
    const pending = bridge.execute('observe', {}, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT', message: expect.stringContaining('termination could not be verified') },
    });
    await expect(bridge.execute('observe', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT', message: expect.stringContaining('refusing to reuse') },
    });
    await expect(bridge.close()).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('fails closed when an integrity-bound helper is changed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-native-host-'));
    try {
      const helper = path.join(root, 'host');
      await writeFile(helper, 'trusted');
      const trusted = createHash('sha256').update('different').digest('hex');
      const size = (await stat(helper)).size;
      const bridge = new NativeHostProcessBridge({
        platform: 'linux', executablePath: helper, expectedSha256: trusted, expectedSizeBytes: size, requireIntegrity: true, terminator,
        spawnProcess: (): never => { throw new Error('must not spawn'); },
      });
      await expect(bridge.execute('health', {})).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
