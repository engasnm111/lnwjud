import { mkdir, readFile, mkdtemp, rm, stat, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExplicitKeySecretProtector } from '@lnwjud/shared';
import { migrateLegacyWindowsSecrets, type LegacySecretHelperRequest } from '../src/main/legacy-secret-migration.js';
import { RemoteMcpController } from '../src/main/remote-mcp-controller.js';
import { TunnelOAuthSessionStore } from '../src/main/tunnel-oauth-store.js';

const CHECKPOINT_KEY = Buffer.alloc(32, 0x2a).toString('base64');
const TUNNEL_KEY = 'legacy-tunnel-api-key';
const LEGACY_TUNNEL_HEX = '01000000d08c9ddf0115d1118c7a00c04fc297eb' + 'ab'.repeat(80);

describe('legacy Windows secret migration', () => {
  it.each([false, true])('checks the helper checksum (explicit override: %s) and preserves legacy data on mismatch', async (explicitOverride) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-helper-integrity-')));
    try {
      const helperPath = path.join(root, 'lnwjud-windows-secret-migrator.exe');
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      await writeFile(helperPath, 'invalid helper fixture');
      const helperSha256Path = path.join(root, explicitOverride ? 'custom-checksum.txt' : 'lnwjud-windows-secret-migrator.sha256');
      await writeFile(helperSha256Path, `${'0'.repeat(64)}  lnwjud-windows-secret-migrator.exe\n`);
      await writeFile(checkpointPath, 'dpapi:v2:legacy-fixture');
      await expect(migrateLegacyWindowsSecrets({
        platform: 'win32', helperPath, checkpointPath, tunnelSecretPath: path.join(root, 'missing.secret'),
        ...(explicitOverride ? { helperSha256Path } : {}),
        secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 0x21)),
      })).rejects.toThrow('Windows secret migration helper integrity check failed');
      expect(await readFile(checkpointPath, 'utf8')).toBe('dpapi:v2:legacy-fixture');
      await expect(stat(`${checkpointPath}.legacy-backup`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('migrates real Windows DPAPI and SecureString values with the shipped native helper', async () => {
    const exec = promisify(execFile);
    const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
    const helperPath = process.env.LNWJUD_TEST_WINDOWS_SECRET_MIGRATOR
      ?? path.join(repositoryRoot, 'native/windows-secret-migrator/bin/win-x64/lnwjud-windows-secret-migrator.exe');
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const powershellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    if (!existsSync(helperPath)) {
      if (process.env.LNWJUD_TEST_WINDOWS_SECRET_MIGRATOR !== undefined) throw new Error('Configured test helper does not exist');
      await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/build-windows-secret-migrator.ps1')], { windowsHide: true, timeout: 120_000, env: powershellEnv });
    }
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-native-migration-')));
    try {
      const fixture = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Security; $bytes = [Text.Encoding]::UTF8.GetBytes('${CHECKPOINT_KEY}'); $cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); $secure = ConvertTo-SecureString '${TUNNEL_KEY}' -AsPlainText -Force; @{ checkpoint = [Convert]::ToBase64String($cipher); tunnel = (ConvertFrom-SecureString $secure) } | ConvertTo-Json -Compress`,
      ], { windowsHide: true, env: powershellEnv });
      const legacy = JSON.parse(fixture.stdout) as { checkpoint: string; tunnel: string };
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      const tunnelSecretPath = path.join(root, 'lnwjud.runtime.secret');
      await writeFile(checkpointPath, `dpapi:v2:${legacy.checkpoint}`);
      await writeFile(tunnelSecretPath, legacy.tunnel);
      const secretProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x42));
      const options = { helperPath, checkpointPath, tunnelSecretPath, secretProtector };
      expect(await migrateLegacyWindowsSecrets(options)).toEqual({ checkpoint: 'migrated', tunnel: 'migrated' });
      expect(await secretProtector.decrypt('checkpoint_master_key', await readFile(checkpointPath, 'utf8'))).toMatchObject({ plainText: CHECKPOINT_KEY });
      expect(await secretProtector.decrypt('tunnel_api_key', await readFile(tunnelSecretPath, 'utf8'))).toMatchObject({ plainText: TUNNEL_KEY });
      expect(await readFile(`${checkpointPath}.legacy-backup`, 'utf8')).toBe(`dpapi:v2:${legacy.checkpoint}`);
      expect(await readFile(`${tunnelSecretPath}.legacy-backup`, 'utf8')).toBe(legacy.tunnel);
      expect(await migrateLegacyWindowsSecrets(options)).toEqual({ checkpoint: 'already_safe', tunnel: 'already_safe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);

  it('migrates every persisted OAuth/ngrok secret using the existing startup arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-oauth-migration-'));
    try {
      const tunnelDirectory = path.join(root, 'external-tunnel-profile');
      const remoteDirectory = path.join(root, 'remote-mcp');
      await mkdir(tunnelDirectory);
      await mkdir(remoteDirectory);
      const session = {
        schemaVersion: 1 as const, providerId: 'fixture', refreshToken: 'tunnel-refresh-token',
        accountId: null, accountLabel: 'Alice', organizationId: null, workspaceId: null,
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      };
      const state = {
        schemaVersion: 1, desiredRunning: true,
        trustedClients: [{ clientId: 'client', clientName: 'Existing client', redirectUris: ['https://example.com/callback'], tokenEndpointAuthMethod: 'none', clientSecret: null }],
        refreshGrants: [{ refreshToken: 'r'.repeat(40), clientId: 'client', expiresAt: Date.parse('2099-01-01') }],
      };
      const files = [
        [path.join(tunnelDirectory, 'lnwjud.oauth.session.secret'), JSON.stringify(session)],
        [path.join(remoteDirectory, 'oauth-state.secret'), JSON.stringify(state)],
        [path.join(remoteDirectory, 'ngrok-authtoken.secret'), 'existing-ngrok-authtoken'],
      ] as const;
      const legacyValues = files.map((_, index) => LEGACY_TUNNEL_HEX + String(index).repeat(2));
      for (const [index, [filename]] of files.entries()) await writeFile(filename, legacyValues[index]!, 'utf8');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x31));
      const runHelper = vi.fn(async (request: LegacySecretHelperRequest) => {
        if (request.op !== 'secure_string_v1') throw new Error('Unexpected legacy format');
        const index = legacyValues.indexOf(request.ciphertextHex);
        if (index < 0) throw new Error('Unexpected legacy file');
        return files[index]![1];
      });
      const options = { platform: 'win32' as const, checkpointPath: path.join(root, 'checkpoint-master.key'), tunnelSecretPath: path.join(tunnelDirectory, 'lnwjud.runtime.secret'), secretProtector: protector, runHelper };
      await migrateLegacyWindowsSecrets(options);
      await migrateLegacyWindowsSecrets(options);
      expect(runHelper).toHaveBeenCalledTimes(3);
      for (const [index, [filename, plaintext]] of files.entries()) {
        expect(await protector.decrypt('tunnel_api_key', await readFile(filename, 'utf8'))).toMatchObject({ plainText: plaintext });
        expect(await readFile(`${filename}.legacy-backup`, 'utf8')).toBe(legacyValues[index]);
        expect(await readFile(`${filename}.migration.json`, 'utf8')).not.toContain(plaintext);
      }
      expect(await new TunnelOAuthSessionStore({ filePath: files[0][0], secretProtector: protector }).read()).toEqual(session);
      const controller = new RemoteMcpController({ dataPath: root, secretProtector: protector, getLocalMcpUrl: async (): Promise<null> => null });
      const internal = controller as unknown as {
        ensurePersistenceLoaded(): Promise<void>;
        loadAuthtoken(): Promise<string | null>;
        desiredRunning: boolean;
        clients: Map<string, unknown>;
        refreshTokens: Map<string, unknown>;
      };
      await internal.ensurePersistenceLoaded();
      expect(internal.desiredRunning).toBe(true);
      expect(internal.clients.has('client')).toBe(true);
      expect(internal.refreshTokens.has('r'.repeat(40))).toBe(true);
      expect(await internal.loadAuthtoken()).toBe(files[2][1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-encrypts checkpoint and tunnel values atomically and leaves a recovery backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-migration-'));
    try {
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      const tunnelPath = path.join(root, 'tunnel', 'lnwjud.runtime.secret');
      await writeFile(checkpointPath, 'dpapi:v2:legacy-checkpoint-ciphertext\n', 'utf8');
      await mkdir(path.dirname(tunnelPath), { recursive: true });
      await writeFile(tunnelPath, LEGACY_TUNNEL_HEX, 'utf8');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x3d));
      const requests: LegacySecretHelperRequest[] = [];
      const result = await migrateLegacyWindowsSecrets({
        platform: 'win32',
        checkpointPath,
        tunnelSecretPath: tunnelPath,
        secretProtector: protector,
        runHelper: async (request) => {
          requests.push(request);
          return request.op === 'dpapi_v2' ? CHECKPOINT_KEY : TUNNEL_KEY;
        },
        now: () => new Date('2026-08-31T00:00:00.000Z'),
      });

      expect(result).toEqual({ checkpoint: 'migrated', tunnel: 'migrated' });
      expect(requests).toEqual([
        { op: 'dpapi_v2', ciphertextBase64: 'legacy-checkpoint-ciphertext' },
        { op: 'secure_string_v1', ciphertextHex: LEGACY_TUNNEL_HEX },
      ]);
      const checkpoint = await readFile(checkpointPath, 'utf8');
      const tunnel = await readFile(tunnelPath, 'utf8');
      expect(checkpoint).toMatch(/^safe:v1:/);
      expect(tunnel).toMatch(/^safe:v1:/);
      expect(await protector.decrypt('checkpoint_master_key', checkpoint)).toMatchObject({ plainText: CHECKPOINT_KEY });
      expect(await protector.decrypt('tunnel_api_key', tunnel)).toMatchObject({ plainText: TUNNEL_KEY });
      expect(await readFile(`${checkpointPath}.legacy-backup`, 'utf8')).toContain('dpapi:v2:');
      expect(await readFile(`${tunnelPath}.legacy-backup`, 'utf8')).toBe(LEGACY_TUNNEL_HEX);
      const receipt = await readFile(`${checkpointPath}.migration.json`, 'utf8');
      expect(receipt).not.toContain(CHECKPOINT_KEY);
      expect(receipt).not.toContain(TUNNEL_KEY);
      expect(JSON.parse(receipt)).toMatchObject({ schemaVersion: 1, operation: 'dpapi_v2', backupFile: 'checkpoint-master.key.legacy-backup' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['tunnel/lnwjud.oauth.session.secret', 'remote-mcp/oauth-state.secret', 'remote-mcp/ngrok-authtoken.secret'])(
    'preserves %s when replacement verification fails', async (relativePath) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-oauth-migration-fail-'));
      try {
        const filename = path.join(root, relativePath);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, LEGACY_TUNNEL_HEX, 'utf8');
        const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x32));
        const options = {
          platform: 'win32' as const, checkpointPath: path.join(root, 'checkpoint-master.key'),
          tunnelSecretPath: path.join(root, 'tunnel', 'lnwjud.runtime.secret'),
          secretProtector: { ...protector, decrypt: async (): Promise<never> => { throw new Error('Keyring became unavailable'); } },
          runHelper: async (): Promise<string> => 'existing-secret',
        };
        await expect(migrateLegacyWindowsSecrets(options)).rejects.toThrow('Keyring became unavailable');
        expect(await readFile(filename, 'utf8')).toBe(LEGACY_TUNNEL_HEX);
        expect(await readFile(`${filename}.legacy-backup`, 'utf8')).toBe(LEGACY_TUNNEL_HEX);
        await expect(stat(`${filename}.migration.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
        await migrateLegacyWindowsSecrets({ ...options, secretProtector: protector });
        expect(await protector.decrypt('tunnel_api_key', await readFile(filename, 'utf8'))).toMatchObject({ plainText: 'existing-secret' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('is idempotent and does not invoke the helper after a safe envelope exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-migration-idempotent-'));
    try {
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      const tunnelPath = path.join(root, 'lnwjud.runtime.secret');
      await writeFile(checkpointPath, 'dpapi:v1:legacy-secure-string', 'utf8');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x5e));
      const runHelper = vi.fn(async () => CHECKPOINT_KEY);
      const first = await migrateLegacyWindowsSecrets({ platform: 'win32', checkpointPath, tunnelSecretPath: tunnelPath, secretProtector: protector, runHelper });
      const second = await migrateLegacyWindowsSecrets({ platform: 'win32', checkpointPath, tunnelSecretPath: tunnelPath, secretProtector: protector, runHelper });
      expect(first.checkpoint).toBe('migrated');
      expect(second.checkpoint).toBe('already_safe');
      expect(runHelper).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the legacy value when decryption or verification fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-migration-fail-'));
    try {
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      const tunnelPath = path.join(root, 'lnwjud.runtime.secret');
      const legacy = 'dpapi:v2:corrupt-value';
      await writeFile(checkpointPath, legacy, 'utf8');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x7f));
      await expect(migrateLegacyWindowsSecrets({
        platform: 'win32',
        checkpointPath,
        tunnelSecretPath: tunnelPath,
        secretProtector: protector,
        runHelper: async () => { throw new Error('wrong user'); },
      })).rejects.toThrow(/wrong user/);
      expect(await readFile(checkpointPath, 'utf8')).toBe(legacy);
      await expect(stat(`${checkpointPath}.legacy-backup`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is a no-op on macOS and Linux, including when legacy-looking files exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-migration-posix-'));
    try {
      const checkpointPath = path.join(root, 'checkpoint-master.key');
      const tunnelPath = path.join(root, 'lnwjud.runtime.secret');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x11));
      const runHelper = vi.fn(async () => CHECKPOINT_KEY);
      await writeFile(checkpointPath, 'dpapi:v2:must-not-read', 'utf8');
      await mkdir(path.join(root, 'remote-mcp'));
      const extraFiles = ['lnwjud.oauth.session.secret', 'remote-mcp/oauth-state.secret', 'remote-mcp/ngrok-authtoken.secret'];
      for (const filename of extraFiles) await writeFile(path.join(root, filename), LEGACY_TUNNEL_HEX, 'utf8');
      const mac = await migrateLegacyWindowsSecrets({ platform: 'darwin', checkpointPath, tunnelSecretPath: tunnelPath, secretProtector: protector, runHelper });
      const linux = await migrateLegacyWindowsSecrets({ platform: 'linux', checkpointPath, tunnelSecretPath: tunnelPath, secretProtector: protector, runHelper });
      expect(mac).toEqual({ checkpoint: 'not_windows', tunnel: 'not_windows' });
      expect(linux).toEqual({ checkpoint: 'not_windows', tunnel: 'not_windows' });
      expect(runHelper).not.toHaveBeenCalled();
      expect(await readFile(checkpointPath, 'utf8')).toBe('dpapi:v2:must-not-read');
      for (const filename of extraFiles) expect(await readFile(path.join(root, filename), 'utf8')).toBe(LEGACY_TUNNEL_HEX);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
