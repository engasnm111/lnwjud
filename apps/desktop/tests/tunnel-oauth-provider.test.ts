import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthTunnelAuthProvider, type TunnelOAuthProvisioningBackend } from '../src/main/tunnel-oauth-provider.js';
import { TunnelOAuthSessionStore } from '../src/main/tunnel-oauth-store.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(overrides: Partial<TunnelOAuthProvisioningBackend['descriptor']> = {}): Promise<{ readonly filePath: string; readonly store: TunnelOAuthSessionStore; readonly backend: TunnelOAuthProvisioningBackend; readonly provider: OAuthTunnelAuthProvider }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-oauth-provider-'));
  roots.push(root);
  const filePath = path.join(root, 'oauth-session.dpapi');
  const store = new TunnelOAuthSessionStore({
    filePath,
    encryptSecret: async (plain: string): Promise<string> => `encrypted:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decryptSecret: async (cipher: string): Promise<string> => Buffer.from(cipher.replace(/^encrypted:/, ''), 'base64').toString('utf8'),
  });
  const descriptor = {
    id: 'fixture', authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
    clientId: 'desktop', scopes: ['openid'], enabled: true, supportsTunnelProvisioning: true, ...overrides,
  };
  const backend: TunnelOAuthProvisioningBackend = {
    descriptor,
    exchangeAuthorizationCode: vi.fn(async () => ({
      refreshToken: 'refresh-secret',
      provisioned: {
        runtimeCredential: 'runtime-secret', expiresAt: '2026-09-01T01:00:00.000Z', tunnelId: 'tunnel_fixture012345',
        accountId: 'acct-1', accountLabel: 'user@example.test', organizationId: 'org-1', workspaceId: 'ws-1',
      },
    })),
    refreshAndProvision: vi.fn(async () => ({
      runtimeCredential: 'runtime-refreshed', expiresAt: '2026-09-01T02:00:00.000Z', tunnelId: 'tunnel_fixture012345',
      accountId: 'acct-1', accountLabel: 'user@example.test', organizationId: 'org-1', workspaceId: 'ws-1',
    })),
    revoke: vi.fn(async () => undefined),
  };
  const provider = new OAuthTunnelAuthProvider({
    backend, sessionStore: store, expectedTunnelId: (): string => 'tunnel_fixture012345', now: (): Date => new Date('2026-09-01T00:00:00.000Z'),
  });
  return { filePath, store, backend, provider };
}

describe('OAuthTunnelAuthProvider', () => {
  it('fails closed when the provider cannot officially provision tunnel credentials', async () => {
    const { provider } = await fixture({ supportsTunnelProvisioning: false });
    await expect(provider.status()).resolves.toMatchObject({ mode: 'oauth', authReady: false, runtimeCredentialAvailable: false, requiresUserAction: true });
    await expect(provider.getRuntimeCredential()).resolves.toBeNull();
    await expect(provider.activateFromAuthorizationCode({ code: 'x', verifier: 'y', redirectUri: 'http://127.0.0.1:1/oauth/callback' })).rejects.toThrow('not available');
  });

  it('stores only an encrypted refresh session and keeps runtime credentials in memory', async () => {
    const { filePath, provider } = await fixture();
    await provider.activateFromAuthorizationCode({ code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:49152/oauth/callback' });
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toMatch(/^encrypted:/);
    expect(raw).not.toContain('refresh-secret');
    expect(raw).not.toContain('runtime-secret');
    await expect(provider.getRuntimeCredential()).resolves.toEqual({ value: 'runtime-secret', authMode: 'oauth', expiresAt: '2026-09-01T01:00:00.000Z' });
    await expect(provider.status()).resolves.toMatchObject({
      mode: 'oauth', authReady: true, runtimeCredentialAvailable: true, accountLabel: 'user@example.test', organizationId: 'org-1', workspaceId: 'ws-1',
    });
  });

  it('refreshes from the encrypted session after process-memory credential is lost', async () => {
    const { store, backend, provider } = await fixture();
    await provider.activateFromAuthorizationCode({ code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:49152/oauth/callback' });
    const restarted = new OAuthTunnelAuthProvider({
      backend, sessionStore: store, expectedTunnelId: (): string => 'tunnel_fixture012345', now: (): Date => new Date('2026-09-01T00:10:00.000Z'),
    });
    await expect(restarted.getRuntimeCredential()).resolves.toEqual({ value: 'runtime-refreshed', authMode: 'oauth', expiresAt: '2026-09-01T02:00:00.000Z' });
    expect(backend.refreshAndProvision).toHaveBeenCalledTimes(1);
  });

  it('rejects an OAuth result that would silently replace the saved Tunnel ID', async () => {
    const { backend, store } = await fixture();
    const mismatch = new OAuthTunnelAuthProvider({ backend, sessionStore: store, expectedTunnelId: (): string => 'tunnel_other012345' });
    await expect(mismatch.activateFromAuthorizationCode({ code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:49152/oauth/callback' })).rejects.toThrow('AUTH_ORG_MISMATCH');
  });

  it('revokes and clears the refresh session on logout', async () => {
    const { filePath, backend, provider } = await fixture();
    await provider.activateFromAuthorizationCode({ code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:49152/oauth/callback' });
    await provider.logout();
    expect(backend.revoke).toHaveBeenCalledTimes(1);
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
    await expect(provider.status()).resolves.toMatchObject({ authReady: false, runtimeCredentialAvailable: false });
  });
});
