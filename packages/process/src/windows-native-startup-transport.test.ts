import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsNativeAuthority } from './windows-native-authority.js';

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: transport.spawn,
}));

const roots: string[] = [];
afterEach(async () => {
  transport.spawn.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function child(stdin = new PassThrough()): ChildProcess {
  const process = new ChildProcess();
  process.stdin = stdin;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  vi.spyOn(process, 'kill').mockReturnValue(true);
  return process;
}

function reply(process: ChildProcess, value: unknown): void {
  queueMicrotask(() => {
    if (process.stdout instanceof PassThrough) process.stdout.end(JSON.stringify(value));
    process.stderr?.destroy();
    process.emit('close', 0, null);
  });
}

async function fixture(): Promise<{ authority: WindowsNativeAuthority; closes: () => Promise<number> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-startup-transport-'));
  roots.push(root);
  const executable = path.join(root, 'helper.exe');
  const pinModule = path.join(root, 'pin.cjs');
  const closeFile = path.join(root, 'closed');
  const helperBytes = Buffer.from('test-only helper, never executed');
  const pinBytes = Buffer.from(`module.exports={pinExecutable(){return{close(){require('node:fs').appendFileSync(${JSON.stringify(closeFile)},'x')}}}}`);
  await writeFile(executable, helperBytes);
  await writeFile(pinModule, pinBytes);
  await writeFile(closeFile, '');
  return {
    authority: new WindowsNativeAuthority({
      helper: { executable, sha256: createHash('sha256').update(helperBytes).digest('hex'), buildId: 'lnwjud-containment-v2' },
      pin: { modulePath: pinModule, sha256: createHash('sha256').update(pinBytes).digest('hex') },
    }),
    closes: async () => (await readFile(closeFile)).length,
  };
}

describe.skipIf(process.platform !== 'win32')('pinned native startup transport', () => {
  it.each([
    { kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' },
    { protocol: 2, kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' },
    { protocol: 3, kind: 'unmanaged', reason: 'MANUAL_INSTALLATION', extra: true },
  ])('does not accept an unversioned or malformed local footprint: %j', async (value) => {
    const { authority } = await fixture();
    transport.spawn.mockImplementationOnce(() => {
      const process = child();
      reply(process, { protocol: 3, ok: true, result: { kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' } });
      return process;
    }).mockImplementationOnce(() => { const process = child(); reply(process, value); return process; });
    expect((await authority.inspectUpdateStartup()).kind).toBe('held');
    expect(transport.spawn).toHaveBeenCalledTimes(2);
  });

  it('never lets a remote manual result override a local managed-slot hold', async () => {
    const { authority } = await fixture();
    transport.spawn.mockImplementationOnce(() => {
      const process = child();
      reply(process, { protocol: 3, ok: true, result: { kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' } });
      return process;
    }).mockImplementationOnce(() => {
      const process = child();
      reply(process, { protocol: 3, kind: 'held', reason: 'UPDATE_ENROLLMENT_UNVERIFIED' });
      return process;
    });
    expect(await authority.inspectUpdateStartup()).toEqual({ kind: 'held', reason: 'UPDATE_ENROLLMENT_UNVERIFIED' });
    expect(transport.spawn).toHaveBeenCalledTimes(2);
  });

  it('sends the fixed framed request and honors the authenticated service hold', async () => {
    const { authority } = await fixture();
    const frames: Buffer[] = [];
    transport.spawn.mockImplementationOnce(() => {
      const process = child();
      process.stdin?.on('data', (chunk: Buffer) => frames.push(Buffer.from(chunk)));
      process.stdin?.once('finish', () => reply(process, {
        protocol: 3, ok: true, result: { kind: 'held', reason: 'UPDATE_ENROLLMENT_UNVERIFIED' },
      }));
      return process;
    });
    expect(await authority.inspectUpdateStartup()).toEqual({ kind: 'held', reason: 'UPDATE_ENROLLMENT_UNVERIFIED' });
    const frame = Buffer.concat(frames);
    expect(frame.readInt32LE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual({ protocol: 3, command: 'update_startup' });
  });

  it.each(['spawn-error', 'closed-stdin'] as const)('keeps the manual footprint after RPC %s without unhandled stream errors', async (failure) => {
    const { authority, closes } = await fixture();
    transport.spawn.mockImplementationOnce(() => {
      const process = child();
      if (failure === 'closed-stdin') process.stdin?.destroy();
      queueMicrotask(() => {
        if (failure === 'spawn-error') process.emit('error', new Error('spawn EACCES'));
        process.emit('close', 125, null);
      });
      return process;
    }).mockImplementationOnce(() => {
      const process = child();
      reply(process, { protocol: 3, kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' });
      return process;
    });
    expect(await authority.inspectUpdateStartup()).toEqual({ kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await closes()).toBe(2);
  });

  it('retains the helper pin after a failed write until the child actually closes', async () => {
    const { authority, closes } = await fixture();
    let failedChild: ChildProcess | undefined;
    transport.spawn.mockImplementationOnce(() => {
      const input = new Writable({ write(_chunk, _encoding, complete): void { complete(new Error('EPIPE')); } });
      failedChild = child();
      failedChild.stdin = input;
      return failedChild;
    }).mockImplementationOnce(() => {
      const process = child();
      reply(process, { protocol: 3, kind: 'unmanaged', reason: 'MANUAL_INSTALLATION' });
      return process;
    });
    expect((await authority.inspectUpdateStartup()).kind).toBe('unmanaged');
    expect(await closes()).toBe(1);
    expect(failedChild?.kill).toHaveBeenCalledOnce();
    failedChild?.emit('close', 125, null);
    expect(await closes()).toBe(2);
  });

  it('rechecks the local footprint after a delayed failing RPC observes enrollment', async () => {
    const { authority } = await fixture();
    let enrolled = false;
    transport.spawn.mockImplementation((_executable: string, args: string[]) => {
      const process = child();
      if (args[0] === 'service-rpc') {
        process.stdin?.once('finish', () => setImmediate(() => {
          enrolled = true;
          process.emit('error', new Error('service disconnected'));
          process.emit('close', 125, null);
        }));
      } else {
        reply(process, { protocol: 3, kind: enrolled ? 'held' : 'unmanaged',
          reason: enrolled ? 'UPDATE_ENROLLMENT_UNVERIFIED' : 'MANUAL_INSTALLATION' });
      }
      return process;
    });
    expect(await authority.inspectUpdateStartup()).toEqual({ kind: 'held', reason: 'UPDATE_ENROLLMENT_UNVERIFIED' });
    expect(transport.spawn).toHaveBeenCalledTimes(2);
  });
});
