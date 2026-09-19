import { describe, expect, it, vi } from 'vitest';
import type { GoalLeaseProof } from '@lnwjud/domain';
import {
  ToolRegistryAutomationRuntimeAdapter,
  type AutomationChildInvoker,
} from './automation-runtime-adapter.js';
import type { McpToolResponse } from './result-mapper.js';

const LEASE: GoalLeaseProof = {
  goalId: 'goal-1',
  leaseToken: 'lease-secret',
  leaseGeneration: 3,
};

function response(structuredContent: Record<string, unknown>): McpToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function adapter(
  invoke: AutomationChildInvoker['invoke'],
  userConfirmed = false,
): ToolRegistryAutomationRuntimeAdapter {
  return new ToolRegistryAutomationRuntimeAdapter({ invoke }, {
    goalLease: LEASE,
    userConfirmed,
  });
}

describe('ToolRegistryAutomationRuntimeAdapter', () => {
  it('launches shell work through the guarded shell tool and forwards the same goal lease', async () => {
    const invoke = vi.fn<AutomationChildInvoker['invoke']>(async () => response({
      task_id: 'shell-task-1',
      state: 'running',
    }));
    const runtime = adapter(invoke);

    await expect(runtime.launch({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      milestoneId: 'm1',
      attemptId: 'attempt-1',
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'idempotency-1',
      executionIntent: 'Build project',
      execution: {
        provider: 'shell',
        executable: 'pnpm.cmd',
        arguments: ['build'],
        cwd: '.',
        timeoutMs: 90_000,
      },
    })).resolves.toEqual({
      kind: 'started',
      taskId: 'shell-task-1',
      detail: 'launched via shell',
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'shell',
      expect.objectContaining({
        operation: 'run',
        workspaceId: 'workspace-1',
        executable: 'pnpm.cmd',
        arguments: ['build'],
        execution: 'background',
        cwd: '.',
        timeout_seconds: 90,
        userConfirmed: false,
        goalLease: LEASE,
      }),
      undefined,
    );
  });

  it('maps process and Codex launches to native guarded child tools', async () => {
    const invoke = vi.fn<AutomationChildInvoker['invoke']>(async (name) => (
      name === 'process_start'
        ? response({ processId: 'process-1', state: 'running' })
        : response({ codexTaskId: 'codex-1', state: 'running' })
    ));
    const runtime = adapter(invoke, true);

    const processLaunch = await runtime.launch({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      milestoneId: 'm1',
      attemptId: 'attempt-1',
      provider: 'process',
      operationKey: 'server',
      idempotencyKey: 'idempotency-process',
      executionIntent: 'Start server',
      execution: {
        provider: 'process',
        executable: 'node.exe',
        args: ['server.mjs'],
      },
    });
    const codexLaunch = await runtime.launch({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      milestoneId: 'm1',
      attemptId: 'attempt-1',
      provider: 'codex',
      operationKey: 'codex',
      idempotencyKey: 'idempotency-codex',
      executionIntent: 'Delegate coding',
      execution: {
        provider: 'codex',
        instruction: 'Inspect and implement the requested change.',
      },
    });

    expect(processLaunch).toMatchObject({ kind: 'started', taskId: 'process-1' });
    expect(codexLaunch).toMatchObject({ kind: 'started', taskId: 'codex-1' });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'process_start',
      expect.objectContaining({ userConfirmed: true, goalLease: LEASE }),
      undefined,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'codex_run',
      expect.objectContaining({ userConfirmed: true, goalLease: LEASE }),
      undefined,
    );
  });

  it('classifies a thrown dispatch as uncertain instead of retrying it', async () => {
    const runtime = adapter(async () => {
      throw new Error('transport disconnected after send');
    });

    await expect(runtime.launch({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      milestoneId: 'm1',
      attemptId: 'attempt-1',
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'idempotency-1',
      executionIntent: 'Build',
      execution: { provider: 'shell', executable: 'pnpm', arguments: ['build'] },
    })).resolves.toMatchObject({
      kind: 'uncertain',
      detail: 'transport disconnected after send',
    });
  });

  it('classifies policy rejection as a rejected launch, not an ambiguous dispatch', async () => {
    const runtime = adapter(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'PERMISSION_DENIED: blocked' }],
      structuredContent: {
        error: {
          code: 'PERMISSION_DENIED',
          message: 'blocked by policy',
          recoverable: false,
        },
      },
    }));

    await expect(runtime.launch({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      milestoneId: 'm1',
      attemptId: 'attempt-1',
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'idempotency-1',
      executionIntent: 'Build',
      execution: { provider: 'shell', executable: 'pnpm', arguments: ['build'] },
    })).resolves.toMatchObject({
      kind: 'rejected',
      code: 'PERMISSION_DENIED',
      retryable: false,
    });
  });

  it('observes normalized durable states without launching a replacement task', async () => {
    const invoke = vi.fn<AutomationChildInvoker['invoke']>(async () => response({
      task: {
        state: 'completed',
        finished_at: '2026-09-19T01:00:00.000Z',
        exit_code: 0,
      },
    }));
    const runtime = adapter(invoke);

    await expect(runtime.observe({
      workspaceId: 'workspace-1',
      provider: 'shell',
      taskId: 'shell-task-1',
    })).resolves.toMatchObject({
      kind: 'observed',
      state: 'completed',
      terminalAt: '2026-09-19T01:00:00.000Z',
    });
    expect(invoke).toHaveBeenCalledWith(
      'task_status',
      { workspaceId: 'workspace-1', taskId: 'shell-task-1' },
      undefined,
    );
  });

  it('reports unresolved dispatch lookup truthfully when the child provider lacks idempotency lookup', async () => {
    const runtime = adapter(async () => response({}));
    await expect(runtime.resolveDispatch({
      workspaceId: 'workspace-1',
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'idempotency-1',
    })).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('routes cancellation through the owned provider handle with the goal lease', async () => {
    const invoke = vi.fn<AutomationChildInvoker['invoke']>(async () => response({
      state: 'running',
    }));
    const runtime = adapter(invoke, true);

    await expect(runtime.cancel({
      workspaceId: 'workspace-1',
      provider: 'process',
      taskId: 'process-1',
    })).resolves.toMatchObject({
      kind: 'requested',
    });
    expect(invoke).toHaveBeenCalledWith(
      'process_stop',
      {
        workspaceId: 'workspace-1',
        processId: 'process-1',
        userConfirmed: true,
        goalLease: LEASE,
      },
      undefined,
    );
  });
});
