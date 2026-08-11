import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathExecutableResolver, ProcessManager } from './index.js';

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
});
