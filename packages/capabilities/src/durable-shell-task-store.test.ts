import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

describe.skipIf(process.platform === 'win32')('durable shell termination escalation on posix', () => {
  // The child installs a real SIGTERM handler (so it survives SIGTERM
  // deterministically) and spawns a descendant, giving the killed tree real
  // depth. It writes a readiness file only after the handler is installed, so
  // the assertions never race the child's own startup; the 15s self-exit
  // bounds any pre-fix (leaky) run.
  function ignoringChild(readyPath: string): { readonly executable: string; readonly arguments: readonly string[] } {
    const source = [
      "const fs = require('node:fs');",
      `const ready = ${JSON.stringify(readyPath)};`,
      "process.on('SIGTERM', function () {});",
      "require('node:child_process').spawn('/bin/sleep', ['15']);",
      "fs.writeFileSync(ready, String(process.pid));",
      'setTimeout(function () { process.exit(0); }, 15000);',
      'setInterval(function () {}, 250);',
    ].join('');
    return { executable: process.execPath, arguments: ['-e', source] };
  }

  async function waitForChildReady(readyPath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await readFile(readyPath, 'utf8');
        return;
      } catch {
        await delayForTest(25);
      }
    }
    throw new Error('durable child never became ready');
  }

  it('escalates to SIGKILL for a SIGTERM-ignoring task on timeout and converges the state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-term-'));
    temporaryRoots.push(root);
    const readyPath = path.join(root, 'child-ready');
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'chatgpt', sessionId: 'session-term', workspaceId: 'workspace-term' };

    const started = await store.launch({
      taskId: 'term-ignore-timeout',
      ...ignoringChild(readyPath),
      cwd: root,
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: 'term-ignore-timeout', state: 'running' } });
    await waitForChildReady(readyPath);

    const finished = await store.wait('term-ignore-timeout', 12, undefined, owner);
    expect(finished).toMatchObject({ ok: true, value: { state: 'timed_out' } });
    if (!finished.ok) return;

    const childPid = (finished.value as Record<string, unknown>).child_pid;
    expect(typeof childPid).toBe('number');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(processAlive(childPid as number), 'the task child must actually be dead').toBe(false);
  }, 15_000);

  it('escalates to SIGKILL for a SIGTERM-ignoring task when cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-durable-shell-cancel-'));
    temporaryRoots.push(root);
    const readyPath = path.join(root, 'child-ready');
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'chatgpt', sessionId: 'session-cancel', workspaceId: 'workspace-cancel' };

    const started = await store.launch({
      taskId: 'term-ignore-cancel',
      ...ignoringChild(readyPath),
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: 'term-ignore-cancel', state: 'running' } });
    await waitForChildReady(readyPath);

    const cancelled = await store.cancel('term-ignore-cancel', owner);

    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    const childPid = ((cancelled.value as Record<string, unknown>).child_pid);
    expect(typeof childPid).toBe('number');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(processAlive(childPid as number), 'the task child must actually be dead').toBe(false);
  }, 15_000);
});

function delayForTest(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}
