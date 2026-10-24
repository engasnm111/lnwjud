import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdtemp, mkdir, open, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsNativeAuthority } from '@lnwjud/process';
import { describe, expect, it, vi } from 'vitest';
import { TunnelAliasRetirementJournal } from '../src/main/tunnel-runtime-alias-journal.js';
import {
  TunnelRuntimeAdapter,
  parseNativeRuntimeStatus,
  type TunnelRuntimeExecResult,
  type TunnelRuntimeExecutor,
} from '../src/main/tunnel-runtime-adapter.js';

const nativeTestHelper = process.env.LNWJUD_TUNNEL_TEST_HELPER ?? path.resolve('build/native-containment/lnwjud-containment.exe');

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
  it.each(['connect', 'stop', 'ensureSingleProcess'] as const)('refuses %s before any CLI or process mutation when pending retirement recovery conflicts', async (operation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-recovery-entrypoint-'));
    try {
      await writeFile(path.join(root, '.lnwjud-stale-alias.json'), '{}');
      const execute = vi.fn(async (): Promise<TunnelRuntimeExecResult> => ({ stdout: '{}', stderr: '' }));
      const processGuard = vi.fn(async (): Promise<void> => undefined);
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: { TUNNEL_CLIENT_STATE_DIR: root },
        execute, processGuard,
        clearStaleTunnelAlias: async (): Promise<void> => { throw new Error('TUNNEL_STALE_SNAPSHOT_CHANGED'); },
      });
      const result = operation === 'connect'
        ? adapter.connect({ tunnelId: 'tunnel_newalias12345', mcpServerUrl: 'http://127.0.0.1:18765/mcp' })
        : operation === 'stop'
          ? adapter.stop('tunnel_newalias12345')
          : adapter.ensureSingleProcess('tunnel_newalias12345', parseNativeRuntimeStatus('{"exists":false,"process_running":false}'));
      await expect(result).rejects.toThrow('TUNNEL_STALE_SNAPSHOT_CHANGED');
      expect(execute).not.toHaveBeenCalled();
      expect(processGuard).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps recovery out of read-only status and runs it only from the explicit lifecycle hook', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-retirement-hook-'));
    try {
      await writeFile(path.join(root, '.lnwjud-stale-alias.json'), '{}');
      const clearStaleTunnelAlias = vi.fn(async (): Promise<void> => undefined);
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root,
        environment: { TUNNEL_CLIENT_STATE_DIR: root }, clearStaleTunnelAlias,
        execute: executor({ 'runtimes status lnwjud --json': { error: 'alias lnwjud is not known' } }),
      });
      await expect(adapter.status(true)).resolves.toMatchObject({ exists: false });
      await adapter.capabilities();
      expect(clearStaleTunnelAlias).not.toHaveBeenCalled();
      await adapter.recoverStoppedAliasRetirement();
      expect(clearStaleTunnelAlias).toHaveBeenCalledExactlyOnceWith({
        recoveryOnly: true, stateRoot: root, alias: 'lnwjud', profileDirectory: root,
      });
      await rm(root, { recursive: true, force: true });
      await adapter.recoverStoppedAliasRetirement();
      expect(clearStaleTunnelAlias).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { shape: 'missing', extra: {} },
    { shape: 'contradictory', extra: { process_running: false, process: { running: true } } },
  ])('refuses stale-record cleanup with $shape stopped evidence', async ({ extra }) => {
    const commands: string[] = [];
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'fixture.exe', profileDirectory: 'profile', environment: {},
      execute: async (_exe, args): Promise<TunnelRuntimeExecResult> => {
        const command = args.join(' ');
        commands.push(command);
        if (command !== 'runtimes status lnwjud --json') throw new Error('Unsafe CLI operation');
        return {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', pid: 9832, ...extra }),
          stderr: '',
        };
      },
    });
    await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('active or its identity changed');
    expect(commands).toEqual(['runtimes status lnwjud --json']);
  });

  it.runIf(process.platform === 'win32' && existsSync(path.resolve('build/tunnel-client/tunnel-client.exe'))
    && existsSync(nativeTestHelper))(
    'retires a real stopped native record with a reused live PID without terminating that unrelated process', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-real-stopped-alias-'));
      const profileDirectory = path.join(root, 'profile');
      const stateDirectory = path.join(root, 'state');
      await mkdir(profileDirectory);
      await mkdir(stateDirectory);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      await once(child, 'spawn');
      const childPid = child.pid;
      if (childPid === undefined) throw new Error('Fixture child has no PID');
      const childExit = once(child, 'exit');
      try {
        const profilePath = path.join(profileDirectory, 'lnwjud.yaml');
        const profile = 'control_plane:\n  tunnel_id: tunnel_newalias12345\n';
        await writeFile(profilePath, profile);
        const alias = {
          alias: 'lnwjud', tunnel_id: 'tunnel_oldalias12345', profile_name: 'lnwjud',
          profile_dir: profileDirectory, profile_path: profilePath, config_path: profilePath,
        };
        const other = { alias: 'another-app', tunnel_id: 'tunnel_otherapp12345', unknown_field: ['preserve', 42] };
        await writeFile(path.join(stateDirectory, 'aliases.yaml'), JSON.stringify({ lnwjud: alias, other }));
        await writeFile(path.join(stateDirectory, 'processes.yaml'), JSON.stringify({
          lnwjud: {
            ...alias, mode: 'process', pid: childPid, pid_start_time: '1577836800000000000', pid_executable: process.execPath,
            started_at: '2020-01-01T00:00:00Z', command: 'isolated stale identity fixture',
          }, other,
        }));
        const helper = nativeTestHelper;
        const pin = path.resolve('build/native-containment/lnwjud-containment-pin.node');
        const authority = new WindowsNativeAuthority({
          helper: { executable: helper, sha256: createHash('sha256').update(await readFile(helper)).digest('hex'), buildId: 'lnwjud-containment-v2' },
          pin: { modulePath: pin, sha256: createHash('sha256').update(await readFile(pin)).digest('hex') },
        });
        const adapter = new TunnelRuntimeAdapter({
          clientPath: path.resolve('build/tunnel-client/tunnel-client.exe'), profileDirectory,
          environment: {
            ...process.env, TUNNEL_CLIENT_STATE_DIR: stateDirectory,
            TUNNEL_CLIENT_PROFILE_DIR: profileDirectory, TUNNEL_CLIENT_PROFILE: 'lnwjud',
          },
          processGuard: async (): Promise<void> => undefined,
          clearStaleTunnelAlias: (request): Promise<void> => authority.clearStaleTunnelAlias(request),
        });
        await expect(adapter.status(true)).resolves.toMatchObject({ running: false, pid: childPid });
        await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).resolves.toBeUndefined();
        await expect(adapter.status(true)).resolves.toMatchObject({ exists: false });
        expect(child.exitCode).toBeNull();
        expect(process.kill(childPid, 0)).toBe(true);
        await expect(readFile(profilePath, 'utf8')).resolves.toBe(profile);
        expect(JSON.parse(await readFile(path.join(stateDirectory, 'aliases.yaml'), 'utf8'))).toEqual({ other });
        expect(JSON.parse(await readFile(path.join(stateDirectory, 'processes.yaml'), 'utf8'))).toEqual({ other });
      } finally {
        child.kill();
        await childExit;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { historyBytes: 12, durableRecovery: false },
    { historyBytes: 12, durableRecovery: true },
    { historyBytes: 42_873_930, durableRecovery: false },
    { historyBytes: 42_873_930, durableRecovery: true },
  ])('retires a stopped alias while preserving $historyBytes history bytes with durable recovery $durableRecovery', async ({ historyBytes, durableRecovery }) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stopped-alias-'));
    const root = path.join(temporaryRoot, 'profile');
    try {
      await mkdir(path.join(root, 'health'), { recursive: true });
      const profile = 'health:\n  url_file: health/lnwjud.url\n';
      await writeFile(path.join(root, 'lnwjud.yaml'), profile);
      const history = path.join(root, 'lnwjud-tunnel.log');
      const historyData = Buffer.alloc(historyBytes, 0x61);
      const historyHash = createHash('sha256').update(historyData).digest('hex');
      await writeFile(history, historyData, { mode: 0o600 });
      await utimes(history, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
      const historyBefore = await lstat(history);
      await writeFile(path.join(root, 'health', 'lnwjud.url'), 'http://127.0.0.1:7777');
      await writeFile(path.join(root, 'other.yaml'), 'must-stay');
      let removed = false;
      const commands: string[] = [];
      const execute: TunnelRuntimeExecutor = async (_executable, args): Promise<{ stdout: string; stderr: string }> => {
        const command = args.join(' ');
        commands.push(command);
        if (command === 'runtimes status lnwjud --json') {
          if (removed) throw Object.assign(new Error('alias lnwjud is not known'), { stdout: '', stderr: 'alias lnwjud is not known' });
          return { stdout: JSON.stringify({ exists: true, tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
        }
        if (command === 'runtimes rm lnwjud --json') {
          removed = true;
          await rm(path.join(root, 'lnwjud.yaml'));
          await rm(path.join(root, 'health', 'lnwjud.url'));
          return { stdout: '{"removed":true}', stderr: '' };
        }
        throw new Error('Unexpected CLI command');
      };
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: {}, execute,
        ...(durableRecovery ? { recoveryDirectory: path.join(temporaryRoot, 'recovery') } : {}),
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).resolves.toBeUndefined();
      expect(commands).toContain('runtimes rm lnwjud --json');
      expect(commands).not.toContain('runtimes stop lnwjud --json');
      await expect(adapter.status(true)).resolves.toMatchObject({ exists: false });
      await expect(readFile(path.join(root, 'lnwjud.yaml'), 'utf8')).resolves.toBe(profile);
      expect(createHash('sha256').update(await readFile(history)).digest('hex')).toBe(historyHash);
      const historyAfter = await lstat(history);
      expect(historyAfter.size).toBe(historyBytes);
      expect(historyAfter.mode).toBe(historyBefore.mode);
      expect(historyAfter.mtimeMs).toBe(historyBefore.mtimeMs);
      expect(historyAfter.ino).toBe(historyBefore.ino);
      await expect(readFile(path.join(root, 'health', 'lnwjud.url'), 'utf8')).resolves.toBe('http://127.0.0.1:7777');
      await expect(readFile(path.join(root, 'other.yaml'), 'utf8')).resolves.toBe('must-stay');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(['directory', 'junction'])('leaves an unrelated history %s untouched during alias retirement', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-history-shape-'));
    try {
      const profileDirectory = path.join(root, 'profile');
      const history = path.join(profileDirectory, 'lnwjud-tunnel.log');
      const historyDirectory = kind === 'directory' ? history : path.join(root, 'other-history');
      await mkdir(profileDirectory);
      await mkdir(historyDirectory);
      if (kind === 'junction') await symlink(historyDirectory, history, 'junction');
      await writeFile(path.join(historyDirectory, 'keep.txt'), 'unrelated-history');
      await writeFile(path.join(profileDirectory, 'lnwjud.yaml'), 'tunnel_id: tunnel_oldalias12345\n');
      const before = await lstat(history);
      const originalLink = kind === 'junction' ? await readlink(history) : null;
      let removed = false;
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory, environment: {}, recoveryDirectory: path.join(root, 'recovery'),
        execute: async (_exe, args): Promise<TunnelRuntimeExecResult> => {
          const command = args.join(' ');
          if (command === 'runtimes status lnwjud --json') {
            if (removed) throw new Error('alias lnwjud is not known');
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          if (command === 'runtimes rm lnwjud --json') {
            removed = true;
            await rm(path.join(profileDirectory, 'lnwjud.yaml'));
            return { stdout: '{"removed":true}', stderr: '' };
          }
          throw new Error('Unexpected CLI command');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).resolves.toBeUndefined();
      expect(removed).toBe(true);
      const after = await lstat(history);
      expect(after.isSymbolicLink()).toBe(kind === 'junction');
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      if (kind === 'junction') expect(await readlink(history)).toBe(originalLink);
      await expect(readFile(path.join(historyDirectory, 'keep.txt'), 'utf8')).resolves.toBe('unrelated-history');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a historical v1 history backup before retiring the alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-legacy-history-recovery-'));
    try {
      const profileDirectory = path.join(root, 'profile');
      const recoveryDirectory = path.join(root, 'recovery');
      const history = path.join(profileDirectory, 'lnwjud-tunnel.log');
      await mkdir(profileDirectory);
      await writeFile(path.join(profileDirectory, 'lnwjud.yaml'), 'tunnel_id: tunnel_oldalias12345\n');
      await writeFile(history, 'historical-backed-up-history');
      const journal = new TunnelAliasRetirementJournal(recoveryDirectory, profileDirectory);
      await journal.prepare([{ file: history, data: Buffer.from('historical-backed-up-history'), mode: 0o600 }]);
      await rm(history);
      let removed = false;
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory, recoveryDirectory, environment: {},
        execute: async (_exe, args): Promise<TunnelRuntimeExecResult> => {
          await expect(readFile(history, 'utf8')).resolves.toBe('historical-backed-up-history');
          const command = args.join(' ');
          if (command === 'runtimes status lnwjud --json') {
            if (removed) throw new Error('alias lnwjud is not known');
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          if (command === 'runtimes rm lnwjud --json') {
            removed = true;
            await rm(path.join(profileDirectory, 'lnwjud.yaml'));
            return { stdout: '{"removed":true}', stderr: '' };
          }
          throw new Error('Unexpected CLI command');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).resolves.toBeUndefined();
      expect(removed).toBe(true);
      await expect(readFile(history, 'utf8')).resolves.toBe('historical-backed-up-history');
      await expect(journal.recover()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { artifact: 'lnwjud.yaml', bytes: 1024 * 1024 + 1 },
    { artifact: 'lnwjud.runtime.secret', bytes: 16 * 1024 * 1024 + 1 },
    { artifact: 'lnwjud.oauth.session.secret', bytes: 16 * 1024 * 1024 + 1 },
    { artifact: 'health.url', bytes: 16 * 1024 * 1024 + 1 },
  ])('refuses oversized affected $artifact before native removal', async ({ artifact, bytes }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-affected-oversize-'));
    try {
      await writeFile(path.join(root, 'lnwjud.yaml'), 'health:\n  url_file: health.url\n');
      const file = await open(path.join(root, artifact), 'w');
      try { await file.truncate(bytes); } finally { await file.close(); }
      const execute = executor({
        'runtimes status lnwjud --json': { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }) },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'fixture.exe', profileDirectory: root, environment: {}, execute });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('oversized');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(execute).mock.calls[0]?.[1]).toEqual(['runtimes', 'status', 'lnwjud', '--json']);
      expect((await lstat(path.join(root, artifact))).size).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['lnwjud.yaml', 'lnwjud.runtime.secret', 'lnwjud.oauth.session.secret', 'health.url'])('refuses an affected %s junction before native removal', async (artifact) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-affected-junction-'));
    try {
      const profileDirectory = path.join(root, 'profile');
      const outside = path.join(root, 'outside');
      await mkdir(profileDirectory);
      await mkdir(outside);
      await writeFile(path.join(outside, 'keep.txt'), 'must-stay');
      if (artifact !== 'lnwjud.yaml') await writeFile(path.join(profileDirectory, 'lnwjud.yaml'), 'health:\n  url_file: health.url\n');
      await symlink(outside, path.join(profileDirectory, artifact), 'junction');
      const execute = executor({
        'runtimes status lnwjud --json': { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }) },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'fixture.exe', profileDirectory, environment: {}, execute });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow(/unsafe|untrusted/);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(execute).mock.calls[0]?.[1]).toEqual(['runtimes', 'status', 'lnwjud', '--json']);
      await expect(readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('must-stay');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers the protected profile when native rm fails after deleting a local artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-rm-failure-'));
    try {
      await writeFile(path.join(root, 'lnwjud.yaml'), 'tunnel_id: tunnel_newalias12345\n');
      await writeFile(path.join(root, 'unrelated.yaml'), 'keep');
      let rmCalled = false;
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: {},
        execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
          const command = args.join(' ');
          if (command === 'runtimes status lnwjud --json') {
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          if (command === 'runtimes rm lnwjud --json') {
            rmCalled = true;
            await rm(path.join(root, 'lnwjud.yaml'));
            throw Object.assign(new Error('simulated local cleanup failure'), { stderr: 'simulated local cleanup failure', stdout: '' });
          }
          throw new Error('Unexpected command');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('simulated local cleanup failure');
      expect(rmCalled).toBe(true);
      await expect(readFile(path.join(root, 'lnwjud.yaml'), 'utf8')).resolves.toBe('tunnel_id: tunnel_newalias12345\n');
      await expect(readFile(path.join(root, 'unrelated.yaml'), 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a profile health reference outside the owned directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-health-escape-'));
    try {
      await writeFile(path.join(root, 'lnwjud.yaml'), 'health:\n  url_file: ../other.url\n');
      const calls: string[] = [];
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: {},
        execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
          const command = args.join(' ');
          calls.push(command);
          if (command === 'runtimes status lnwjud --json') {
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          throw new Error('Must not run rm for escaped health artifact');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('escapes');
      expect(calls).not.toContain('runtimes rm lnwjud --json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a running mismatched alias without any CLI rm or stop side effect', async () => {
    const calls: string[] = [];
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'fixture.exe', profileDirectory: 'profile', environment: {},
      execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'runtimes status lnwjud --json') {
          return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: true, pid: 954321 }), stderr: '' };
        }
        throw new Error('Unsafe command requested');
      },
    });
    await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('active or its identity changed');
    expect(calls).toEqual(['runtimes status lnwjud --json']);
  });

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

  it('uses loopback health routes after the first managed-runtime status instead of polling the CLI every healthy cycle', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{
            health_state: 'healthy',
            route: { kind: 'control_plane', route_mode: 'proxy' },
            last_check: '2026-05-08T00:00:00Z',
          }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjud --json': {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process_running: true,
            healthy: true,
            ready: true,
            control_plane_poll_health: { state: 'healthy' },
            health_url: healthUrl,
          }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthUrl });
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: true });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('uses the live admin MCP target when persisted runtime status reports a newer port', async () => {
    const staleMcpServerUrl = 'http://127.0.0.1:59159/mcp';
    const configuredMcpServerUrl = 'http://127.0.0.1:61572/mcp';
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          control_plane_tunnel_id: 'tunnel_fixture012345',
          mcp_server_url: staleMcpServerUrl,
        }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{ health_state: 'healthy', route: { kind: 'control_plane' } }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const execute = executor({
        'runtimes status lnwjud --json': {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process_running: true,
            target_value: configuredMcpServerUrl,
            health_url: `http://127.0.0.1:${address.port}`,
          }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await expect(adapter.status()).resolves.toMatchObject({ mcpServerUrl: staleMcpServerUrl });
      await expect(adapter.status()).resolves.toMatchObject({ mcpServerUrl: staleMcpServerUrl });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('maps v0.0.14 control-plane unhealthy state without spawning a second CLI status', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{
            health_state: 'unhealthy',
            route: { kind: 'control_plane', route_mode: 'proxy' },
          }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjud --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: false });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('supports the newer control-plane health endpoint when the v0.0.14 system snapshot is unavailable', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.statusCode = 404;
        response.end('missing');
        return;
      }
      if (request.url === '/health/control-plane') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', state: 'polling' }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjud --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: true });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('falls back to authoritative CLI status when the cached admin URL belongs to a different tunnel', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_other012345' }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjud --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, tunnelId: 'tunnel_fixture012345' });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
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

    await expect(adapter.stop('tunnel_fixture012345')).resolves.toMatchObject({ running: false });
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

    await expect(adapter.stop('tunnel_fixture012345')).rejects.toThrow('still running after stop');
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
    const processGuard = vi.fn(async () => undefined);
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment, execute, processGuard });

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

  it.runIf(process.platform === 'win32')('does not report a successful connect while an old Windows process still needs retirement', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const mcpServerUrl = 'http://127.0.0.1:18765/mcp';
    const execute = executor({
      [`runtimes connect --alias lnwjud --tunnel-id ${tunnelId} --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url ${mcpServerUrl} --profile lnwjud --profile-dir C:\\profile --json`]: {
        stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: true, pid: 1234 }, mcp_server_url: mcpServerUrl }),
      },
    });
    const processGuard = vi.fn(async () => { throw new Error('Could not verify tunnel-client PID 99'); });
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment: {}, execute, processGuard });

    await expect(adapter.connect({ tunnelId, mcpServerUrl })).rejects.toThrow(/Restart Windows.*PID 99/);
    expect(processGuard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tunnelId, keepPid: 1234 }));
  });

  it.runIf(process.platform === 'win32')('checks for orphaned Windows processes after the official alias stops', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const execute = executor({
      'runtimes stop lnwjud --json': { stdout: JSON.stringify({ alias: 'lnwjud' }) },
      'runtimes status lnwjud --json': { stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: false } }) },
    });
    const processGuard = vi.fn(async () => undefined);
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment: {}, execute, processGuard });

    await expect(adapter.stop(tunnelId)).resolves.toMatchObject({ running: false });
    expect(processGuard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tunnelId, keepPid: null }));
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

  it('parses the real tunnel-client 0.0.13 stopped-status shape without treating unknown poll health as failure', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      admin_profile: 'default',
      alias: 'lnwjud',
      control_plane_poll_health: {
        reason: 'no live admin UI system snapshot',
        state: 'unknown',
      },
      healthy: false,
      local: {
        control_plane_poll_health: {
          reason: 'no live admin UI system snapshot',
          state: 'unknown',
        },
        process_running: false,
        runtime_state: 'stopped',
      },
      process: {
        mode: 'stopped',
        target_kind: 'server_url',
        target_value: 'http://127.0.0.1:18765/mcp',
        tunnel_id: 'tunnel_fixture013345',
      },
      process_running: false,
      profile_exists: true,
      ready: false,
      runtime_state: 'stopped',
      tunnel_id: 'tunnel_fixture013345',
      ui_url: '',
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: false,
      healthy: false,
      ready: false,
      pollHealthy: null,
      tunnelId: 'tunnel_fixture013345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: null,
      uiUrl: null,
    }));
  });
});
