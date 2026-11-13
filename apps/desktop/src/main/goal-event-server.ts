import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GOAL_EVENT_CONTRACT } from '@lnwjud/domain';
import { SqliteGoalEventStore } from '@lnwjud/storage';
import { GoalEventSigner } from './goal-event-signing.js';

const prefix = '/api/v1/goal-events';
export interface GoalEventApproval {
  readonly operation: 'pair' | 'revoke' | 'rotate_key';
  readonly workspaceId: string;
  readonly companionName: string;
  readonly nonce?: string;
  readonly hostKeyId?: string;
}
export interface GoalEventServerOptions {
  readonly port: number;
  readonly store: SqliteGoalEventStore;
  readonly signer: GoalEventSigner;
  readonly activeWorkspaceId: () => Promise<string | null>;
  readonly authorizationMode: () => 'standard' | 'full_bypass';
  readonly approve: (request: GoalEventApproval) => Promise<boolean>;
}
export interface GoalEventServerHandle { readonly endpoint: URL; close(): Promise<void> }

export async function startGoalEventServer(options: GoalEventServerOptions): Promise<GoalEventServerHandle> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('GOAL_EVENT_PORT_INVALID');
  await options.signer.initialize();
  let approvalPending = false;
  let closing = false;
  const approve = async (request: GoalEventApproval): Promise<boolean> => {
    if (closing || approvalPending || options.authorizationMode() !== 'standard') return false;
    approvalPending = true;
    try { return await options.approve(request); }
    catch { return false; }
    finally { approvalPending = false; }
  };
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const address = server.address();
      if (closing || typeof address !== 'object' || address === null || request.headers.host !== `127.0.0.1:${address.port}`
        || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined
        || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
        json(response, 403, { error: 'local_companion_required' }); return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.search !== '') { json(response, 400, { error: 'invalid_request' }); return; }
      if (request.method === 'GET' && url.pathname === `${prefix}/capabilities`) {
        json(response, 200, { contract: GOAL_EVENT_CONTRACT, delivery: 'at-least-once', pairing: `${prefix}/pair`,
          authentication: 'native-approved-workspace-bearer', canonicalization: 'fixed-schema-json-utf8',
          eventSignature: 'ed25519', capabilities: ['post-commit', 'metadata-only', 'cursor-ack', 'revocation', 'credential-rotation', 'signed-key-rotation'] }); return;
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/pair`) {
        const body = await readBody(request, ['workspaceId', 'companionName', 'nonce']);
        if (!identifier(body.workspaceId) || typeof body.companionName !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(body.companionName)
          || typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.nonce)) throw new Error('GOAL_EVENT_REQUEST_INVALID');
        const approvedHostKey = options.signer.publicKey();
        if (await options.activeWorkspaceId() !== body.workspaceId || !await approve({ operation: 'pair', workspaceId: body.workspaceId, companionName: body.companionName, nonce: body.nonce, hostKeyId: approvedHostKey.keyId })) {
          json(response, 403, { error: 'authorization_required' }); return;
        }
        if (closing || response.destroyed || await options.activeWorkspaceId() !== body.workspaceId || options.authorizationMode() !== 'standard'
          || options.signer.publicKey().keyId !== approvedHostKey.keyId) {
          json(response, 409, { error: 'authorization_changed' }); return;
        }
        const enrolled = options.store.enroll(body.workspaceId, body.companionName, approvedHostKey.keyId, new Date().toISOString(), body.nonce);
        json(response, 201, { contract: GOAL_EVENT_CONTRACT, ...enrolled, hostKey: approvedHostKey }); return;
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/revoke`) {
        const body = await readBody(request, ['workspaceId', 'subscriberId']);
        if (!identifier(body.workspaceId) || !identifier(body.subscriberId)) throw new Error('GOAL_EVENT_REQUEST_INVALID');
        const subscriber = options.store.lookup(body.subscriberId, body.workspaceId);
        if (subscriber === null || !await approve({ operation: 'revoke', workspaceId: subscriber.workspaceId, companionName: subscriber.companionName })) {
          json(response, 403, { error: 'authorization_required' }); return;
        }
        if (closing || options.authorizationMode() !== 'standard') { json(response, 409, { error: 'authorization_changed' }); return; }
        options.store.revoke(subscriber, new Date().toISOString());
        json(response, 200, { revoked: true }); return;
      }
      const header = request.headers.authorization;
      let subscriber = typeof header === 'string' && header.startsWith('Bearer ') ? options.store.authenticate(header.slice(7)) : null;
      if (subscriber === null) { response.setHeader('WWW-Authenticate', 'Bearer'); json(response, 401, { error: 'unauthorized' }); return; }
      if (request.method === 'DELETE' && url.pathname === `${prefix}/subscription`) {
        options.store.revoke(subscriber, new Date().toISOString()); json(response, 200, { revoked: true }); return;
      }
      const active = await options.activeWorkspaceId() === subscriber.workspaceId && options.authorizationMode() === 'standard';
      const currentSubscriber = options.store.lookup(subscriber.id, subscriber.workspaceId);
      if (currentSubscriber === null || currentSubscriber.epoch !== subscriber.epoch) {
        json(response, 401, { error: 'authorization_changed' }); return;
      }
      subscriber = currentSubscriber;
      const authorization = (): ReturnType<GoalEventSigner['authorize']> => {
        const nonce = request.headers['x-lnwjud-goal-nonce'];
        if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('GOAL_EVENT_REQUEST_INVALID');
        const now = new Date();
        return options.signer.authorize({ contract: 'lnwjud.goal-event-authorization.v1', nonce, subscriberId: subscriber.id,
          workspaceId: subscriber.workspaceId, authorizationEpoch: subscriber.epoch, active,
          observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15_000).toISOString() });
      };
      if (request.method === 'GET' && url.pathname === `${prefix}/subscription`) {
        json(response, 200, { contract: GOAL_EVENT_CONTRACT, subscriber, active, authorization: authorization() }); return;
      }
      if (!active) { json(response, 403, { error: 'workspace_authorization_inactive' }); return; }
      if (request.method === 'GET' && url.pathname === `${prefix}/events`) {
        const signedAuthorization = authorization();
        const events = options.store.read(subscriber).map((entry) => ({ cursor: entry.cursor, ...options.signer.sign(entry.event) }));
        json(response, 200, { contract: GOAL_EVENT_CONTRACT, workspaceId: subscriber.workspaceId, authorizationEpoch: subscriber.epoch,
          ackCursor: subscriber.ackCursor, authorization: signedAuthorization, events }); return;
      }
      if (request.method === 'GET' && url.pathname === `${prefix}/keys`) {
        json(response, 200, { keys: options.signer.certificates(subscriber.enrolledKeyId) }); return;
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/ack`) {
        const body = await readBody(request, ['cursor', 'eventId']);
        if (typeof body.cursor !== 'number' || !Number.isSafeInteger(body.cursor) || body.cursor <= 0 || !identifier(body.eventId)) throw new Error('GOAL_EVENT_REQUEST_INVALID');
        if (await options.activeWorkspaceId() !== subscriber.workspaceId || options.authorizationMode() !== 'standard') {
          json(response, 403, { error: 'workspace_authorization_inactive' }); return;
        }
        options.store.acknowledge(subscriber, body.cursor, body.eventId); json(response, 200, { ackCursor: body.cursor }); return;
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/credential`) {
        await readBody(request, []);
        if (await options.activeWorkspaceId() !== subscriber.workspaceId || options.authorizationMode() !== 'standard') {
          json(response, 403, { error: 'workspace_authorization_inactive' }); return;
        }
        const token = options.store.rotateCredential(subscriber); json(response, 200, { token }); return;
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/keys/rotate`) {
        await readBody(request, []);
        if (!await approve({ operation: 'rotate_key', workspaceId: subscriber.workspaceId, companionName: subscriber.companionName })) {
          json(response, 403, { error: 'authorization_required' }); return;
        }
        if (closing || await options.activeWorkspaceId() !== subscriber.workspaceId || options.authorizationMode() !== 'standard'
          || options.store.lookup(subscriber.id, subscriber.workspaceId)?.epoch !== subscriber.epoch) {
          json(response, 409, { error: 'authorization_changed' }); return;
        }
        const hostKey = await options.signer.rotate(async (): Promise<boolean> => {
          const workspaceId = await options.activeWorkspaceId();
          return !closing && workspaceId === subscriber.workspaceId && options.authorizationMode() === 'standard'
            && options.store.lookup(subscriber.id, subscriber.workspaceId)?.epoch === subscriber.epoch;
        });
        json(response, 200, { hostKey }); return;
      }
      json(response, 404, { error: 'not_found' });
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const expected = error instanceof Error && ['GOAL_EVENT_REQUEST_INVALID', 'GOAL_EVENT_ACK_INVALID', 'GOAL_EVENT_AUTHORIZATION_REVOKED'].includes(error.message);
      json(response, expected ? 409 : 503, { error: expected ? 'request_refused' : 'unavailable' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.removeListener('listening', onListening); reject(error); };
    const onListening = (): void => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(options.port, '127.0.0.1');
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('GOAL_EVENT_LISTEN_FAILED');
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}${prefix}/`),
    close: async (): Promise<void> => {
      closing = true;
      await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    },
  };
}

function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers['content-type'] !== 'application/json') throw new Error('GOAL_EVENT_REQUEST_INVALID');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error('GOAL_EVENT_REQUEST_INVALID');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('GOAL_EVENT_REQUEST_INVALID');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('GOAL_EVENT_REQUEST_INVALID'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('GOAL_EVENT_REQUEST_INVALID');
  return value as Record<string, unknown>;
}
