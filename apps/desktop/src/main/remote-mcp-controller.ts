import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteMcpStatus } from '@lnwjud/ipc-contracts';
import { protectTunnelSecret, unprotectTunnelSecret } from './tunnel-secret-dpapi.js';

interface RegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string | null;
  readonly trusted: boolean;
}

export interface RemoteMcpPersistedState {
  readonly schemaVersion: 1;
  readonly desiredRunning: boolean;
  readonly trustedClients: ReadonlyArray<{
    readonly clientId: string;
    readonly redirectUris: readonly string[];
    readonly clientName: string | null;
  }>;
  readonly refreshGrants: ReadonlyArray<{
    readonly refreshToken: string;
    readonly clientId: string;
    readonly expiresAt: number;
  }>;
}

export interface RemoteMcpStatePersistence {
  load(): Promise<RemoteMcpPersistedState | null>;
  save(state: RemoteMcpPersistedState): Promise<void>;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

interface AccessGrant {
  readonly clientId: string;
  readonly expiresAt: number;
}

export interface NgrokProcessSnapshot {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly parentAlive: boolean;
  readonly commandLine: string;
}

interface NgrokTunnelSnapshot {
  readonly publicUrl: string;
  readonly target: string;
}

export interface RemoteMcpControllerOptions {
  readonly dataPath: string;
  readonly getLocalMcpUrl: () => Promise<string | null>;
  readonly ensureLocalMcpUrl?: () => Promise<string | null>;
  readonly now?: () => number;
  readonly persistence?: RemoteMcpStatePersistence;
}

const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const PAIRING_TTL_MS = 15 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 8 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

export class RemoteMcpController {
  private readonly dataPath: string;
  private readonly getLocalMcpUrl: () => Promise<string | null>;
  private readonly ensureLocalMcpUrl: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly persistence: RemoteMcpStatePersistence;
  private persistenceLoaded = false;
  private desiredRunning = false;
  private gateway: Server | null = null;
  private gatewayUrl: string | null = null;
  private publicOrigin: string | null = null;
  private ngrok: ChildProcess | null = null;
  private ngrokPath: string | null = null;
  private ngrokProbeAt = 0;
  private runState: RemoteMcpStatus['state'] = 'stopped';
  private message: string | null = null;
  private pairingCode: string | null = null;
  private pairingExpiresAt = 0;
  private pairingFailures = 0;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly authCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessGrant>();
  private readonly refreshTokens = new Map<string, AccessGrant>();

  public constructor(options: RemoteMcpControllerOptions) {
    this.dataPath = options.dataPath;
    this.getLocalMcpUrl = options.getLocalMcpUrl;
    this.ensureLocalMcpUrl = options.ensureLocalMcpUrl ?? options.getLocalMcpUrl;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence ?? createRemoteMcpStatePersistence(options.dataPath);
  }

  public async status(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    const localMcpUrl = await this.getLocalMcpUrl().catch(() => null);
    const probeNow = this.now();
    if (this.ngrokProbeAt === 0 || probeNow - this.ngrokProbeAt >= 30_000) {
      this.ngrokPath = await resolveNgrokExecutable();
      this.ngrokProbeAt = probeNow;
    }
    const executable = this.ngrokPath;
    const hasAuthtoken = existsSync(this.secretPath());
    if (this.pairingCode !== null && this.now() >= this.pairingExpiresAt) {
      this.pairingCode = null;
      this.pairingExpiresAt = 0;
    }
    return {
      state: this.runState,
      provider: 'ngrok',
      installed: executable !== null,
      hasAuthtoken,
      ngrokPath: executable,
      localMcpUrl,
      localGatewayUrl: this.gatewayUrl,
      publicMcpUrl: this.publicOrigin === null ? null : `${this.publicOrigin}/mcp`,
      pairingCode: this.runState === 'running' ? this.pairingCode : null,
      pairingCodeExpiresAt: this.runState === 'running' && this.pairingExpiresAt > 0 ? new Date(this.pairingExpiresAt).toISOString() : null,
      oauthProtected: true,
      oauthConnected: this.hasTrustedClient(),
      pairingRequired: this.runState === 'running' && !this.hasTrustedClient(),
      autoStartEnabled: this.desiredRunning,
      message: this.message,
    };
  }

  public async installProvider(): Promise<RemoteMcpStatus> {
    const existing = await resolveNgrokExecutable();
    if (existing !== null) {
      this.ngrokPath = existing;
      this.message = 'ngrok is already installed';
      return this.status();
    }
    if (process.platform !== 'win32') throw new Error('Automatic ngrok installation is currently available on Windows only');
    this.runState = 'installing';
    this.message = 'Installing ngrok from Microsoft Store via WinGet…';
    try {
      await runCommand('winget.exe', ['install', 'ngrok', '-s', 'msstore', '--accept-package-agreements', '--accept-source-agreements', '--silent'], 180_000);
      const installed = await resolveNgrokExecutable();
      if (installed === null) throw new Error('ngrok installation completed but ngrok.exe could not be resolved. Sign out/in or restart Windows if App Execution Aliases were just installed.');
      this.ngrokPath = installed;
      this.runState = 'stopped';
      this.message = 'ngrok installed from the official Microsoft Store package';
      return this.status();
    } catch (error) {
      this.runState = 'error';
      this.message = errorMessage(error);
      throw error;
    }
  }

  public async saveAuthtoken(raw: string): Promise<RemoteMcpStatus> {
    const token = raw.trim();
    if (token.length < 16 || /\s/.test(token)) throw new Error('Enter a valid ngrok authtoken');
    await mkdir(this.secretDir(), { recursive: true });
    const encrypted = await protectTunnelSecret(token);
    await writeFile(this.secretPath(), encrypted, { encoding: 'utf8', mode: 0o600 });
    this.message = 'ngrok authtoken saved securely with Windows DPAPI';
    return this.status();
  }

  public async regeneratePairingCode(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    for (const [clientId, client] of this.clients) this.clients.set(clientId, { ...client, trusted: false });
    this.authCodes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.issuePairingCode();
    await this.persistState();
    this.message = 'ChatGPT authorization was reset. Pair once to trust this connection again.';
    return this.status();
  }

  public async autoStartIfDesired(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (!this.desiredRunning || !this.hasTrustedClient()) return this.status();
    return this.start();
  }

  public async start(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (this.runState === 'running') return this.status();
    this.runState = 'starting';
    this.message = 'Starting protected Remote MCP…';
    try {
      const localMcpUrl = await this.ensureLocalMcpUrl();
      if (localMcpUrl === null) throw new Error('Local MCP is unavailable. Start the lnwjud MCP listener first.');
      let executable = this.ngrokPath ?? await resolveNgrokExecutable();
      if (executable === null) {
        await this.installProvider();
        executable = this.ngrokPath ?? await resolveNgrokExecutable();
        this.runState = 'starting';
      }
      if (executable === null) throw new Error('ngrok installation/repair completed but no runnable ngrok executable was found');
      this.ngrokPath = executable;
      const authtoken = await this.loadAuthtoken();
      if (authtoken === null) throw new Error('ngrok authtoken is not configured');
      const recoveredStaleNgrok = await recoverStaleLnwjudNgrokRuntime();
      if (recoveredStaleNgrok) this.message = 'Recovered a stale lnwjud ngrok runtime from a previous Desktop session';
      await this.startGateway(localMcpUrl);
      if (this.gatewayUrl === null) throw new Error('Remote MCP gateway did not start');
      if (this.hasTrustedClient()) {
        this.pairingCode = null;
        this.pairingExpiresAt = 0;
      } else {
        this.issuePairingCode();
      }
      this.publicOrigin = null;
      let lastNgrokDiagnostic: string | null = null;
      let ngrokDiagnosticBuffer = '';
      const child = spawn(executable, buildNgrokHttpArgs(this.gatewayUrl), {
        env: { ...process.env, NGROK_AUTHTOKEN: authtoken },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.ngrok = child;
      const captureDiagnostic = (chunk: Buffer | string): void => {
        ngrokDiagnosticBuffer = `${ngrokDiagnosticBuffer}${String(chunk)}`.slice(-64 * 1024);
        const diagnostic = extractNgrokDiagnostic(ngrokDiagnosticBuffer);
        if (diagnostic !== null) {
          lastNgrokDiagnostic = diagnostic;
          this.message = diagnostic;
        }
      };
      child.stdout?.on('data', captureDiagnostic);
      child.stderr?.on('data', captureDiagnostic);
      const exitPromise = new Promise<string>((resolve) => {
        let settled = false;
        const fail = (message: string): void => {
          if (settled) return;
          settled = true;
          if (this.runState !== 'stopped') {
            this.runState = 'error';
            this.message = message;
          }
          this.publicOrigin = null;
          if (this.ngrok === child) this.ngrok = null;
          resolve(message);
        };
        child.once('error', (error) => { fail(`ngrok failed to start: ${redactNgrokError(errorMessage(error))}`); });
        child.once('exit', (code) => { fail(formatNgrokExitMessage(code, lastNgrokDiagnostic)); });
      });
      const outcome = await Promise.race([
        waitForNgrokPublicOrigin(15_000, this.gatewayUrl).then((origin) => ({ kind: 'origin' as const, origin })),
        exitPromise.then((message) => ({ kind: 'exit' as const, message })),
      ]);
      if (outcome.kind === 'exit') throw new Error(outcome.message);
      if (outcome.origin === null) throw new Error(this.message ?? 'ngrok started but no public HTTPS endpoint was reported');
      const origin = outcome.origin;
      this.publicOrigin = origin;
      this.runState = 'running';
      this.desiredRunning = true;
      await this.persistState();
      this.message = this.hasTrustedClient()
        ? 'Remote MCP is online. ChatGPT authorization is trusted and will reconnect automatically.'
        : 'Remote MCP is online. Pair ChatGPT once to trust this connection.';
      return this.status();
    } catch (error) {
      await this.stopOwnedRuntime();
      this.runState = 'error';
      this.message = errorMessage(error);
      throw error;
    }
  }

  public async stop(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    this.runState = 'stopped';
    this.desiredRunning = false;
    this.message = 'Remote MCP stopped. Automatic start is disabled until you start it again.';
    await this.stopOwnedRuntime();
    await this.persistState();
    return this.status();
  }

  public async close(): Promise<void> {
    this.runState = 'stopped';
    await this.stopOwnedRuntime();
  }

  private async startGateway(localMcpUrl: string): Promise<void> {
    if (this.gateway !== null) return;
    const server = createServer((request, response) => {
      void this.handleGatewayRequest(request, response, localMcpUrl).catch((error: unknown) => {
        if (!response.headersSent) json(response, 500, { error: 'server_error', error_description: errorMessage(error) });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Remote MCP gateway could not resolve its loopback port');
    }
    this.gateway = server;
    this.gatewayUrl = `http://127.0.0.1:${address.port}`;
  }

  private async handleGatewayRequest(request: IncomingMessage, response: ServerResponse, localMcpUrl: string): Promise<void> {
    const url = new URL(request.url ?? '/', this.publicOrigin ?? this.gatewayUrl ?? 'http://127.0.0.1');
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
      const origin = this.requirePublicOrigin();
      json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = this.requirePublicOrigin();
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      const body = await readJson(request, 64 * 1024);
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((entry): entry is string => typeof entry === 'string' && isSafeRedirectUri(entry)) : [];
      if (redirectUris.length === 0) { json(response, 400, { error: 'invalid_redirect_uri' }); return; }
      const clientId = token(24);
      this.clients.set(clientId, { clientId, redirectUris, clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : null, trusted: false });
      json(response, 201, { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' });
      return;
    }
    if (url.pathname === '/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) {
      const params = request.method === 'POST' ? new URLSearchParams(await readText(request, 32 * 1024)) : url.searchParams;
      await this.handleAuthorize(params, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      await this.handleToken(new URLSearchParams(await readText(request, 32 * 1024)), response);
      return;
    }
    if (url.pathname === '/mcp') {
      const bearer = parseBearer(request.headers.authorization);
      if (bearer === null || !this.validAccessToken(bearer)) {
        const origin = this.requirePublicOrigin();
        response.statusCode = 401;
        response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        response.end('Unauthorized');
        return;
      }
      await proxyMcp(request, response, localMcpUrl);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      html(response, 200, '<h1>lnwjud Remote MCP</h1><p>OAuth-protected MCP endpoint is online.</p>');
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  }

  private async handleAuthorize(params: URLSearchParams, response: ServerResponse): Promise<void> {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? '';
    const challenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method') ?? '';
    const client = this.clients.get(clientId);
    if (params.get('response_type') !== 'code' || client === undefined || !client.redirectUris.includes(redirectUri) || challenge.length < 32 || method !== 'S256') {
      json(response, 400, { error: 'invalid_request' });
      return;
    }
    if (!client.trusted) {
      const submitted = params.get('pairing_code');
      if (submitted === null) {
        html(
          response,
          200,
          authorizePairingPage({
            clientName: client.clientName ?? 'ChatGPT',
            clientId,
            redirectUri,
            state,
            challenge,
          }),
          [new URL(redirectUri).origin],
        );
        return;
      }
      if (!this.verifyPairingCode(submitted)) {
        html(response, 403, pairingErrorPage());
        return;
      }
      this.clients.set(clientId, { ...client, trusted: true });
      this.pairingCode = null;
      this.pairingExpiresAt = 0;
      this.message = 'ChatGPT authorized. This OAuth connection is remembered for future starts.';
      await this.persistState();
    }
    const code = token(32);
    this.authCodes.set(code, { clientId, redirectUri, codeChallenge: challenge, expiresAt: this.now() + CODE_TTL_MS });
    const destination = new URL(redirectUri);
    destination.searchParams.set('code', code);
    if (state.length > 0) destination.searchParams.set('state', state);
    response.statusCode = 302;
    response.setHeader('Location', destination.toString());
    response.end();
  }

  private async handleToken(params: URLSearchParams, response: ServerResponse): Promise<void> {
    const grantType = params.get('grant_type');
    const clientId = params.get('client_id') ?? '';
    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const grant = this.authCodes.get(code);
      this.authCodes.delete(code);
      const verifier = params.get('code_verifier') ?? '';
      if (grant === undefined || grant.expiresAt <= this.now() || grant.clientId !== clientId || grant.redirectUri !== (params.get('redirect_uri') ?? '') || !verifyPkce(verifier, grant.codeChallenge)) {
        json(response, 400, { error: 'invalid_grant' }); return;
      }
      await this.issueTokens(clientId, response);
      return;
    }
    if (grantType === 'refresh_token') {
      const refresh = params.get('refresh_token') ?? '';
      const grant = this.refreshTokens.get(refresh);
      if (grant === undefined || grant.expiresAt <= this.now() || grant.clientId !== clientId) {
        json(response, 400, { error: 'invalid_grant' }); return;
      }
      this.refreshTokens.delete(refresh);
      await this.issueTokens(clientId, response);
      return;
    }
    json(response, 400, { error: 'unsupported_grant_type' });
  }

  private async issueTokens(clientId: string, response: ServerResponse): Promise<void> {
    const access = token(32);
    const refresh = token(32);
    this.accessTokens.set(access, { clientId, expiresAt: this.now() + ACCESS_TTL_MS });
    this.refreshTokens.set(refresh, { clientId, expiresAt: this.now() + REFRESH_TTL_MS });
    await this.persistState();
    json(response, 200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh });
  }

  private validAccessToken(value: string): boolean {
    const grant = this.accessTokens.get(value);
    if (grant === undefined) return false;
    if (grant.expiresAt <= this.now()) { this.accessTokens.delete(value); return false; }
    return true;
  }

  private issuePairingCode(): void {
    this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS;
    this.pairingFailures = 0;
  }

  private verifyPairingCode(value: string): boolean {
    if (this.pairingCode === null || this.now() >= this.pairingExpiresAt || !/^\d{6}$/.test(value)) return false;
    const accepted = timingSafeEqual(Buffer.from(value), Buffer.from(this.pairingCode));
    if (accepted) return true;
    this.pairingFailures += 1;
    if (this.pairingFailures >= 5) {
      this.pairingCode = null;
      this.pairingExpiresAt = 0;
    }
    return false;
  }

  private requirePublicOrigin(): string {
    if (this.publicOrigin === null) throw new Error('Remote MCP public URL is not ready');
    return this.publicOrigin;
  }

  private hasTrustedClient(): boolean {
    for (const client of this.clients.values()) if (client.trusted) return true;
    return false;
  }

  private async ensurePersistenceLoaded(): Promise<void> {
    if (this.persistenceLoaded) return;
    this.persistenceLoaded = true;
    let state: RemoteMcpPersistedState | null = null;
    try {
      state = await this.persistence.load();
    } catch (error) {
      this.message = `Saved Remote MCP authorization could not be loaded: ${errorMessage(error)}`;
    }
    if (state === null) return;
    this.desiredRunning = state.desiredRunning;
    for (const client of state.trustedClients.slice(0, 32)) {
      this.clients.set(client.clientId, { ...client, trusted: true });
    }
    const trustedClientIds = new Set([...this.clients.values()].filter((client) => client.trusted).map((client) => client.clientId));
    for (const grant of state.refreshGrants.slice(0, 64)) {
      if (grant.expiresAt > this.now() && trustedClientIds.has(grant.clientId)) {
        this.refreshTokens.set(grant.refreshToken, { clientId: grant.clientId, expiresAt: grant.expiresAt });
      }
    }
  }

  private async persistState(): Promise<void> {
    if (!this.persistenceLoaded) return;
    const now = this.now();
    const trustedClients = [...this.clients.values()]
      .filter((client) => client.trusted)
      .slice(0, 32)
      .map(({ clientId, redirectUris, clientName }) => ({ clientId, redirectUris: [...redirectUris], clientName }));
    const trustedClientIds = new Set(trustedClients.map((client) => client.clientId));
    const refreshGrants = [...this.refreshTokens.entries()]
      .filter(([, grant]) => grant.expiresAt > now && trustedClientIds.has(grant.clientId))
      .slice(-64)
      .map(([refreshToken, grant]) => ({ refreshToken, clientId: grant.clientId, expiresAt: grant.expiresAt }));
    await this.persistence.save({ schemaVersion: 1, desiredRunning: this.desiredRunning, trustedClients, refreshGrants });
  }

  private secretDir(): string { return path.join(this.dataPath, 'remote-mcp'); }
  private secretPath(): string { return path.join(this.secretDir(), 'ngrok-authtoken.secret'); }
  private async hasAuthtoken(): Promise<boolean> { return (await this.loadAuthtoken().catch(() => null)) !== null; }
  private async loadAuthtoken(): Promise<string | null> {
    try {
      const encrypted = await readFile(this.secretPath(), 'utf8');
      const value = (await unprotectTunnelSecret(encrypted)).trim();
      return value.length > 0 ? value : null;
    } catch { return null; }
  }

  private async stopOwnedRuntime(): Promise<void> {
    const child = this.ngrok;
    this.ngrok = null;
    this.publicOrigin = null;
    this.pairingCode = null;
    this.pairingExpiresAt = 0;
    if (child !== null && child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    const server = this.gateway;
    this.gateway = null;
    this.gatewayUrl = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.authCodes.clear();
    this.accessTokens.clear();
  }
}

function createRemoteMcpStatePersistence(dataPath: string): RemoteMcpStatePersistence {
  const directory = path.join(dataPath, 'remote-mcp');
  const filename = path.join(directory, 'oauth-state.secret');
  return {
    load: async (): Promise<RemoteMcpPersistedState | null> => {
      let encrypted: string;
      try {
        encrypted = await readFile(filename, 'utf8');
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
      const plainText = await unprotectTunnelSecret(encrypted);
      return normalizePersistedState(JSON.parse(plainText) as unknown);
    },
    save: async (state: RemoteMcpPersistedState): Promise<void> => {
      await mkdir(directory, { recursive: true });
      const encrypted = await protectTunnelSecret(JSON.stringify(state));
      await writeFile(filename, encrypted, { encoding: 'utf8', mode: 0o600 });
    },
  };
}

function normalizePersistedState(value: unknown): RemoteMcpPersistedState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.desiredRunning !== 'boolean') return null;
  const clients = Array.isArray(record.trustedClients) ? record.trustedClients : [];
  const trustedClients = clients.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const client = entry as Record<string, unknown>;
    if (typeof client.clientId !== 'string' || client.clientId.length === 0 || client.clientId.length > 256) return [];
    const redirectUris = Array.isArray(client.redirectUris)
      ? client.redirectUris.filter((uri): uri is string => typeof uri === 'string' && isSafeRedirectUri(uri)).slice(0, 16)
      : [];
    if (redirectUris.length === 0) return [];
    const clientName = typeof client.clientName === 'string' ? client.clientName.slice(0, 120) : null;
    return [{ clientId: client.clientId, redirectUris, clientName }];
  }).slice(0, 32);
  const trustedClientIds = new Set(trustedClients.map((client) => client.clientId));
  const grants = Array.isArray(record.refreshGrants) ? record.refreshGrants : [];
  const refreshGrants = grants.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const grant = entry as Record<string, unknown>;
    if (typeof grant.refreshToken !== 'string' || grant.refreshToken.length < 32 || grant.refreshToken.length > 256) return [];
    if (typeof grant.clientId !== 'string' || !trustedClientIds.has(grant.clientId)) return [];
    if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) return [];
    return [{ refreshToken: grant.refreshToken, clientId: grant.clientId, expiresAt: grant.expiresAt }];
  }).slice(-64);
  return { schemaVersion: 1, desiredRunning: record.desiredRunning, trustedClients, refreshGrants };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';
}

export function buildNgrokHttpArgs(gatewayUrl: string): string[] {
  return ['http', gatewayUrl, '--log=stdout', '--log-format=json'];
}

export async function resolveNgrokExecutable(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  let output: string;
  try {
    output = await runCommand('where.exe', ['ngrok.exe'], 5_000);
  } catch { return null; }
  const candidates = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
  for (const candidate of candidates) {
    try {
      const version = await runCommand(candidate, ['version'], 5_000);
      if (/\bngrok\s+version\b/i.test(version)) return candidate;
    } catch { /* Ignore stale App Execution Aliases and try the next candidate. */ }
  }
  return null;
}

export function selectRecoverableStaleNgrokProcess(processes: readonly NgrokProcessSnapshot[], target: string): NgrokProcessSnapshot | null {
  const normalizedTarget = target.trim().toLowerCase();
  const matches = processes.filter((entry) => {
    if (entry.parentAlive || entry.processId <= 0) return false;
    const commandLine = entry.commandLine.trim().toLowerCase().replace(/\s+/g, ' ');
    return commandLine.includes('ngrok.exe')
      && commandLine.includes(` http ${normalizedTarget} `)
      && commandLine.includes('--log=stdout')
      && commandLine.includes('--log-format=json');
  });
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function recoverStaleLnwjudNgrokRuntime(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const tunnels = await readNgrokTunnelSnapshots();
  if (tunnels.length === 0) return false;
  const processes = await readNgrokProcessSnapshots();
  for (const tunnel of tunnels) {
    if (!isLoopbackHttpTarget(tunnel.target)) continue;
    if (await isHttpTargetReachable(tunnel.target)) continue;
    const stale = selectRecoverableStaleNgrokProcess(processes, tunnel.target);
    if (stale === null) continue;
    try { process.kill(stale.processId); } catch { continue; }
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline && isProcessAlive(stale.processId)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessAlive(stale.processId)) return true;
  }
  return false;
}

async function readNgrokTunnelSnapshots(): Promise<NgrokTunnelSnapshot[]> {
  try {
    const response = await fetch(NGROK_API, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return [];
    const body = await response.json() as { tunnels?: Array<{ public_url?: unknown; config?: { addr?: unknown } }> };
    return (body.tunnels ?? []).flatMap((entry) => {
      const publicUrl = typeof entry.public_url === 'string' ? entry.public_url : null;
      const target = typeof entry.config?.addr === 'string' ? entry.config.addr : null;
      return publicUrl !== null && publicUrl.startsWith('https://') && target !== null ? [{ publicUrl, target }] : [];
    });
  } catch { return []; }
}

async function readNgrokProcessSnapshots(): Promise<NgrokProcessSnapshot[]> {
  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '$items = @(Get-CimInstance Win32_Process -Filter "Name=\'ngrok.exe\'" | ForEach-Object { [pscustomobject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; ParentAlive=[bool](Get-Process -Id ([int]$_.ParentProcessId) -ErrorAction SilentlyContinue); CommandLine=[string]$_.CommandLine } }); ConvertTo-Json -Compress -InputObject $items';
  try {
    const output = await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], 5_000);
    if (output.trim().length === 0) return [];
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((entry): NgrokProcessSnapshot[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const processId = Number(record.ProcessId);
      const parentProcessId = Number(record.ParentProcessId);
      if (!Number.isInteger(processId) || !Number.isInteger(parentProcessId)) return [];
      return [{
        processId,
        parentProcessId,
        parentAlive: record.ParentAlive === true,
        commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
      }];
    });
  } catch { return []; }
}

function isLoopbackHttpTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port.length > 0;
  } catch { return false; }
}

async function isHttpTargetReachable(value: string): Promise<boolean> {
  try {
    await fetch(value, { redirect: 'manual', signal: AbortSignal.timeout(900) });
    return true;
  } catch { return false; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForNgrokPublicOrigin(timeoutMs: number, expectedTarget: string): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(NGROK_API, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const body = await response.json() as { tunnels?: Array<{ public_url?: unknown; forwards_to?: unknown; config?: { addr?: unknown } }> };
        const httpsTunnels = (body.tunnels ?? []).filter((entry): entry is { public_url: string; forwards_to?: unknown; config?: { addr?: unknown } } => typeof entry.public_url === 'string' && entry.public_url.startsWith('https://'));
        const exact = httpsTunnels.find((entry) => entry.forwards_to === expectedTarget || entry.config?.addr === expectedTarget);
        const selected = exact ?? (httpsTunnels.length === 1 ? httpsTunnels[0] : undefined);
        if (selected !== undefined) return selected.public_url.replace(/\/$/, '');
      }
    } catch { /* retry while ngrok boots */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function proxyMcp(request: IncomingMessage, response: ServerResponse, target: string): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'authorization', 'origin', 'content-length', 'connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else headers.set(name, value);
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBuffer(request, 4 * 1024 * 1024);
  const upstreamBody = body === undefined ? undefined : new Uint8Array(body);
  const upstream = await fetch(target, { method: request.method ?? 'GET', headers, ...(upstreamBody === undefined ? {} : { body: upstreamBody }) });
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  if (upstream.body === null) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await new Promise<void>((resolve) => response.once('drain', resolve));
    }
  } finally { reader.releaseLock(); }
  response.end();
}

async function readJson(request: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const text = await readText(request, max);
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

async function readText(request: IncomingMessage, max: number): Promise<string> { return (await readBuffer(request, max)).toString('utf8'); }
async function readBuffer(request: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > max) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}
function html(response: ServerResponse, status: number, body: string, formActionOrigins: readonly string[] = []): void {
  const formActions = ["'self'", ...formActionOrigins.map((origin) => new URL(origin).origin)].join(' ');
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActions}; base-uri 'none'; frame-ancestors 'none'`);
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

function authorizePairingPage(input: { readonly clientName: string; readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly challenge: string }): string {
  const escaped = escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Authorize ${escaped(input.clientName)} · lnwjud</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f6f7fb;background:#070a10}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;background:radial-gradient(circle at 50% -10%,rgba(220,180,72,.14),transparent 34%),linear-gradient(180deg,#080b12 0%,#05070b 100%);color:#f6f7fb}
    .shell{width:min(100%,560px)}.brand{display:flex;align-items:center;justify-content:space-between;margin:0 0 14px;padding:0 4px;color:#d8ae42;font-weight:800;letter-spacing:.02em}.version{font-size:12px;color:#8b95a7;font-weight:650}
    .card{border:1px solid rgba(219,181,78,.22);border-radius:22px;background:linear-gradient(180deg,rgba(19,24,34,.97),rgba(10,14,21,.98));box-shadow:0 24px 70px rgba(0,0,0,.48),inset 0 1px rgba(255,255,255,.035);overflow:hidden}
    .accent{height:3px;background:linear-gradient(90deg,#8b681d,#edc55e,#8b681d)}.content{padding:30px}.eyebrow{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(87,204,135,.25);border-radius:999px;padding:6px 10px;background:rgba(54,163,101,.08);color:#75dda0;font-size:12px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.dot{width:7px;height:7px;border-radius:50%;background:#61d993;box-shadow:0 0 14px rgba(97,217,147,.55)}
    h1{font-size:30px;line-height:1.1;margin:18px 0 10px;letter-spacing:-.035em}p{margin:0;color:#aeb7c7;line-height:1.65}.client{color:#f8d873}.steps{margin:24px 0 20px;padding:15px 16px;border:1px solid #232b39;border-radius:14px;background:#0a0e15;color:#9fa9ba;font-size:13px;line-height:1.6}.steps strong{color:#d8dee8}
    label{display:block;margin:0 0 9px;color:#dce2ec;font-size:13px;font-weight:700}.code{width:100%;height:66px;border:1px solid #30394a;border-radius:14px;background:#070a0f;color:#f4d06a;outline:none;padding:0 18px;font:800 28px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.34em;text-align:center;transition:border-color .15s,box-shadow .15s}.code:focus{border-color:#d6ad43;box-shadow:0 0 0 4px rgba(214,173,67,.1)}
    button{width:100%;height:50px;margin-top:14px;border:1px solid #d9b54f;border-radius:13px;background:linear-gradient(180deg,#e7c35e,#bc8e29);color:#171109;font:800 15px/1 inherit;cursor:pointer;box-shadow:0 8px 22px rgba(187,140,35,.2)}button:hover{filter:brightness(1.06)}button:active{transform:translateY(1px)}
    .security{display:flex;gap:10px;margin-top:18px;padding-top:18px;border-top:1px solid #202735;color:#7f8a9c;font-size:12px;line-height:1.55}.shield{color:#6bdc99;font-size:15px}.foot{margin-top:12px;text-align:center;color:#5f6978;font-size:11px}
    @media (max-width:520px){body{padding:16px}.content{padding:23px 20px}h1{font-size:26px}.code{font-size:24px;letter-spacing:.26em}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="brand"><span>◈ lnwjud</span><span class="version">REMOTE MCP · OAUTH</span></div>
    <section class="card" aria-labelledby="authorize-title">
      <div class="accent"></div>
      <div class="content">
        <div class="eyebrow"><span class="dot"></span> Secure pairing</div>
        <h1 id="authorize-title">Authorize <span class="client">${escaped(input.clientName)}</span></h1>
        <p>Enter the 6-digit pairing code shown in lnwjud Desktop to approve this Remote MCP connection.</p>
        <div class="steps"><strong>Where to find it:</strong> lnwjud Desktop → Settings → Remote MCP &amp; Tunnel → OAuth Pairing Code. The code expires automatically.</div>
        <form method="post" action="/oauth/authorize">
          <input type="hidden" name="response_type" value="code">
          <input type="hidden" name="client_id" value="${escaped(input.clientId)}">
          <input type="hidden" name="redirect_uri" value="${escaped(input.redirectUri)}">
          <input type="hidden" name="state" value="${escaped(input.state)}">
          <input type="hidden" name="code_challenge" value="${escaped(input.challenge)}">
          <input type="hidden" name="code_challenge_method" value="S256">
          <label for="pairing-code">Pairing code</label>
          <input id="pairing-code" class="code" autofocus autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" name="pairing_code" required aria-describedby="pairing-help">
          <button type="submit">Authorize ChatGPT</button>
        </form>
        <div id="pairing-help" class="security"><span class="shield">◆</span><span>The pairing code is verified locally by lnwjud. A discovered ngrok URL alone is not enough to authorize a client.</span></div>
      </div>
    </section>
    <div class="foot">lnwjud Remote MCP · OAuth 2.0 + PKCE</div>
  </main>
</body>
</html>`;
}

function pairingErrorPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Pairing code rejected · lnwjud</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef1f6;background:#070a10}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#070a10}.card{width:min(100%,520px);padding:30px;border:1px solid rgba(221,80,80,.3);border-radius:20px;background:#10151e;box-shadow:0 24px 70px rgba(0,0,0,.45)}.mark{color:#ff7d7d;font-size:28px}h1{margin:12px 0 8px;font-size:28px}p{margin:0;color:#aeb7c7;line-height:1.65}.hint{margin-top:18px;padding:13px 14px;border-radius:12px;background:#0a0e15;border:1px solid #242d3a;color:#d5b861;font-size:13px}</style></head><body><main class="card"><div class="mark">◇</div><h1>Pairing code rejected</h1><p>The code is invalid or expired. Generate a new OAuth Pairing Code in lnwjud Desktop and start the authorization again.</p><div class="hint">Settings → Remote MCP &amp; Tunnel → สร้าง Pairing Code ใหม่</div></main></body></html>`;
}

function token(bytes: number): string { return randomBytes(bytes).toString('base64url'); }
function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return actual.length === challenge.length && timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}
function parseBearer(value: string | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value ?? '');
  return match?.[1] ?? null;
}
function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === 'http:');
  } catch { return false; }
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redactNgrokError(value: string): string { return value.replace(/(authtoken|token)[=:"'\s]+[^\s,"']+/gi, '$1=[redacted]').slice(0, 500); }

export function extractNgrokDiagnostic(value: string): string | null {
  const redacted = redactNgrokError(value.trim());
  if (redacted.length === 0) return null;
  const lines = redacted.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let bestScore = -1;
  let bestMessage: string | null = null;
  const consider = (raw: string, level = ''): void => {
    const message = redactNgrokError(raw.trim());
    if (message.length === 0 || /^ERROR:\s*$/i.test(message) || /^https?:\/\/ngrok\.com\/docs\/errors\//i.test(message)) return;
    let score = 0;
    if (/ERR_NGROK_\d+/i.test(message)) score += 100;
    if (/failed to start tunnel/i.test(message)) score += 80;
    if (/authentication|authtoken|unknown flag|failed|fatal/i.test(message)) score += 50;
    if (/^ERROR:/i.test(message)) score += 20;
    if (['error', 'eror', 'crit', 'fatal'].includes(level)) score += 10;
    if (score <= 0) return;
    if (score > bestScore || (score === bestScore && message.length > (bestMessage?.length ?? 0))) {
      bestScore = score;
      bestMessage = message;
    }
  };
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const level = typeof parsed.lvl === 'string' ? parsed.lvl.toLowerCase() : typeof parsed.level === 'string' ? parsed.level.toLowerCase() : '';
      for (const candidate of [parsed.err, parsed.message, parsed.msg]) {
        if (typeof candidate === 'string') consider(candidate, level);
      }
    } catch { consider(line); }
  }
  return bestMessage;
}

export function formatNgrokExitMessage(code: number | null, diagnostic: string | null): string {
  const prefix = `ngrok stopped unexpectedly (exit ${code ?? 'unknown'})`;
  return diagnostic === null ? prefix : `${prefix}: ${diagnostic}`;
}

function runCommand(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${executable} exited with code ${code ?? 'unknown'}`));
    });
  });
}
