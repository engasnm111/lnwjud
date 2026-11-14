import { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createProcessTreeTerminator, createWindowsMcpStdioOwner, WindowsProcessTree, type ProcessTreeTerminator, type WindowsMcpStdioOwner, type WindowsMcpStdioChildLaunch, type WindowsMcpCleanupResult } from '@lnwjud/process';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultMcpClientFactory, McpSessionManager, type McpClientFactory, type McpClientSession } from './mcp-session-manager.js';
import { CONTAINMENT_HELPER_SHA256, CONTAINMENT_PIN_SHA256 } from '../../capabilities/src/containment-integrity.generated.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/external-mcp-server.mjs', import.meta.url));

function createNativeWindowsMcpStdioOwner(): WindowsMcpStdioOwner {
  const helper = fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment.exe', import.meta.url));
  const pin = fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment-pin.node', import.meta.url));
  return createWindowsMcpStdioOwner({
    helper: { executable: helper, sha256: CONTAINMENT_HELPER_SHA256, buildId: 'lnwjud-containment-v2' },
    pin: { modulePath: pin, sha256: CONTAINMENT_PIN_SHA256 },
  });
}

async function connectFixture(
  era: 'legacy' | 'legacy-exit-on-discover' | 'initialize-error' | 'exit-on-call' | 'modern' | 'schema-error',
  factory: McpClientFactory = createTestMcpClientFactory(),
  signal?: AbortSignal,
): Promise<McpClientSession> {
  return factory.connect({ command: process.execPath, args: [fixturePath], env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: era } }, signal);
}

function createTestMcpClientFactory(
  terminator: ProcessTreeTerminator = createProcessTreeTerminator(),
  hooks?: {
    readonly closeAndVerify?: (child: ChildProcess, verify: () => Promise<void>) => Promise<void>;
    readonly release?: () => void;
    readonly prepareChild?: () => void | Promise<void>;
    readonly connectionProof?: () => WindowsMcpCleanupResult;
  },
): McpClientFactory {
  const windowsMcpStdioOwner: WindowsMcpStdioOwner = {
    async prepare(target) {
      return {
        containment: 'unisolated_same_user', cleanupScope: 'owned_job',
        async prepareChild(): Promise<WindowsMcpStdioChildLaunch> {
          await hooks?.prepareChild?.();
          return {
        command: target.command, args: [...(target.args ?? [])], env: target.env ?? {},
        async closeResource(child): Promise<WindowsMcpCleanupResult> {
          const verify = async (): Promise<void> => {
            if (child === undefined) return;
            if (child.exitCode === 0 && child.signalCode === null) return;
            if (child.pid === undefined) throw new Error('Fixture process identity unavailable');
            await terminator.stop(child, child.pid);
          };
          if (hooks?.closeAndVerify === undefined || child === undefined) await verify();
          else await hooks.closeAndVerify(child, verify);
          return { scope: 'owned_job', containment: 'unisolated_same_user', writerDrainVerified: false } as const;
        },
        }; },
        async closeOwnedConnection(): Promise<WindowsMcpCleanupResult> { return hooks?.connectionProof?.()
          ?? { scope: 'owned_job', containment: 'unisolated_same_user', writerDrainVerified: false }; },
        release(): void { hooks?.release?.(); },
      };
    },
  };
  return createDefaultMcpClientFactory(terminator, process.platform === 'win32' ? windowsMcpStdioOwner : undefined);
}

describe('default External MCP client protocol negotiation', () => {
  it.skipIf(process.platform !== 'win32')('obtains a separate native ticket before spawning each SDK sibling', async () => {
    let issued = 0;
    let spawned = 0;
    const start = StdioClientTransport.prototype.start;
    const spy = vi.spyOn(StdioClientTransport.prototype, 'start').mockImplementation(function (this: StdioClientTransport): Promise<void> {
      expect(issued).toBe(spawned + 1);
      spawned++;
      return start.call(this);
    });
    try {
      const session = await connectFixture('modern', createTestMcpClientFactory(undefined, { prepareChild: () => { issued++; } }));
      await session.close();
      expect(issued).toBe(2);
      expect(spawned).toBe(2);
    } finally { spy.mockRestore(); }
  });

  it.skipIf(process.platform !== 'win32')('rejects promotion of an owned-Job receipt to global writer-drain proof', async () => {
    let promoted = true;
    const factory = createTestMcpClientFactory(undefined, { connectionProof: () => {
      const proof: WindowsMcpCleanupResult = { scope: 'owned_job', containment: 'unisolated_same_user', writerDrainVerified: false };
      if (promoted) Object.defineProperty(proof, 'writerDrainVerified', { value: true });
      return proof;
    } });
    const session = await connectFixture('modern', factory);
    try { await expect(session.close()).rejects.toThrow('MCP_NATIVE_JOB_SCOPE_INVALID'); }
    finally { promoted = false; await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('fences a late SDK sibling when its native ticket resolves after close', async () => {
    let allowTicket: () => void = () => undefined;
    let ticketStarted: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { ticketStarted = resolve; });
    const ticket = new Promise<void>(resolve => { allowTicket = resolve; });
    let transport: Parameters<Client['connect']>[0] | undefined;
    const connect = Client.prototype.connect;
    const observed = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, ...args: Parameters<Client['connect']>): ReturnType<Client['connect']> {
      transport = args[0];
      return connect.apply(this, args);
    });
    const spawned = vi.spyOn(StdioClientTransport.prototype, 'start');
    const connection = connectFixture('modern', createTestMcpClientFactory(undefined, { prepareChild: () => { ticketStarted(); return ticket; } }));
    connection.catch(() => undefined);
    try {
      await waiting;
      await transport!.close();
      allowTicket();
      await expect(connection).rejects.toThrow();
      expect(spawned).not.toHaveBeenCalled();
    } finally { allowTicket(); observed.mockRestore(); spawned.mockRestore(); }
  });
  it.skipIf(process.platform !== 'win32')('refuses Windows MCP launch without the pinned Job proxy owner', async () => {
    const taskkill = vi.fn(async (): Promise<number> => 0);
    const factory = createDefaultMcpClientFactory(new WindowsProcessTree({ platform: 'win32', taskkill }));
    await expect(factory.connect({ command: 'must-not-be-launched.exe' })).rejects.toThrow('MCP_WINDOWS_JOB_PROXY_REQUIRED');
    expect(taskkill).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('runs and verifies MCP through the pinned native Job proxy', async () => {
    const session = await connectFixture('modern', createDefaultMcpClientFactory(undefined, createNativeWindowsMcpStdioOwner()));
    try {
      await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: 'modern_ping' })]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('resolves Windows command shims before starting the pinned proxy', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-command-shim-'));
    const forwardedArgs = ['--mcp-fixture-args', 'value with spaces', '', 'C:\\Program Files\\', 'next'];
    try {
      const shimDirectory = path.join(directory, 'bin');
      await mkdir(shimDirectory);
      const shim = path.join(shimDirectory, 'fixture.cmd');
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`, 'utf8');
      const rootRelativeShim = `${path.win32.sep}${path.win32.relative(path.win32.parse(shim).root, shim)}`;
      for (const target of [
        { command: 'fixture.cmd', PATH: 'bin' },
        { command: rootRelativeShim, PATH: '' },
      ]) {
        const session = await createDefaultMcpClientFactory(undefined, createNativeWindowsMcpStdioOwner()).connect({
          command: target.command,
          args: forwardedArgs,
          cwd: directory,
          env: {
            PATH: target.PATH,
            LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'modern',
            LNWJUD_EXTERNAL_MCP_FIXTURE_ECHO_ARGS: 'true',
          },
        });
        try {
          await expect(session.listTools()).resolves.toEqual([expect.objectContaining({
            name: 'modern_ping',
            description: `modern external MCP fixture ${JSON.stringify(forwardedArgs)}`,
          })]);
        } finally {
          await session.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('rejects an unresolved target before trying to pin or start the proxy', async () => {
    const owner = createWindowsMcpStdioOwner({
      helper: { executable: path.join(os.tmpdir(), 'missing-helper.exe'), sha256: '0'.repeat(64), buildId: 'lnwjud-containment-v2' },
      pin: { modulePath: path.join(os.tmpdir(), 'missing-pin.node'), sha256: '0'.repeat(64) },
    });
    await expect(owner.prepare({ command: path.join(os.tmpdir(), `missing-target-${process.pid}.exe`) }))
      .rejects.toThrow('MCP_TARGET_EXECUTABLE_UNAVAILABLE');
  });

  it.skipIf(process.platform !== 'win32')('rejects an invalid working directory before pinning the helper', async () => {
    const owner = createWindowsMcpStdioOwner({
      helper: { executable: path.join(os.tmpdir(), 'missing-helper.exe'), sha256: '0'.repeat(64), buildId: 'lnwjud-containment-v2' },
      pin: { modulePath: path.join(os.tmpdir(), 'missing-pin.node'), sha256: '0'.repeat(64) },
    });
    await expect(owner.prepare({
      command: process.execPath,
      cwd: path.join(os.tmpdir(), `lnwjud-missing-cwd-${process.pid}-${Date.now()}`),
    })).rejects.toThrow('MCP_TARGET_WORKING_DIRECTORY_UNAVAILABLE');
  });

  it.skipIf(process.platform !== 'win32')('rejects unsupported .com targets before pinning the helper', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-com-target-'));
    try {
      const target = path.join(directory, 'target.com');
      await writeFile(target, Buffer.alloc(0));
      const owner = createWindowsMcpStdioOwner({
        helper: { executable: path.join(os.tmpdir(), 'missing-helper.exe'), sha256: '0'.repeat(64), buildId: 'lnwjud-containment-v2' },
        pin: { modulePath: path.join(os.tmpdir(), 'missing-pin.node'), sha256: '0'.repeat(64) },
      });
      await expect(owner.prepare({ command: target, cwd: directory }))
        .rejects.toThrow('MCP_TARGET_EXECUTABLE_UNAVAILABLE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('honors lowercase PATHEXT overrides during Windows preflight', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-pathext-'));
    const owner = createWindowsMcpStdioOwner({
      helper: { executable: path.join(directory, 'missing-helper.exe'), sha256: '0'.repeat(64), buildId: 'lnwjud-containment-v2' },
      pin: { modulePath: path.join(directory, 'missing-pin.node'), sha256: '0'.repeat(64) },
    });
    try {
      const bin = path.join(directory, 'bin');
      await mkdir(bin);
      await writeFile(path.join(bin, 'fixture.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
      await expect(owner.prepare({
        command: 'fixture',
        cwd: directory,
        env: { PATH: 'bin', pathext: '.BAT' },
      })).rejects.toThrow('MCP_TARGET_EXECUTABLE_UNAVAILABLE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('cleans up the manual local-resource proxy when its target exits before session close', async () => {
    const helper = fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment.exe', import.meta.url));
    const pin = fileURLToPath(new URL('../../../apps/desktop/build/native-containment/lnwjud-containment-pin.node', import.meta.url));
    const owner = createWindowsMcpStdioOwner({
      helper: { executable: helper, sha256: CONTAINMENT_HELPER_SHA256, buildId: 'lnwjud-containment-v2' },
      pin: { modulePath: pin, sha256: CONTAINMENT_PIN_SHA256 },
    });
    const session = await connectFixture('exit-on-call', createDefaultMcpClientFactory(undefined, owner));
    try {
      await session.listTools();
      await expect(session.callTool('legacy_ping', {})).rejects.toThrow();
      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('passes the SDK child handle to process-group cleanup', async () => {
    const terminator = createProcessTreeTerminator('linux');
    const stop = vi.fn(terminator.stop.bind(terminator));
    const factory = createDefaultMcpClientFactory({ stop });
    const session = await connectFixture('modern', factory);
    try {
      await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: 'modern_ping' })]);
    } finally {
      await session.close();
    }
    expect(stop).toHaveBeenCalledTimes(2);
    for (const [child, pid] of stop.mock.calls) {
      expect(child).toBeInstanceOf(ChildProcess);
      expect(child.pid).toBe(pid);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('retains the child handle after the server exits during a tool call', async () => {
    const terminator = createProcessTreeTerminator('linux');
    let rootHadExited = false;
    const stop = vi.fn(async (child: ChildProcess, pid: number): Promise<void> => {
      rootHadExited = child.exitCode !== null || child.signalCode !== null;
      await terminator.stop(child, pid);
    });
    const session = await connectFixture('exit-on-call', createDefaultMcpClientFactory({ stop }));
    try {
      await expect(session.callTool('legacy_ping', {})).rejects.toThrow(/closed/i);
    } finally {
      await session.close();
    }
    expect(stop).toHaveBeenCalledTimes(2);
    expect(rootHadExited).toBe(true);
  }, 20_000);

  it.skipIf(process.platform !== 'win32').each(['modern', 'legacy-exit-on-discover'] as const)(
    'verifies the %s probe before the main child and retains its helper pin', async (era) => {
      const verified: ChildProcess[] = [];
      const order: string[] = [];
      let releaseCount = 0;
      const originalStart = StdioClientTransport.prototype.start;
      const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start').mockImplementation(function (this: StdioClientTransport): Promise<void> {
        order.push('start');
        return originalStart.call(this);
      });
      const factory = createTestMcpClientFactory(createProcessTreeTerminator(), {
        async closeAndVerify(child, verify): Promise<void> { verified.push(child); order.push('verified'); await verify(); },
        release(): void { releaseCount += 1; },
      });
      try {
        const session = await connectFixture(era, factory);
        try {
          expect(verified).toHaveLength(1);
          expect(releaseCount).toBe(0);
          expect(order.slice(0, 3)).toEqual(['start', 'verified', 'start']);
          const probe = verified[0];
          await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: era === 'modern' ? 'modern_ping' : 'legacy_ping' })]);
          await session.close();
          expect(verified).toHaveLength(2);
          expect(verified[1]).not.toBe(probe);
          expect(releaseCount).toBe(1);
        } finally {
          await session.close();
        }
      } finally {
        startSpy.mockRestore();
      }
    },
  );

  it.skipIf(process.platform !== 'win32')('surfaces failed probe cleanup and retains the pre-main pin until scoped cleanup succeeds', async () => {
    let cleanupAllowed = false;
    let cleanupAttempts = 0;
    let releaseCount = 0;
    const manager = new McpSessionManager({
      clientFactory: createTestMcpClientFactory(createProcessTreeTerminator(), {
        async closeAndVerify(_child, verify): Promise<void> {
          cleanupAttempts += 1;
          if (!cleanupAllowed) throw new Error('Fixture probe cleanup unverified');
          await verify();
        },
        release(): void { releaseCount += 1; },
      }),
    });
    const config = (era: 'modern' | 'legacy-exit-on-discover'): Parameters<McpClientFactory['connect']>[0] => ({
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: era },
    });
    try {
      const failed = await manager.describe('fixture', config('legacy-exit-on-discover'));
      expect(failed.ok).toBe(false);
      expect(cleanupAttempts).toBeGreaterThanOrEqual(2);
      expect(releaseCount).toBe(0);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');

      const blocked = await manager.describe('fixture', config('modern'));
      expect(blocked.ok).toBe(false);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');

      cleanupAllowed = true;
      const recovered = await manager.describe('fixture', config('modern'));
      expect(recovered.ok).toBe(true);
      expect(releaseCount).toBe(1);
      await manager.close();
      expect(releaseCount).toBe(2);
    } finally {
      cleanupAllowed = true;
      await manager.close();
    }
  }, 30_000);

  it('waits for the SDK legacy-handshake close before reporting a failed connection', async () => {
    const originalClose = StdioClientTransport.prototype.close;
    let releaseClose!: () => void;
    let closeCalls = 0;
    let settled = false;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.spyOn(StdioClientTransport.prototype, 'close').mockImplementation(async function (this: StdioClientTransport): Promise<void> {
      closeCalls += 1;
      await closeBarrier;
      await originalClose.call(this);
    });
    const connection = connectFixture('initialize-error').then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await vi.waitFor(() => expect(closeCalls).toBeGreaterThan(0), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closeCalls).toBe(1);
      expect(settled).toBe(false);
    } finally {
      releaseClose();
      close.mockRestore();
    }
    expect(await connection).toBeInstanceOf(Error);
    expect(closeCalls).toBe(1);
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('keeps a Windows replacement fenced when the SDK child exits first', async () => {
    const taskkill = vi.fn(async (): Promise<number> => 0);
    const terminator = new WindowsProcessTree({ platform: 'win32', taskkill });
    let probeStops = 0;
    const factory = createTestMcpClientFactory(terminator, {
      async closeAndVerify(child, verify): Promise<void> {
        if (probeStops++ === 0 && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await closed;
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Process root exited before tree termination could be verified');
        await verify();
      },
    });
    const manager = new McpSessionManager({ clientFactory: factory });
    const config = (era: 'exit-on-call' | 'modern'): Parameters<McpClientFactory['connect']>[0] => ({
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: era },
    });
    try {
      expect((await manager.describe('fixture', config('exit-on-call'))).ok).toBe(true);
      expect((await manager.call('fixture', config('exit-on-call'), 'legacy_ping', {})).ok).toBe(false);
      expect((await manager.describe('fixture', config('modern'))).ok).toBe(false);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
    } finally {
      await manager.close();
    }
    expect(taskkill).not.toHaveBeenCalled();
  }, 20_000);

  it.each(['legacy', 'legacy-exit-on-discover'] as const)('connects to a legacy 2025-era stdio MCP server (%s)', async (era) => {
    const session = await connectFixture(era);
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'legacy_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it.skipIf(process.platform === 'darwin')('reports failed connection cleanup while preserving the connection error', async () => {
    const cleanupError = new Error('Fixture process-tree cleanup unverified');
    const processTree = createProcessTreeTerminator();
    let cleanupCalls = 0;
    const stop = async (child: ChildProcess, pid: number): Promise<void> => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) return processTree.stop(child, pid);
      throw cleanupError;
    };
    const terminator = { stop };
    const factory = createTestMcpClientFactory(terminator);
    await expect(connectFixture('initialize-error', factory)).rejects.toMatchObject({
      name: 'AggregateError',
      cause: expect.objectContaining({ message: expect.stringContaining('Fixture initialization rejected') }),
      errors: [expect.objectContaining({ message: expect.stringContaining('Fixture initialization rejected') }), cleanupError],
    });
  }, 20_000);

  it.skipIf(process.platform === 'darwin')('blocks reconnect while failed connection cleanup remains unverified', async () => {
    let cleanupVerified = false;
    const stop = vi.fn(async (): Promise<void> => {
      if (!cleanupVerified) throw new Error('Fixture process-tree cleanup unverified');
    });
    const manager = new McpSessionManager({ clientFactory: createTestMcpClientFactory({ stop }) });
    const config = (era: string): Parameters<McpClientFactory['connect']>[0] => ({
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: era },
    });
    try {
      const failed = await manager.describe('fixture', config('initialize-error'));
      expect(failed.ok).toBe(false);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');

      const blocked = await manager.describe('fixture', config('modern'));
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.message).toContain('termination is unverified');
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');

      cleanupVerified = true;
      const recovered = await manager.describe('fixture', config('modern'));
      expect(recovered.ok).toBe(true);
      expect(manager.lifecycle('fixture')).toBe('connected');
    } finally {
      cleanupVerified = true;
      await manager.close();
    }
  }, 30_000);

  it('blocks a config replacement when the current session close is unverified', async () => {
    let connectCalls = 0;
    const session: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => { throw new Error('Current session cleanup unverified'); },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return session;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory });
    const config = (command: string): Parameters<McpClientFactory['connect']>[0] => ({ command });
    try {
      const initial = await manager.describe('fixture', config('first'));
      expect(initial.ok).toBe(true);

      const replacement = await manager.describe('fixture', config('second'));
      expect(replacement.ok).toBe(false);
      if (!replacement.ok) expect(replacement.error.message).toContain('termination is unverified');
      expect(connectCalls).toBe(1);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
    } finally {
      await manager.close();
    }
  });

  it('fences concurrent config replacements until session retirement is verified', async () => {
    let connectCalls = 0;
    let closeCalls = 0;
    let releaseClose!: () => void;
    let reportCloseStarted!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve; });
    const session: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) {
          reportCloseStarted();
          await closeBarrier;
          throw new Error('Retiring session cleanup unverified');
        }
      },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return session;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory });
    const config = (command: string): Parameters<McpClientFactory['connect']>[0] => ({ command });
    try {
      expect((await manager.describe('fixture', config('first'))).ok).toBe(true);
      const firstReplacement = manager.describe('fixture', config('second'));
      await closeStarted;
      let secondSettled = false;
      const secondReplacement = manager.describe('fixture', config('third')).finally(() => { secondSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondSettled).toBe(false);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
      expect(connectCalls).toBe(1);

      releaseClose();
      const [first, second] = await Promise.all([firstReplacement, secondReplacement]);
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(connectCalls).toBe(1);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
    } finally {
      releaseClose();
      await manager.close();
    }
  }, 15_000);

  it('does not launch a replacement when shutdown starts during session retirement', async () => {
    let connectCalls = 0;
    let releaseClose!: () => void;
    let reportCloseStarted!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve; });
    const session: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => { reportCloseStarted(); await closeBarrier; },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return session;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory });
    const config = (command: string): Parameters<McpClientFactory['connect']>[0] => ({ command });
    try {
      expect((await manager.describe('fixture', config('first'))).ok).toBe(true);
      const replacement = manager.describe('fixture', config('second'));
      await closeStarted;
      const shutdown = manager.close();
      releaseClose();
      const result = await replacement;
      await shutdown;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('manager is closed');
      expect(connectCalls).toBe(1);
    } finally {
      releaseClose();
      await manager.close();
    }
  }, 15_000);

  it('does not launch a replacement when the caller aborts during session retirement', async () => {
    let connectCalls = 0;
    let releaseClose!: () => void;
    let reportCloseStarted!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve; });
    const session: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => { reportCloseStarted(); await closeBarrier; },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return session;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory });
    const controller = new AbortController();
    const config = (command: string): Parameters<McpClientFactory['connect']>[0] => ({ command });
    try {
      expect((await manager.describe('fixture', config('first'))).ok).toBe(true);
      const replacement = manager.describe('fixture', config('second'), controller.signal);
      await closeStarted;
      controller.abort(new Error('Cancelled during session retirement'));
      releaseClose();
      const result = await replacement;
      expect(result.ok).toBe(false);
      expect(connectCalls).toBe(1);
    } finally {
      releaseClose();
      await manager.close();
    }
  }, 15_000);

  it('retains late factory cleanup ownership through bounded shutdown', async () => {
    let resolveLateSession!: (session: McpClientSession) => void;
    let releaseCleanup!: () => void;
    let reportCleanupStarted!: () => void;
    let reportCleanupFinished!: () => void;
    let connectCalls = 0;
    const lateSessionPromise = new Promise<McpClientSession>((resolve) => { resolveLateSession = resolve; });
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStarted = new Promise<void>((resolve) => { reportCleanupStarted = resolve; });
    const cleanupFinished = new Promise<void>((resolve) => { reportCleanupFinished = resolve; });
    let lateCloseCalls = 0;
    const lateSession: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => {
        lateCloseCalls += 1;
        if (lateCloseCalls !== 1) return;
        reportCleanupStarted();
        try {
          await cleanupBarrier;
          throw new Error('Late shutdown cleanup unverified');
        } finally {
          reportCleanupFinished();
        }
      },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return lateSessionPromise;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory, callTimeoutMs: 20 });
    const config: Parameters<McpClientFactory['connect']>[0] = { command: 'first' };
    try {
      expect((await manager.describe('fixture', config)).ok).toBe(false);
      await manager.close();
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
      expect((await manager.describe('fixture', config)).ok).toBe(false);
      expect(connectCalls).toBe(1);

      resolveLateSession(lateSession);
      await cleanupStarted;
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
      releaseCleanup();
      await cleanupFinished;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');
      expect(connectCalls).toBe(1);

      await manager.close();
      expect(lateCloseCalls).toBe(2);
      expect(manager.lifecycle('fixture')).toBe('disconnected');
    } finally {
      releaseCleanup();
      await manager.close();
    }
  }, 15_000);

  it('keeps a timed-out connection fenced until its late cleanup settles', async () => {
    let connectCalls = 0;
    let resolveLateSession!: (session: McpClientSession) => void;
    let releaseCleanup!: () => void;
    let reportCleanupStarted!: () => void;
    const lateSessionPromise = new Promise<McpClientSession>((resolve) => { resolveLateSession = resolve; });
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStarted = new Promise<void>((resolve) => { reportCleanupStarted = resolve; });
    const healthySession: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => {},
    };
    let lateCloseCalls = 0;
    const lateSession: McpClientSession = {
      listTools: async () => [],
      listResources: async () => [],
      callTool: async () => undefined,
      close: async () => {
        lateCloseCalls += 1;
        if (lateCloseCalls === 1) {
          reportCleanupStarted();
          await cleanupBarrier;
          throw new Error('Late connection cleanup unverified');
        }
      },
    };
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        connectCalls += 1;
        return connectCalls === 1 ? lateSessionPromise : healthySession;
      },
    };
    const manager = new McpSessionManager({ clientFactory: factory, callTimeoutMs: 20 });
    const config = (command: string): Parameters<McpClientFactory['connect']>[0] => ({ command });
    try {
      const timedOut = await manager.describe('fixture', config('first'));
      expect(timedOut.ok).toBe(false);
      expect(manager.lifecycle('fixture')).toBe('termination_unverified');

      const blocked = await manager.describe('fixture', config('second'));
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.message).toContain('connection cleanup is still pending');
      expect(connectCalls).toBe(1);

      resolveLateSession(lateSession);
      await cleanupStarted;
      const blockedDuringCleanup = await manager.describe('fixture', config('second'));
      expect(blockedDuringCleanup.ok).toBe(false);
      expect(connectCalls).toBe(1);

      releaseCleanup();
      await vi.waitFor(async () => {
        const recovered = await manager.describe('fixture', config('second'));
        expect(recovered.ok).toBe(true);
      }, { timeout: 5_000 });
      expect(connectCalls).toBe(2);
      expect(manager.lifecycle('fixture')).toBe('connected');
    } finally {
      releaseCleanup();
      await manager.close();
    }
  }, 15_000);

  it('connects to a modern 2026-07-28 stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('modern');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'modern_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('bypasses SDK callTool output validation so isError results reach the lnwjud guard', async () => {
    const sdkCallTool = vi.spyOn(Client.prototype, 'callTool').mockRejectedValue(
      new Error('SDK callTool output-schema validation ran before lnwjud guard'),
    );
    const session = await connectFixture('schema-error');
    try {
      await session.listTools();
      await expect(session.callTool('schema_error_demo', { mode: 'error-no-structured' })).resolves.toMatchObject({
        isError: true,
        content: [{ text: 'Demo validation failed: invalid input' }],
      });
      expect(sdkCallTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
      sdkCallTool.mockRestore();
    }
  }, 20_000);

  it('preserves child tool errors while lnwjud validates successful structured output', async () => {
    const manager = new McpSessionManager({ clientFactory: createTestMcpClientFactory(), callTimeoutMs: 20_000 });
    const config = {
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'schema-error' },
    } as const;
    try {
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'error-no-structured' })).resolves.toMatchObject({
        ok: true,
        value: {
          isError: true,
          content: [{ text: 'Demo validation failed: invalid input' }],
        },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'error-invalid-structured' })).resolves.toMatchObject({
        ok: true,
        value: { isError: true, structuredContent: { value: 42 } },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-valid' })).resolves.toMatchObject({
        ok: true,
        value: { structuredContent: { value: 'ok' } },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-invalid' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', message: expect.stringContaining('output schema mismatch') },
      });
      await expect(manager.call('schema-fixture', config, 'schema_error_demo', { mode: 'success-missing' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', message: expect.stringContaining('declared outputSchema requires structuredContent') },
      });
    } finally {
      await manager.close();
    }
  }, 30_000);

  it('survives a ten-cycle connect/use/close soak without retaining child sessions', async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const session = await connectFixture('modern');
      try {
        await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: 'modern_ping' })]);
      } finally {
        await session.close();
      }
    }
  }, 60_000);
});
