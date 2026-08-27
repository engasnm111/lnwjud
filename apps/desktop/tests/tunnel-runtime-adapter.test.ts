import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  TunnelRuntimeAdapter,
  parseNativeRuntimeStatus,
  type TunnelRuntimeExecutor,
} from '../src/main/tunnel-runtime-adapter.js';

function executor(responses: Readonly<Record<string, { stdout?: string; stderr?: string; error?: string }>>): TunnelRuntimeExecutor {
  return vi.fn(async (_executable: string, args: readonly string[], _options: ExecFileOptionsWithStringEncoding) => {
    void _options;
    const key = args.join(' ');
    const response = responses[key];
    if (response === undefined) throw Object.assign(new Error(`unexpected command: ${key}`), { stdout: '', stderr: '' });
    if (response.error !== undefined) throw Object.assign(new Error(response.error), { stdout: response.stdout ?? '', stderr: response.stderr ?? response.error });
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  });
}

describe('TunnelRuntimeAdapter', () => {
  it('detects official managed runtimes and refuses to infer strict A/B zero downtime', async () => {
    const execute = executor({
      '--version': { stdout: '0.0.11+fixture\n' },
      'runtimes --help': { stdout: 'Available Commands:\n  connect\n  status\n  stop\n' },
      'runtimes connect --help': { stdout: '--alias --tunnel-id --runtime-api-key --mcp-server-url' },
      'health --help': { stdout: '/healthz /readyz --require-control-plane-poll' },
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'C:\\tools\\tunnel-client.exe',
      profileDirectory: 'C:\\profile',
      environment: {},
      execute,
    });

    await expect(adapter.capabilities()).resolves.toEqual(expect.objectContaining({
      clientVersion: '0.0.11+fixture',
      nativeRuntimes: true,
      managedConnect: true,
      healthProbe: true,
      pollHealthGate: true,
      readyBeforeRetire: false,
      strictZeroDowntime: false,
    }));
  });

  it('maps unknown alias status to a missing runtime instead of throwing', async () => {
    const execute = executor({
      'runtimes status lnwjud --json': { error: 'alias lnwjud is not known; run create or connect first' },
    });
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });
    await expect(adapter.status()).resolves.toMatchObject({ exists: false, running: false });
  });

  it('verifies the managed runtime is actually stopped instead of trusting the stop command exit code', async () => {
    let statusCalls = 0;
    const execute: TunnelRuntimeExecutor = vi.fn(async (_executable, args) => {
      const key = args.join(' ');
      if (key === 'runtimes stop lnwjud --json') return { stdout: JSON.stringify({ alias: 'lnwjud' }), stderr: '' };
      if (key === 'runtimes status lnwjud --json') {
        statusCalls += 1;
        return {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process: { running: statusCalls < 2, pid: statusCalls < 2 ? 1234 : null },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${key}`);
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute,
      stopVerifyAttempts: 3, stopVerifyIntervalMs: 0,
    });

    await expect(adapter.stop()).resolves.toMatchObject({ running: false });
    expect(statusCalls).toBe(2);
  });

  it('fails loudly when the managed runtime remains live after an explicit stop', async () => {
    const execute: TunnelRuntimeExecutor = vi.fn(async (_executable, args) => {
      const key = args.join(' ');
      if (key === 'runtimes stop lnwjud --json') return { stdout: JSON.stringify({ alias: 'lnwjud' }), stderr: '' };
      if (key === 'runtimes status lnwjud --json') return { stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process: { running: true, pid: 1234 } }), stderr: '' };
      throw new Error(`unexpected command: ${key}`);
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute,
      stopVerifyAttempts: 2, stopVerifyIntervalMs: 0,
    });

    await expect(adapter.stop()).rejects.toThrow('still running after stop');
  });

  it('connects the same tunnel with an environment key reference and no literal secret in argv', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const mcpServerUrl = 'http://127.0.0.1:18765/mcp';
    const execute = executor({
      [`runtimes connect --alias lnwjud --tunnel-id ${tunnelId} --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url ${mcpServerUrl} --profile lnwjud --profile-dir C:\\profile --json`]: {
        stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: true, pid: 1234 }, health: { healthy: true, ready: true }, control_plane: { poll_healthy: true }, mcp_server_url: mcpServerUrl }),
      },
    });
    const environment = { CONTROL_PLANE_API_KEY: 'secret-must-stay-in-env' };
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment, execute });

    await expect(adapter.connect({ tunnelId, mcpServerUrl })).resolves.toMatchObject({
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: true,
      tunnelId,
      mcpServerUrl,
    });
    const call = vi.mocked(execute).mock.calls[0];
    expect(call?.[1]).not.toContain(environment.CONTROL_PLANE_API_KEY);
    expect(call?.[1]).toContain('env:CONTROL_PLANE_API_KEY');
  });
});

describe('parseNativeRuntimeStatus', () => {
  it('normalizes nested JSON fields from runtime status output', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      alias: 'lnwjud',
      tunnel: { id: 'tunnel_fixture012345' },
      process: { running: true, pid: 7654 },
      health: { healthy: true, ready: true, ui_url: 'http://127.0.0.1:9123/ui' },
      control_plane: { poll_healthy: true },
      mcp: { server_url: 'http://127.0.0.1:18765/mcp' },
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: true,
      tunnelId: 'tunnel_fixture012345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: 7654,
      uiUrl: 'http://127.0.0.1:9123/ui',
    }));
  });

  it('understands tunnel-client 0.0.12 target_value and explicit unknown poll-health state', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      alias: 'lnwjud',
      tunnel_id: 'tunnel_fixture012345',
      healthy: true,
      ready: true,
      runtime_state: 'ready',
      process_running: true,
      target_kind: 'server_url',
      target_value: 'http://127.0.0.1:18765/mcp',
      process: {
        pid: 21980,
        running: true,
        target_kind: 'server_url',
        target_value: 'http://127.0.0.1:18765/mcp',
      },
      control_plane_poll_health: {
        state: 'unknown',
        reason: 'no live admin UI system snapshot',
      },
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: null,
      tunnelId: 'tunnel_fixture012345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: 21980,
    }));
  });
});
