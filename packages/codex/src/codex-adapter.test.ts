import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ManagedProcessStart, ProcessLogResult } from '@lnwjud/process';
import { CodexAdapter, type CodexDiscoveryPort, type CodexProcessManagerPort } from './codex-adapter.js';
import type { CodexDiscoveryResult } from './codex-capabilities.js';

describe('CodexAdapter', () => {
  it('builds direct sandboxed executable arguments and delegates the task to ProcessManager', async () => {
    const calls: ManagedProcessStart[] = [];
    const manager: CodexProcessManagerPort = {
      async start(spec): Promise<Result<ManagedProcess>> { calls.push(spec); return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = { async discover(): Promise<Result<CodexDiscoveryResult>> { return ok(discovered()); } };

    const result = await new CodexAdapter(discovery, manager).start('C:\\workspace', 'review "quoted" input');

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{
      executable: 'C:\\tools\\codex.exe',
      args: ['exec', '--sandbox', 'workspace-write', 'review "quoted" input'],
      cwd: 'C:\\workspace',
    }]);
  });

  it('does not start a process after cancellation wins during Codex discovery', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      async start(): Promise<Result<ManagedProcess>> { starts += 1; return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = {
      async discover(): Promise<Result<CodexDiscoveryResult>> {
        await discoveryGate;
        return ok(discovered());
      },
    };
    const controller = new AbortController();

    const starting = new CodexAdapter(discovery, manager).start('C:\\workspace', 'review', controller.signal);
    controller.abort();
    releaseDiscovery();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });

  it('does not start a process after cancellation wins during Codex discovery', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      async start(): Promise<Result<ManagedProcess>> { starts += 1; return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = {
      async discover(): Promise<Result<CodexDiscoveryResult>> {
        await discoveryGate;
        return ok(discovered());
      },
    };
    const controller = new AbortController();

    const starting = new CodexAdapter(discovery, manager).start('C:\\workspace', 'review', controller.signal);
    controller.abort();
    releaseDiscovery();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });
});

function discovered(): CodexDiscoveryResult {
  return {
    status: {
      installed: true,
      executablePath: 'C:\\tools\\codex.exe',
      version: '0.42.1',
      capabilities: ['exec', 'sandbox', 'workspace-write'],
    },
    capabilities: { instructionMode: 'exec-argument', names: ['exec', 'sandbox', 'workspace-write'] },
  };
}

function processHandle(): ManagedProcess {
  return {
    processId: 'process-1',
    executable: 'C:\\tools\\codex.exe',
    args: ['exec', '--sandbox', 'workspace-write', 'review'],
    cwd: 'C:\\workspace',
    state: 'running',
    startedAt: new Date(0).toISOString(),
  };
}
