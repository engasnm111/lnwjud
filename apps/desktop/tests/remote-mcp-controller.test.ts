import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNgrokHttpArgs, extractNgrokDiagnostic, formatNgrokExitMessage, RemoteMcpController, selectRecoverableStaleNgrokProcess } from '../src/main/remote-mcp-controller.js';

interface RemoteMcpTestAccess {
  gatewayUrl: string | null;
  publicOrigin: string | null;
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

describe('Remote MCP ngrok runtime', () => {
  it('uses ngrok v3-compatible http arguments without the removed web-addr flag', () => {
    const args = buildNgrokHttpArgs('http://127.0.0.1:32123');
    expect(args).toEqual(['http', 'http://127.0.0.1:32123', '--log=stdout', '--log-format=json']);
    expect(args.some((value) => value.startsWith('--web-addr'))).toBe(false);
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
  });
});

describe('Remote MCP OAuth gateway', () => {
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

  it('requires OAuth, supports DCR + PKCE, and proxies authorized /mcp requests', async () => {
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
    internal.issuePairingCode();
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
    const consent = await fetch(authorize, { redirect: 'manual' });
    expect(consent.status).toBe(200);
    expect(consent.headers.get('content-security-policy')).toContain("form-action 'self' https://chatgpt.com");
    expect(consent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('pairing code');
    expect(consentHtml).toContain('lnwjud');
    expect(consentHtml).toContain('action="/oauth/authorize"');
    expect(consentHtml).toContain('Secure pairing');

    const approved = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code', client_id: registered.client_id, redirect_uri: redirectUri,
        state: 'fixture-state', code_challenge: challenge, code_challenge_method: 'S256',
        pairing_code: internal.pairingCode!,
      }),
    });
    expect(approved.status).toBe(302);
    expect(internal.pairingCode).toBeNull();
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

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
