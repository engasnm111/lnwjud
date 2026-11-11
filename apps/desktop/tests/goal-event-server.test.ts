import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalContinuationService } from '@lnwjud/application';
import { ToolRegistry } from '@lnwjud/mcp-server';
import { createExplicitKeySecretProtector, type SecretProtector } from '@lnwjud/shared';
import { SqliteDatabase, SqliteGoalEventStore, SqliteGoalRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { SqliteBackupService, applyPendingSqliteRestoreSync } from '@lnwjud/storage';
import { startGoalEventServer, type GoalEventServerHandle, type GoalEventApproval, type GoalEventServerOptions } from '../src/main/goal-event-server.js';
import { GoalEventSigner, verifyGoalEventAuthorization, verifyGoalEventKeyChain, verifySignedGoalEvent, type GoalEventPublicKey, type SignedGoalEvent, type SignedGoalEventKey, type SignedGoalEventAuthorization } from '../src/main/goal-event-signing.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor = { clientId: 'approved-host', clientName: 'Host', sessionId: 'approved-session' };
type Pair = { token: string; subscriber: { id: string; workspaceId: string; ackCursor: number }; hostKey: GoalEventPublicKey };
type Delivery = { cursor: number } & SignedGoalEvent;
type Batch = { workspaceId: string; authorizationEpoch: number; ackCursor: number; authorization: SignedGoalEventAuthorization; events: Delivery[] };
const requestNonce = 'n'.repeat(43);
interface GoalEventFixture {
  readonly root: string;
  readonly filename: string;
  readonly database: SqliteDatabase;
  readonly workspaces: SqliteWorkspaceRepository;
  readonly store: SqliteGoalEventStore;
  readonly signer: GoalEventSigner;
  readonly protector: SecretProtector;
  readonly options: GoalEventServerOptions;
  readonly server: GoalEventServerHandle;
  readonly service: GoalContinuationService;
  readonly approvals: GoalEventApproval[];
  activate(id: string): void;
  approve(): void;
  bypass(): void;
}

async function fixture(): Promise<GoalEventFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-goal-event-http-'));
  roots.push(root);
  const filename = path.join(root, 'state.sqlite');
  const database = new SqliteDatabase(filename);
  const workspaces = new SqliteWorkspaceRepository(database);
  for (const id of ['workspace-a', 'workspace-b']) await workspaces.insert({ id, displayName: id, rootPath: path.join(root, id), realRootPath: path.join(root, id), createdAt: '2026-11-11T00:00:00.000Z' });
  const store = new SqliteGoalEventStore(database);
  const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 19));
  const signer = new GoalEventSigner(store, protector);
  let activeWorkspaceId = 'workspace-a';
  let allow = false;
  let bypass = false;
  const approvals: GoalEventApproval[] = [];
  const options: GoalEventServerOptions = {
    port: 0, store, signer,
    activeWorkspaceId: async (): Promise<string> => activeWorkspaceId,
    authorizationMode: (): 'standard' | 'full_bypass' => bypass ? 'full_bypass' : 'standard',
    approve: async (request: GoalEventApproval): Promise<boolean> => { approvals.push(request); return allow; },
  };
  const server = await startGoalEventServer(options);
  const service = new GoalContinuationService(workspaces, new SqliteGoalRepository(database, options.authorizationMode));
  return { root, filename, database, workspaces, store, signer, protector, options, server, service, approvals,
    activate: (id: string): void => { activeWorkspaceId = id; }, approve: (): void => { allow = true; }, bypass: (): void => { bypass = true; } };
}

function get(server: GoalEventServerHandle, route: string, token?: string): Promise<Response> {
  return fetch(new URL(route, server.endpoint), { headers: token === undefined ? {} : { Authorization: `Bearer ${token}`, 'X-Lnwjud-Goal-Nonce': requestNonce } });
}
function post(server: GoalEventServerHandle, route: string, body: unknown, token?: string): Promise<Response> {
  return fetch(new URL(route, server.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
}
async function pair(server: GoalEventServerHandle): Promise<Pair> {
  const response = await post(server, 'pair', { workspaceId: 'workspace-a', companionName: 'Independent local consumer', nonce: 'x'.repeat(43) });
  expect(response.status).toBe(201);
  return await response.json() as Pair;
}
async function batch(server: GoalEventServerHandle, token: string): Promise<Batch> {
  const response = await get(server, 'events', token);
  expect(response.status).toBe(200);
  return await response.json() as Batch;
}
function signed(delivery: Delivery): SignedGoalEvent { return { event: delivery.event, keyId: delivery.keyId, signature: delivery.signature }; }

describe('authenticated local Goal Event API', () => {
  it('refuses pairing when a previously approved rotation changes the native dialog host-key pin', async () => {
    const runtime = await fixture();
    runtime.approve();
    const enrollment = await pair(runtime.server);
    let encryptionEntered!: () => void;
    let encryptionRelease!: () => void;
    let pairingEntered!: () => void;
    let pairingRelease!: () => void;
    const encrypting = new Promise<void>((resolve) => { encryptionEntered = resolve; });
    const encryptionGate = new Promise<void>((resolve) => { encryptionRelease = resolve; });
    const pairing = new Promise<void>((resolve) => { pairingEntered = resolve; });
    const pairingGate = new Promise<void>((resolve) => { pairingRelease = resolve; });
    const signer = new GoalEventSigner(runtime.store, { ...runtime.protector, encrypt: async (purpose, plaintext): Promise<string> => {
      const encrypted = await runtime.protector.encrypt(purpose, plaintext);
      encryptionEntered(); await encryptionGate; return encrypted;
    } });
    const server = await startGoalEventServer({ ...runtime.options, signer, approve: async (request): Promise<boolean> => {
      if (request.operation === 'pair') { pairingEntered(); await pairingGate; }
      return true;
    } });
    try {
      const rotating = post(server, 'keys/rotate', {}, enrollment.token);
      await encrypting;
      const pending = post(server, 'pair', { workspaceId: 'workspace-a', companionName: 'Independent local consumer', nonce: 'x'.repeat(43) });
      await pairing;
      encryptionRelease();
      expect((await rotating).status).toBe(200);
      pairingRelease();
      expect((await pending).status).toBe(409);
      expect(runtime.store.authenticate(enrollment.token)).not.toBeNull();
      expect((await pair(server)).hostKey).toEqual(signer.publicKey());
    } finally { encryptionRelease(); pairingRelease(); await server.close(); await runtime.server.close(); runtime.database.close(); }
  });
  it.each(['revoke', 'workspace'] as const)('does not publish a host key if %s changes during asynchronous secret encryption', async (mutation) => {
    const runtime = await fixture();
    runtime.approve();
    const enrollment = await pair(runtime.server);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const protector: SecretProtector = {
      ...runtime.protector,
      encrypt: async (purpose, plaintext): Promise<string> => {
        const envelope = await runtime.protector.encrypt(purpose, plaintext);
        entered(); await gate; return envelope;
      },
    };
    const signer = new GoalEventSigner(runtime.store, protector);
    const server = await startGoalEventServer({ ...runtime.options, signer });
    const before = signer.publicKey();
    try {
      const pending = post(server, 'keys/rotate', {}, enrollment.token);
      await started;
      if (mutation === 'workspace') runtime.activate('workspace-b');
      else {
        const subscriber = runtime.store.authenticate(enrollment.token);
        if (subscriber === null) throw new Error('fixture subscription failed');
        runtime.store.revoke(subscriber, new Date().toISOString());
      }
      release();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(signer.publicKey()).toEqual(before);
      expect(runtime.store.signingKeys()).toHaveLength(1);
    } finally { release(); await server.close(); await runtime.server.close(); runtime.database.close(); }
  });
  it('recovers a lost pairing response through native approval without adding orphan subscribers or losing the cursor', async () => {
    const runtime = await fixture();
    runtime.approve();
    try {
      const initial = await pair(runtime.server);
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'lost-pair', objective: 'test' });
      const original = await batch(runtime.server, initial.token);
      const first = original.events[0]!;
      expect((await post(runtime.server, 'ack', { cursor: first.cursor, eventId: first.event.eventId }, initial.token)).status).toBe(200);
      let recovered: Pair = initial;
      for (let attempt = 0; attempt < 33; attempt += 1) {
        recovered = await pair(runtime.server);
        expect(recovered.subscriber.id).toBe(initial.subscriber.id);
        expect(recovered.subscriber.ackCursor).toBe(first.cursor);
      }
      expect(runtime.approvals).toHaveLength(34);
      expect((await get(runtime.server, 'events', initial.token)).status).toBe(401);
      expect((await batch(runtime.server, recovered.token)).events).toEqual([]);
      expect((await fetch(new URL('subscription', runtime.server.endpoint), { method: 'DELETE', headers: { Authorization: `Bearer ${recovered.token}` } })).status).toBe(200);
      expect((await post(runtime.server, 'pair', { workspaceId: 'workspace-a', companionName: 'Independent local consumer', nonce: 'x'.repeat(43) })).status).toBe(409);
    } finally { await runtime.server.close(); runtime.database.close(); }
  });

  it.each([false, true])('requires new consent and a new host key after restore, including same-OS account changes (%s)', async (crossHost) => {
    const runtime = await fixture();
    runtime.approve();
    const initial = await pair(runtime.server);
    expect((await post(runtime.server, 'keys/rotate', {}, initial.token)).status).toBe(200);
    const before = runtime.signer.publicKey();
    const backupDirectory = path.join(runtime.root, 'backups');
    const backup = new SqliteBackupService(runtime.database, { databaseFilename: runtime.filename, backupDirectory, platform: 'win32', arch: 'x64' });
    const snapshot = await backup.create('manual');
    await backup.scheduleRestore(snapshot.id);
    await runtime.server.close();
    runtime.database.close();
    expect(applyPendingSqliteRestoreSync(runtime.filename, backupDirectory, { platform: 'win32', arch: crossHost ? 'arm64' : 'x64' }).applied).toBe(true);
    const database = new SqliteDatabase(runtime.filename);
    const store = new SqliteGoalEventStore(database);
    const restoredWorkspaces = new SqliteWorkspaceRepository(database);
    await restoredWorkspaces.restore('workspace-a');
    const signer = new GoalEventSigner(store, createExplicitKeySecretProtector(Buffer.alloc(32, 27)));
    const server = await startGoalEventServer({ ...runtime.options, store, signer });
    try {
      expect((await get(server, 'events', initial.token)).status).toBe(401);
      const key = signer.publicKey();
      expect(key.keyId).not.toBe(before.keyId);
      expect(store.signingKeys()).toHaveLength(1);
      const newEnrollment = await post(server, 'pair', { workspaceId: 'workspace-a', companionName: 'Independent local consumer', nonce: 'y'.repeat(43) });
      expect(newEnrollment.status).toBe(201);
      expect((await newEnrollment.json() as Pair).hostKey).toEqual(key);
    } finally { await server.close(); database.close(); }
  });
  it.each(['revoke', 'credential'] as const)('does not sign active consent after %s changes while workspace validation is pending', async (mutation) => {
    const runtime = await fixture();
    runtime.approve();
    const enrollment = await pair(runtime.server);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = await startGoalEventServer({ ...runtime.options, activeWorkspaceId: async (): Promise<string> => { entered(); await gate; return 'workspace-a'; } });
    try {
      const pending = get(server, 'subscription', enrollment.token);
      await started;
      const subscriber = runtime.store.authenticate(enrollment.token);
      if (subscriber === null) throw new Error('fixture subscription failed');
      if (mutation === 'revoke') runtime.store.revoke(subscriber, new Date().toISOString());
      else runtime.store.rotateCredential(subscriber);
      release();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'authorization_changed' });
    } finally { release(); await server.close(); await runtime.server.close(); runtime.database.close(); }
  });
  it('discovers by contract and requires native workspace consent, rejecting Watcher tokens, browser requests and Full Bypass', async () => {
    const runtime = await fixture();
    try {
      const discovery = await get(runtime.server, 'capabilities').then((response) => response.json());
      expect(discovery).toMatchObject({ contract: 'lnwjud.goal-event.v1', delivery: 'at-least-once' });
      expect(JSON.stringify(discovery)).not.toContain('5.9.1');
      expect((await get(runtime.server, 'events', 'watcher-test-token-0123456789abcdef')).status).toBe(401);
      const body = { workspaceId: 'workspace-a', companionName: 'Test companion', nonce: 'x'.repeat(43) };
      expect((await post(runtime.server, 'pair', body)).status).toBe(403);
      expect(runtime.approvals).toHaveLength(1);
      runtime.approve();
      expect((await post(runtime.server, 'pair', { ...body, workspaceId: 'workspace-b' })).status).toBe(403);
      expect(runtime.approvals).toHaveLength(1);
      const browser = await fetch(new URL('pair', runtime.server.endpoint), { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(browser.status).toBe(403);
      runtime.bypass();
      expect((await post(runtime.server, 'pair', body)).status).toBe(403);
      expect(runtime.approvals).toHaveLength(1);
    } finally { await runtime.server.close(); runtime.database.close(); }
  });

  it('delivers a genuine committed signed Goal revision to an independent durable consumer without private text', async () => {
    const runtime = await fixture();
    try {
      runtime.approve();
      const enrollment = await pair(runtime.server);
      const service = new GoalContinuationService(runtime.workspaces, new SqliteGoalRepository(runtime.database));
      const registry = new ToolRegistry({ goals: service }, actor, { ponytailModeProvider: (): 'off' => 'off' });
      const created = await registry.invoke('run_goal', { workspaceId: 'workspace-a', goalKey: 'standard-workflow', objective: 'private prompt and C:\\private\\project', plan: { steps: [] }, scheduledContinuation: 'off' });
      expect(created.isError).not.toBe(true);
      if (typeof created.structuredContent?.goalId !== 'string') throw new Error('fixture goal failed');
      const first = await batch(runtime.server, enrollment.token);
      expect(first.events).toHaveLength(1);
      const delivery = first.events[0]!;
      const event = verifySignedGoalEvent(signed(delivery), enrollment.hostKey);
      const expectedAuthorization = { nonce: requestNonce, subscriberId: enrollment.subscriber.id, workspaceId: enrollment.subscriber.workspaceId, authorizationEpoch: first.authorizationEpoch, now: new Date() };
      expect(verifyGoalEventAuthorization(first.authorization, enrollment.hostKey, expectedAuthorization).active).toBe(true);
      expect(() => verifyGoalEventAuthorization(first.authorization, enrollment.hostKey, { ...expectedAuthorization, nonce: 'z'.repeat(43) })).toThrow();
      expect(() => verifyGoalEventAuthorization(first.authorization, enrollment.hostKey, { ...expectedAuthorization, workspaceId: 'workspace-b' })).toThrow();
      expect(() => verifyGoalEventAuthorization(first.authorization, enrollment.hostKey, { ...expectedAuthorization, now: new Date(Date.now() + 16_000) })).toThrow();
      expect(event.goalId).toBe(created.structuredContent.goalId);
      expect(event.workspaceId).toBe(enrollment.subscriber.workspaceId);
      expect(event.revision).toBe(0);
      expect(runtime.database.connection.prepare('SELECT revision FROM goals WHERE id = ?').get(event.goalId)?.revision).toBe(event.revision);
      expect(JSON.stringify(first)).not.toMatch(/private prompt|private\\\\project|objective|transcript|summary|leaseToken/i);
      const document = path.join(runtime.root, 'consumer-receipt.json');
      await writeFile(document, JSON.stringify({ eventId: event.eventId, workspaceId: event.workspaceId, revision: event.revision }));
      expect(JSON.parse(await readFile(document, 'utf8'))).toEqual({ eventId: event.eventId, workspaceId: event.workspaceId, revision: 0 });
      expect((await batch(runtime.server, enrollment.token)).events).toEqual(first.events);
      expect(() => verifySignedGoalEvent({ ...signed(delivery), event: { ...event, workspaceId: 'workspace-b' } }, enrollment.hostKey)).toThrow();
      expect(() => verifySignedGoalEvent({ ...signed(delivery), event: { ...event, objective: 'injected secret' } }, enrollment.hostKey)).toThrow();
      expect((await post(runtime.server, 'ack', { cursor: delivery.cursor, eventId: 'forged' }, enrollment.token)).status).toBe(409);
      const ack = { cursor: delivery.cursor, eventId: event.eventId };
      expect((await post(runtime.server, 'ack', ack, enrollment.token)).status).toBe(200);
      expect((await post(runtime.server, 'ack', ack, enrollment.token)).status).toBe(200);
      expect((await batch(runtime.server, enrollment.token)).events).toEqual([]);
    } finally { await runtime.server.close(); runtime.database.close(); }
  });

  it('preserves signed payload and scoped cursor through restart, rotates credentials and authenticates host key rotation', async () => {
    const runtime = await fixture();
    runtime.approve();
    const enrollment = await pair(runtime.server);
    const created = await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'restart', objective: 'test' });
    if (!created.ok) throw new Error('fixture goal failed');
    const first = await batch(runtime.server, enrollment.token);
    await runtime.server.close();
    runtime.database.close();
    const database = new SqliteDatabase(runtime.filename);
    const store = new SqliteGoalEventStore(database);
    const server = await startGoalEventServer({ ...runtime.options, store, signer: new GoalEventSigner(store, runtime.protector) });
    try {
      expect((await batch(server, enrollment.token)).events).toEqual(first.events);
      const rotated = await post(server, 'credential', {}, enrollment.token).then((response) => response.json()) as { token: string };
      expect((await get(server, 'events', enrollment.token)).status).toBe(401);
      expect((await batch(server, rotated.token)).events).toEqual(first.events);
      expect((await post(server, 'keys/rotate', {}, rotated.token)).status).toBe(200);
      const keyChain = await get(server, 'keys', rotated.token).then((response) => response.json()) as { keys: SignedGoalEventKey[] };
      expect(keyChain.keys).toHaveLength(2);
      const latest = verifyGoalEventKeyChain(enrollment.hostKey, keyChain.keys);
      const after = await batch(server, rotated.token);
      expect(after.events[0]!.event).toEqual(first.events[0]!.event);
      expect(after.events[0]!.keyId).toBe(latest.keyId);
      expect(verifySignedGoalEvent(signed(after.events[0]!), latest)).toEqual(first.events[0]!.event);
      const forged = structuredClone(keyChain.keys);
      forged[1] = { ...forged[1]!, previousSignature: 'A'.repeat(86) + '==' };
      expect(() => verifyGoalEventKeyChain(enrollment.hostKey, forged)).toThrow();
      expect((await post(server, 'keys/rotate', {}, rotated.token)).status).toBe(200);
      const nextChain = await get(server, 'keys', rotated.token).then((response) => response.json()) as { keys: SignedGoalEventKey[] };
      expect(nextChain.keys).toHaveLength(3);
      const persistedPin = JSON.parse(JSON.stringify(latest)) as GoalEventPublicKey;
      const next = verifyGoalEventKeyChain(persistedPin, nextChain.keys);
      expect(verifySignedGoalEvent(signed((await batch(server, rotated.token)).events[0]!), next)).toEqual(first.events[0]!.event);
      expect(() => verifyGoalEventKeyChain(persistedPin, nextChain.keys.slice(0, 1))).toThrow();
      runtime.activate('workspace-b');
      expect((await get(server, 'events', rotated.token)).status).toBe(403);
      expect(await get(server, 'subscription', rotated.token).then((response) => response.json())).toMatchObject({ active: false, subscriber: { workspaceId: 'workspace-a' } });
      expect((await post(server, 'ack', { cursor: first.events[0]!.cursor, eventId: first.events[0]!.event.eventId }, rotated.token)).status).toBe(403);
      const revoked = await post(server, 'revoke', { workspaceId: 'workspace-a', subscriberId: enrollment.subscriber.id });
      expect(revoked.status).toBe(200);
      runtime.activate('workspace-a');
      expect((await get(server, 'events', rotated.token)).status).toBe(401);
    } finally { await server.close(); database.close(); }
  });

  it('rejects skipped acknowledgements, cross-workspace events and malformed transport without losing committed events', async () => {
    const runtime = await fixture();
    try {
      runtime.approve();
      const enrollment = await pair(runtime.server);
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'undelivered', objective: 'test' });
      const row = runtime.database.connection.prepare('SELECT sequence,event_id FROM goal_commit_events').get();
      const missingNonce = await fetch(new URL('events', runtime.server.endpoint), { headers: { Authorization: `Bearer ${enrollment.token}` } });
      expect(missingNonce.status).toBe(409);
      expect((await post(runtime.server, 'ack', { cursor: row!.sequence, eventId: row!.event_id }, enrollment.token)).status).toBe(409);
      expect((await post(runtime.server, 'pair', { workspaceId: 'workspace-a', companionName: 'bad', nonce: 'x'.repeat(43), extra: true })).status).toBe(409);
      expect((await post(runtime.server, 'pair', { workspaceId: 'workspace-a', companionName: 'x'.repeat(9000), nonce: 'x'.repeat(43) })).status).toBe(409);
      expect((await batch(runtime.server, enrollment.token)).events).toHaveLength(1);
    } finally { await runtime.server.close(); runtime.database.close(); }
  });

  it('fails closed when signing material is unavailable and rejects an occupied port without an unhandled listener', async () => {
    const runtime = await fixture();
    try {
      const occupiedPort = Number(runtime.server.endpoint.port);
      await expect(startGoalEventServer({ ...runtime.options, port: occupiedPort })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      const unavailable = new GoalEventSigner(runtime.store, { ...runtime.protector, status: async (): Promise<{ available: boolean; secure: boolean; backend: string }> => ({ available: false, secure: false, backend: 'unavailable' }) });
      await expect(startGoalEventServer({ ...runtime.options, signer: unavailable })).rejects.toThrow('GOAL_EVENT_SECURE_STORAGE_UNAVAILABLE');
      expect((await get(runtime.server, 'capabilities')).status).toBe(200);
    } finally { await runtime.server.close(); runtime.database.close(); }
  });
});
