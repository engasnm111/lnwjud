import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellCapabilityBackend } from './shell-backend.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ShellCapabilityBackend', () => {
  it('runs an executable with separate arguments and returns bounded output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('hello')"],
      cwd: root,
      execution: 'foreground',
      timeout_seconds: 10,
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'hello' } });
  });

  it('rejects a working directory outside configured local roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-outside-'));
    temporaryRoots.push(root, outside);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'process.exit(0)'],
      cwd: outside,
      execution: 'foreground',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('supports a background task handle followed by wait and result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root] });

    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('done'), 20)"],
      cwd: root,
      execution: 'background',
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), state: 'running' } });

    if (!started.ok) return;
    const waited = await backend.execute({ operation: 'wait', task_id: started.value.task_id, timeout_seconds: 10 });
    expect(waited).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'done' } });
    const result = await backend.execute({ operation: 'result', task_id: started.value.task_id });
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'done' } });
  });
});
