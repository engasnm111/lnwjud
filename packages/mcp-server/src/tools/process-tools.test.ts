import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { processTools } from './process-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('processTools', () => {
  it('forwards the invocation cancellation signal to direct and project process starts', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const observedAuthorizations: unknown[] = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        process: {
          async start(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal, authorization?: unknown) {
            observedSignals.push(signal);
            observedAuthorizations.push(authorization);
            return ok({ processId: 'process-1' });
          },
          async startProjectCommand(_actor: unknown, _workspaceId: string, _kind: unknown, signal?: AbortSignal, _userConfirmed?: boolean, _approvedCommand?: unknown, authorization?: unknown) {
            observedSignals.push(signal);
            observedAuthorizations.push(authorization);
            return ok({ processId: 'process-2' });
          },
        },
      },
    } as unknown as McpToolContext;
    const tools = processTools(context);
    const signal = new AbortController().signal;
    const authorization = {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    } as const;

    for (const [name, input] of [
      ['process_start', { workspaceId: 'workspace-1', executable: 'node', args: [] }],
      ['project_test', { workspaceId: 'workspace-1' }],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing process tool: ${name}`);
      await tool.execute(input, signal, authorization);
    }

    expect(observedSignals).toEqual([signal, signal]);
    expect(observedAuthorizations).toEqual([authorization, authorization]);
  });
});
