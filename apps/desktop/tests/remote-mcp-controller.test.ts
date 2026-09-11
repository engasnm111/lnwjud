import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExplicitKeySecretProtector } from '@lnwjud/shared';
import { buildNgrokHttpArgs, enforceStablePublicOrigin, extractNgrokDiagnostic, formatNgrokExitMessage, posixExecutableCandidates, RemoteMcpController, resolveNgrokExecutable, selectRecoverableStaleNgrokProcess, type RemoteMcpPersistedState } from '../src/main/remote-mcp-controller.js';

interface RemoteMcpTestAccess {
  gatewayUrl: string | null;
  publicOrigin: string | null;
  preferredPublicOrigin: string | null;
  runState: 'stopped' | 'installing' | 'starting' | 'running' | 'error';
  pairingCode: string | null;
  startGateway(localMcpUrl: string): Promise<void>;
  issuePairingCode(): void;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function completeChatGptLocalApproval(response: Response, publicOrigin: string, redirectUri: string, state: string): Promise<string> {
  expect(response.status).toBe(302);
  const localApproval = new URL(response.headers.get('location')!);
  expect(localApproval.protocol).toBe('http:');
  expect(localApproval.hostname).toBe('127.0.0.1');
  expect(localApproval.pathname).toMatch(/^\/oauth\/chatgpt-local-approve\/[A-Za-z0-9_-]+$/);
  expect(localApproval.searchParams.get('code')).toBeNull();

  const publicReplay = await fetch(`${publicOrigin}${localApproval.pathname}`, { redirect: 'manual' });
  expect(publicReplay.status).toBe(404);

  const approved = await fetch(localApproval, { redirect: 'manual' });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get('location')!);
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();

  const replay = await fetch(localApproval, { redirect: 'manual' });
  expect(replay.status).toBe(410);
  return code!;
}

describe('Remote MCP ngrok runtime', () => {
  it('starts without --url before a stable public origin has been learned', () => {
    const gateway = 'http://127.0.0.1:32123';
    expect(buildNgrokHttpArgs(gateway)).toEqual(['http', gateway, '--log=stdout', '--log-format=json']);
    expect(buildNgrokHttpArgs(gateway).some((value) => value.startsWith('--web-addr') || value === '--url')).toBe(false);
  });

  it('reuses a remembered ngrok public origin with the v3 --url flag', () => {
    const gateway = 'http://127.0.0.1:32123';
    expect(buildNgrokHttpArgs(gateway, 'https://steady.ngrok-free.app')).toEqual([
      'http', gateway, '--url', 'https://steady.ngrok-free.app', '--log=stdout', '--log-format=json',
    ]);
  });

  it('accepts the remembered ngrok origin but rejects silent public URL drift', () => {
    expect(enforceStablePublicOrigin('https://steady.ngrok-free.app/', null)).toBe('https://steady.ngrok-free.app');
    expect(enforceStablePublicOrigin('https://steady.ngrok-free.app', 'https://steady.ngrok-free.app')).toBe('https://steady.ngrok-free.app');
    expect(() => enforceStablePublicOrigin('https://changed.ngrok-free.app', 'https://steady.ngrok-free.app')).toThrow(/stopped instead of silently changing/i);
    expect(() => enforceStablePublicOrigin('http://steady.ngrok-free.app', null)).toThrow(/invalid public HTTPS origin/i);
  });

  it('parses POSIX PATH with POSIX semantics even when the test host is Windows', () => {
    expect(posixExecutableCandidates('ngrok', 'linux', { PATH: '/custom/bin:relative:/opt/tools' })).toEqual([
      '/custom/bin/ngrok',
      '/opt/tools/ngrok',
      '/usr/local/bin/ngrok',
      '/usr/bin/ngrok',
      '/snap/bin/ngrok',
    ]);
    expect(posixExecutableCandidates('brew', 'darwin', { PATH: '/custom/bin;/wrong/windows-style:/usr/local/bin' })).toEqual([
      '/custom/bin;/wrong/windows-style/brew',
      '/usr/local/bin/brew',
      '/opt/homebrew/bin/brew',
    ]);
  });

  it.each(['darwin', 'linux'] as const)('resolves a validated ngrok executable from the %s PATH without Windows tools on a POSIX host', async (platform) => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ngrok-path-'));
    try {
      const executable = path.join(root, 'ngrok');
      await writeFile(executable, 'fixture', 'utf8');
      await chmod(executable, 0o755).catch(() => undefined);
      const canonical = await realpath(executable);
      const runner = vi.fn(async (command: string, args: readonly string[]): Promise<string> => {
        expect(command).toBe(canonical);
        expect(args).toEqual(['version']);
        return 'ngrok version 3.30.0';
      });
      await expect(resolveNgrokExecutable(platform, { PATH: root }, runner)).resolves.toBe(canonical);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the actionable ngrok diagnostic instead of replacing it with exit 1', () => {
    const diagnostic = extractNgrokDiagnostic('ERROR:  unknown flag: --web-addr');
    expect(diagnostic).toBe('ERROR:  unknown flag: --web-addr');
    expect(formatNgrokExitMessage(1, diagnostic)).toBe('ngrok stopped unexpectedly (exit 1): ERROR:  unknown flag: --web-addr');
  });

  it('extracts JSON ngrok errors and redacts token-like values', () => {
    const diagnostic = extractNgrokDiagnostic(JSON.stringify({ lvl: 'eror', msg: 'authentication failed token=super-secret-value' }));
    expect(diagnostic).toContain('authentication failed');
    expect(diagnostic).not.toContain('super-secret-value');
  });

  it('prefers the actual ERR_NGROK failure over split ERROR markers and docs URLs', () => {
    const diagnostic = extractNgrokDiagnostic([
      'ERROR:',
      JSON.stringify({ lvl: 'eror', msg: 'session closing', err: "failed to start tunnel: The endpoint 'https://example.ngrok-free.dev' is already online. ERR_NGROK_334" }),
      'ERROR:  https://ngrok.com/docs/errors/err_ngrok_334',
    ].join('\n'));
    expect(diagnostic).toContain('failed to start tunnel');
    expect(diagnostic).toContain('ERR_NGROK_334');
    expect(diagnostic).not.toBe('ERROR:');
    expect(diagnostic).not.toContain('/docs/errors/');
  });

  it('recovers only one orphaned lnwjud-style ngrok process for the exact dead gateway target', () => {
    const target = 'http://127.0.0.1:54894';
    const orphan = { processId: 13164, parentProcessId: 14372, parentAlive: false, commandLine: `C:\\WindowsApps\\ngrok.exe http ${target} --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([orphan], target)).toEqual(orphan);
    expect(selectRecoverableStaleNgrokProcess([{ ...orphan, parentAlive: true }], target)).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([{ ...orphan, commandLine: `ngrok.exe http ${target}` }], target)).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([orphan], 'http://127.0.0.1:60000')).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([orphan, { ...orphan, processId: 13165 }], target)).toBeNull();
    const pinnedOrphan = { ...orphan, processId: 20100, commandLine: `ngrok.exe http ${target} --url https://steady.ngrok-free.app --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([pinnedOrphan], target)).toEqual(pinnedOrphan);
    const posixOrphan = { ...orphan, processId: 20101, commandLine: `/opt/homebrew/bin/ngrok http ${target} --url https://steady.ngrok-free.app --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([posixOrphan], target)).toEqual(posixOrphan);
  });
});

describe('Remote MCP OAuth gateway', () => {
  it('does not overwrite unreadable authorization and retries loading after secure storage recovers', async () => {
    const state: RemoteMcpPersistedState = {
      schemaVersion: 1, desiredRunning: true, publicOrigin: 'https://steady.ngrok-free.app',
      trustedClients: [{ clientId: 'saved-client', clientName: 'Saved client', redirectUris: ['https://example.com/callback'], tokenEndpointAuthMethod: 'none', clientSecret: null }],
      refreshGrants: [{ clientId: 'saved-client', refreshToken: 'r'.repeat(40), expiresAt: Date.parse('2099-01-01') }],
    };
    let locked = true;
    const load = vi.fn(async () => {
      if (locked) throw new Error('Secure storage is locked');
      return state;
    });
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: 'unused', getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void>; persistState(): Promise<void> };
    await internal.ensurePersistenceLoaded();
    await internal.persistState();
    expect(save).not.toHaveBeenCalled();
    locked = false;
    await Promise.all([internal.ensurePersistenceLoaded(), internal.ensurePersistenceLoaded()]);
    expect(internal.preferredPublicOrigin).toBe('https://steady.ngrok-free.app');
    await internal.persistState();
    expect(load).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(state);
  });

  it('keeps schema-1 state without a remembered public origin backward compatible', async () => {
    const load = vi.fn(async (): Promise<RemoteMcpPersistedState> => ({ schemaVersion: 1, desiredRunning: false, trustedClients: [], refreshGrants: [] }));
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: 'unused', getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void>; persistState(): Promise<void> };
    await internal.ensurePersistenceLoaded();
    expect(internal.preferredPublicOrigin).toBeNull();
    await internal.persistState();
    expect(save).toHaveBeenCalledWith({ schemaVersion: 1, desiredRunning: false, publicOrigin: null, trustedClients: [], refreshGrants: [] });
  });

  it('ignores an invalid remembered public origin from encrypted schema-1 state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-remote-mcp-invalid-origin-'));
    try {
      const secretProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x52));
      const directory = path.join(root, 'remote-mcp');
      await mkdir(directory, { recursive: true });
      const encrypted = await secretProtector.encrypt('tunnel_api_key', JSON.stringify({
        schemaVersion: 1,
        desiredRunning: false,
        publicOrigin: 'https://steady.ngrok-free.app/path?bad=1',
        trustedClients: [],
        refreshGrants: [],
      }));
      await writeFile(path.join(directory, 'oauth-state.secret'), encrypted, 'utf8');
      const controller = new RemoteMcpController({ dataPath: root, getLocalMcpUrl: async (): Promise<null> => null, secretProtector });
      const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void> };
      await internal.ensurePersistenceLoaded();
      expect(internal.preferredPublicOrigin).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a successfully learned public origin in Remote MCP state', async () => {
    const load = vi.fn(async (): Promise<RemoteMcpPersistedState> => ({ schemaVersion: 1, desiredRunning: false, trustedClients: [], refreshGrants: [] }));
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: 'unused', getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void>; persistState(): Promise<void> };
    await internal.ensurePersistenceLoaded();
    internal.preferredPublicOrigin = enforceStablePublicOrigin('https://steady.ngrok-free.app/', internal.preferredPublicOrigin);
    await internal.persistState();
    expect(save).toHaveBeenCalledWith({ schemaVersion: 1, desiredRunning: false, publicOrigin: 'https://steady.ngrok-free.app', trustedClients: [], refreshGrants: [] });
  });

  it('does not replace the ngrok authtoken when encrypted Remote MCP state cannot be loaded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-remote-mcp-token-load-failure-'));
    try {
      const save = vi.fn(async () => undefined);
      const controller = new RemoteMcpController({
        dataPath: root,
        getLocalMcpUrl: async (): Promise<null> => null,
        persistence: { load: async (): Promise<RemoteMcpPersistedState | null> => { throw new Error('Secure storage is locked'); }, save },
        secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 0x53)),
      });
      await expect(controller.saveAuthtoken('a'.repeat(24))).rejects.toThrow(/authtoken was not changed/i);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears the remembered public origin when the ngrok authtoken is saved again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-remote-mcp-origin-reset-'));
    try {
      const state: RemoteMcpPersistedState = { schemaVersion: 1, desiredRunning: false, publicOrigin: 'https://steady.ngrok-free.app', trustedClients: [], refreshGrants: [] };
      const load = vi.fn(async () => state);
      const save = vi.fn(async () => undefined);
      const controller = new RemoteMcpController({
        dataPath: root,
        getLocalMcpUrl: async (): Promise<null> => null,
        persistence: { load, save },
        secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 0x51)),
      });
      await controller.saveAuthtoken('a'.repeat(24));
      expect(save).toHaveBeenCalledWith({ schemaVersion: 1, desiredRunning: false, publicOrigin: null, trustedClients: [], refreshGrants: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps status reads side-effect-free and does not ensure-start Local MCP', async () => {
    let statusReads = 0;
    let ensureStarts = 0;
    const controller = new RemoteMcpController({
      dataPath: 'C:\\tmp\\lnwjud-remote-mcp-status-test',
      getLocalMcpUrl: async (): Promise<null> => {
        statusReads += 1;
        return null;
      },
      ensureLocalMcpUrl: async (): Promise<string> => {
        ensureStarts += 1;
        return 'http://127.0.0.1:32123/mcp';
      },
    });

    const status = await controller.status();

    expect(status.localMcpUrl).toBeNull();
    expect(statusReads).toBe(1);
    expect(ensureStarts).toBe(0);
  });

  it('requires OAuth, zero-click completes a recognized ChatGPT callback through local Desktop approval, and proxies authorized /mcp requests', async () => {
    let upstreamAuthorization: string | undefined;
    const upstreamOrigin = await listen(createServer((request, response) => {
      upstreamAuthorization = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, path: request.url }));
    }));
    const localMcpUrl = `${upstreamOrigin}/mcp`;
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjud-remote-mcp-test', getLocalMcpUrl: async (): Promise<string> => localMcpUrl });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway(localMcpUrl);
    expect(internal.gatewayUrl).not.toBeNull();
    internal.publicOrigin = internal.gatewayUrl;
    internal.runState = 'running';
    const origin = internal.gatewayUrl!;

    const unauthorized = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');

    const redirectUri = 'https://chatgpt.com/aip/oauth/callback';
    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };

    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', 'fixture-state');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const approvalRedirect = await fetch(authorize, { redirect: 'manual' });
    expect(internal.pairingCode).toBeNull();
    const code = await completeChatGptLocalApproval(approvalRedirect, origin, redirectUri, 'fixture-state');

    const trustedReauthorize = await fetch(authorize, { redirect: 'manual' });
    expect(trustedReauthorize.status).toBe(302);
    const trustedReauthorizeLocation = new URL(trustedReauthorize.headers.get('location')!);
    expect(trustedReauthorizeLocation.hostname).toBe('127.0.0.1');
    expect(trustedReauthorizeLocation.searchParams.get('code')).toBeNull();

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: registered.client_id,
        redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token.length).toBeGreaterThan(30);
    expect(tokens.refresh_token.length).toBeGreaterThan(30);

    const authorized = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ ok: true, path: '/mcp' });
    expect(upstreamAuthorization).toBeUndefined();

    await controller.close();
  });

  it('keeps the PIN fallback for clients that do not match the exact ChatGPT callback contract', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjud-remote-mcp-fallback-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway(`${upstreamOrigin}/mcp`);
    internal.publicOrigin = internal.gatewayUrl;
    internal.runState = 'running';
    expect(internal.pairingCode).toBeNull();
    const origin = internal.gatewayUrl!;
    const redirectUri = 'https://chatgpt.com.evil.example/aip/oauth/callback';

    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }),
    });
    const registered = await registration.json() as { client_id: string };
    const verifier = 'f'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', 'fallback-state');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    const consent = await fetch(authorize, { redirect: 'manual' });
    expect(consent.status).toBe(200);
    expect(internal.pairingCode).toMatch(/^\d{6}$/);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('Fallback PIN');
    expect(consentHtml).toContain('Fallback pairing');

    const approved = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code', client_id: registered.client_id, redirect_uri: redirectUri,
        state: 'fallback-state', code_challenge: challenge, code_challenge_method: 'S256',
        pairing_code: internal.pairingCode!,
      }),
    });
    expect(approved.status).toBe(302);
    expect(internal.pairingCode).toBeNull();
    await controller.close();
  });

  it('accepts ChatGPT-style DCR metadata with client_secret_post and validates the client secret at the token endpoint', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjud-remote-mcp-chatgpt-dcr-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway(`${upstreamOrigin}/mcp`);
    internal.publicOrigin = internal.gatewayUrl;
    const origin = internal.gatewayUrl!;
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as {
      client_id: string;
      client_secret: string;
      client_id_issued_at: number;
      client_secret_expires_at: number;
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(registered.client_id.length).toBeGreaterThan(20);
    expect(registered.client_secret.length).toBeGreaterThan(30);
    expect(registered.client_id_issued_at).toBeGreaterThan(0);
    expect(registered.client_secret_expires_at).toBe(0);
    expect(registered.token_endpoint_auth_method).toBe('client_secret_post');
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registered.response_types).toEqual(['code']);

    const verifier = 's'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const approvalRedirect = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code', client_id: registered.client_id, redirect_uri: redirectUri,
        state: 'chatgpt-fixture-state', code_challenge: challenge, code_challenge_method: 'S256',
      }),
    });
    const code = await completeChatGptLocalApproval(approvalRedirect, origin, redirectUri, 'chatgpt-fixture-state');

    const missingSecret = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, client_id: registered.client_id, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    expect(missingSecret.status).toBe(401);
    expect(await missingSecret.json()).toEqual({ error: 'invalid_client' });

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: registered.client_id, client_secret: registered.client_secret,
        redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token.length).toBeGreaterThan(30);
    expect(tokens.refresh_token.length).toBeGreaterThan(30);
    await controller.close();
  });

  it('returns an OAuth client-metadata error instead of HTTP 500 for malformed DCR JSON', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjud-remote-mcp-malformed-dcr-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway(`${upstreamOrigin}/mcp`);
    internal.publicOrigin = internal.gatewayUrl;
    const response = await fetch(`${internal.gatewayUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_client_metadata', error_description: 'Registration body must be a valid JSON object.' });
    await controller.close();
  });

  it('rejects insecure non-loopback OAuth redirect URIs', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjud-remote-mcp-test-2', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway(`${upstreamOrigin}/mcp`);
    internal.publicOrigin = internal.gatewayUrl;
    const response = await fetch(`${internal.gatewayUrl}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://attacker.example/callback'] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_redirect_uri' });
    await controller.close();
  });
});
