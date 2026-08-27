import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { PathExecutableResolver, ProcessManager, type ExecutableResolver, type ProcessTreeTerminator } from './index.js';

async function waitForState(manager: ProcessManager, processId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = manager.status(processId);
    if (result.ok && result.value.state === state) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process did not reach state ${state}`);
}

describe('ProcessManager', () => {
  it('captures stdout/stderr and retains a managed process handle', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('stdout-marker\\n'); process.stderr.write('stderr-marker\\n');"],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    const logs = manager.logs(started.value.processId, {});

    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.entries.map((entry) => `${entry.stream}:${entry.text}`)).toEqual(expect.arrayContaining([
      expect.stringContaining('stdout:stdout-marker'),
      expect.stringContaining('stderr:stderr-marker'),
    ]));
  });

  it('times out a running child and stops only an owned process handle', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'timed_out');
    await expect(manager.stop('not-owned')).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('returns EXECUTABLE_NOT_FOUND without accepting an arbitrary shell command', async () => {
    const result = await new ProcessManager().start({
      executable: 'lnwjud-executable-that-does-not-exist',
      args: ['&&', 'whoami'],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTABLE_NOT_FOUND' } });
  });

  it('runs a Windows command shim without shell true', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(process.cwd(), 'lnwjud process shim-'));
    try {
      await writeFile(path.join(root, 'lnwjud-shim.cmd'), '@echo off\r\necho process-shim-marker\r\n', 'utf8');
      const resolver = new PathExecutableResolver({ Path: root, PATHEXT: '.CMD' });
      await expect(resolver.resolve('lnwjud-shim')).resolves.toMatchObject({ ok: true, value: expect.stringMatching(/\.cmd$/i) });
      const manager = new ProcessManager(undefined, resolver);
      const started = await manager.start({ executable: 'lnwjud-shim', args: [], cwd: root });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitForState(manager, started.value.processId, 'exited');
      const logs = manager.logs(started.value.processId, {});
      expect(logs).toMatchObject({ ok: true, value: { entries: [expect.objectContaining({ text: expect.stringContaining('process-shim-marker') })] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects shell metacharacters in Windows command shim arguments', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(process.cwd(), 'lnwjud-process-shim-'));
    try {
      await writeFile(path.join(root, 'lnwjud-shim.cmd'), '@echo off\r\necho process-shim-marker\r\n', 'utf8');
      const resolver = new PathExecutableResolver({ Path: root, PATHEXT: '.CMD' });
      const result = await new ProcessManager(undefined, resolver).start({ executable: 'lnwjud-shim', args: ['&', 'whoami'], cwd: root });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps stop pending and nonterminal until process-tree termination is verified', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(child): Promise<void> {
        if (!terminationAllowed) throw new Error('verification unavailable');
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopping = manager.stop(started.value.processId);
    await waitForState(manager, started.value.processId, 'termination_unverified');
    expect(manager.status(started.value.processId)).toMatchObject({
      ok: true,
      value: { state: 'termination_unverified', error: expect.stringContaining('could not be verified') },
    });
    expect((manager.status(started.value.processId) as { ok: true; value: { finishedAt?: string } }).value.finishedAt).toBeUndefined();
    await expect(Promise.race([stopping.then(() => 'settled'), delay(50).then(() => 'pending')])).resolves.toBe('pending');

    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });

  it('does not infer verified termination when the root closes before a failed tree stop', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(): Promise<void> {
        await delay(50);
        if (!terminationAllowed) throw new Error('tree verification failed after root close');
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopping = manager.stop(started.value.processId);
    await waitForState(manager, started.value.processId, 'termination_unverified');
    await delay(25);
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });

    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });

  it('keeps timeout termination failures contained and retries until verified', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(child): Promise<void> {
        if (!terminationAllowed) throw new Error('verification unavailable');
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 25,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'termination_unverified');
    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await waitForState(manager, started.value.processId, 'timed_out');
  });

  it('does not spawn after cancellation wins during executable resolution', async () => {
    const root = await mkdtemp(path.join(process.cwd(), 'lnwjud-cancelled-process-'));
    const marker = path.join(root, 'late-spawn-marker.txt');
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const resolver: ExecutableResolver = {
      async resolve() {
        await resolverGate;
        return ok(process.execPath);
      },
    };
    const controller = new AbortController();
    try {
      const starting = new ProcessManager(undefined, resolver).start({
        executable: 'delayed-node',
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: root,
      }, controller.signal);
      controller.abort();
      releaseResolver();

      await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      await delay(100);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caps simultaneous managed processes to prevent runaway child-process growth', async () => {
    const manager = new ProcessManager(undefined, undefined, 1);
    const first = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(second).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });

    await expect(manager.stop(first.value.processId)).resolves.toMatchObject({ ok: true });
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
