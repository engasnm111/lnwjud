import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellCapabilityBackend } from './shell-backend.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('durable shell background tasks', () => {
  it('survives a backend/runtime replacement and returns logs and result by task id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });

    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('durable-done'), 300)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const waited = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(waited).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'durable-done', durable: true },
    });
    await expect(replacementRuntime.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]) },
    });
  });

  it('does not overwrite a very fast durable completion back to running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      autoWaitSeconds: 1,
    });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('fast')"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!result.ok) return;
    const taskId = String((result.value as Record<string, unknown>).task_id);
    const terminal = (result.value as Record<string, unknown>).state === 'running'
      ? await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 })
      : result;
    expect(terminal).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(backend.execute({ operation: 'status', task_id: taskId })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true },
    });
  });

  it('cancels a durable task from a replacement backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await waitUntil(async () => {
      const status = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
      return status.ok && typeof (status.value as Record<string, unknown>).worker_pid === 'number';
    }, 1500);
    const cancelled = await replacementRuntime.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });

    expect(cancelled).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
  });

  it('keeps a durable auto task running when the original MCP caller aborts after submission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory,
      autoWaitSeconds: 0.3,
      maxSynchronousWaitSeconds: 0.3,
    });
    const controller = new AbortController();
    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-abort'), 600)"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const submitted = await running;
    expect(submitted).toMatchObject({ ok: true, value: { state: 'running', task_id: expect.any(String), durable: true } });
    if (!submitted.ok) return;
    const taskId = String((submitted.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const finished = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-abort', durable: true } });
  });

  it('caps concurrent durable workers so many chats cannot exhaust a Windows 10/11 machine with child consoles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-cap-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(taskStateDirectory, { maxConcurrentTasks: 1 });
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const common = {
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;

    const first = await store.launch({ taskId: 'task-one', ...common });
    expect(first).toMatchObject({ ok: true, value: { task_id: 'task-one', state: 'running' } });

    const second = await store.launch({ taskId: 'task-two', ...common });
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        recoverable: true,
      },
    });

    const cancelled = await store.cancel('task-one', owner);
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}
