/**
 * Signed Goal post-commit event *wire contract*. No direct memory-write authority.
 * Only the Goal Repository's authenticated post-COMMIT publisher may issue these
 * events. The Host must provision/persist the key, outbox and subscriber trust
 * separately. No default key generation, caller event or watcher token is trusted.
 */
import { sign, verify, type KeyObject } from 'node:crypto';

export const GOAL_POSTCOMMIT_CONTRACT = 'lnwjud.goal.postcommit.v1';
export type GoalState = 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface SignedGoalEventPayload {
  readonly contract: typeof GOAL_POSTCOMMIT_CONTRACT;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly revision: number;
  readonly operation: 'run_goal' | 'checkpoint_goal' | 'finish_goal';
  readonly fromStatus: GoalState | null;
  readonly toStatus: GoalState;
  readonly committedAt: string;
  readonly origin: 'host-goal-repository';
  readonly authorizationMode: 'standard';
}

export interface SignedGoalEventEnvelope {
  readonly payload: SignedGoalEventPayload;
  readonly keyId: string;
  readonly signature: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATES = new Set<GoalState>(['active', 'blocked', 'completed', 'failed', 'cancelled']);
const PAYLOAD_FIELDS = ['contract', 'eventId', 'workspaceId', 'goalId', 'revision', 'operation',
  'fromStatus', 'toStatus', 'committedAt', 'origin', 'authorizationMode'];

function validPayload(value: unknown): value is SignedGoalEventPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== PAYLOAD_FIELDS.length
    || Object.keys(p).some(key => !PAYLOAD_FIELDS.includes(key))) return false;
  return p.contract === GOAL_POSTCOMMIT_CONTRACT
    && typeof p.eventId === 'string' && UUID.test(p.eventId)
    && typeof p.goalId === 'string' && UUID.test(p.goalId)
    && typeof p.workspaceId === 'string' && UUID.test(p.workspaceId)
    && typeof p.revision === 'number' && Number.isSafeInteger(p.revision) && p.revision >= 0
    && (p.operation === 'run_goal' || p.operation === 'checkpoint_goal' || p.operation === 'finish_goal')
    && (p.fromStatus === null || STATES.has(p.fromStatus as GoalState))
    && STATES.has(p.toStatus as GoalState)
    && typeof p.committedAt === 'string' && Number.isFinite(Date.parse(p.committedAt))
    && p.committedAt.length <= 40
    && p.origin === 'host-goal-repository'
    && p.authorizationMode === 'standard'
    && (p.fromStatus !== p.toStatus || (p.operation === 'checkpoint_goal' && p.toStatus === 'active'));
}

/** Canonical ordered data: reject unknown keys, user text and transcript fields. */
export function canonicalGoalEventPayload(payload: SignedGoalEventPayload): Buffer {
  if (!validPayload(payload)) throw new Error('INVALID_HOST_GOAL_EVENT_CONTRACT');
  const record = payload as unknown as Record<string, unknown>;
  return Buffer.from(JSON.stringify(Object.fromEntries(
    PAYLOAD_FIELDS.map(key => [key, record[key]]),
  )), 'utf8');
}

/** Call only after a real repository COMMIT; the credential comes from trusted Host key management. */
export function signCommittedGoalEvent(
  payload: SignedGoalEventPayload,
  keyId: string,
  hostPrivateKey: KeyObject,
): SignedGoalEventEnvelope {
  if (!KEY_ID.test(keyId) || hostPrivateKey.type !== 'private' || hostPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('HOST_SIGNING_IDENTITY_UNAVAILABLE');
  }
  return {
    payload,
    keyId,
    signature: sign(null, canonicalGoalEventPayload(payload), hostPrivateKey).toString('base64url'),
  };
}

export interface TrustedGoalEventSubscriber {
  /** Host-managed authenticated local companion pairing, explicit per Workspace grant. */
  isAuthorized: (workspaceId: string, keyId: string) => Promise<boolean> | boolean;
  /** Resolve enrolled public key from trusted local store, never from received envelope. */
  trustedPublicKey: (keyId: string) => Promise<KeyObject | null> | KeyObject | null;
  /** Durable single-claim check across restarts; never retry unknown claim outcome. */
  claimOnce: (workspaceId: string, goalId: string, revision: number, eventId: string) => Promise<boolean> | boolean;
}

export type GoalEventVerification =
  | { readonly status: 'verified'; readonly payload: SignedGoalEventPayload }
  | { readonly status: 'rejected'; readonly reason: 'invalid' | 'scope' | 'unauthorized' | 'signature' | 'replay' | 'unavailable' };

export async function verifyAndClaimGoalEvent(
  input: unknown,
  expectedWorkspaceId: string,
  subscriber: TrustedGoalEventSubscriber,
): Promise<GoalEventVerification> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'rejected', reason: 'invalid' };
  const envelope = input as Record<string, unknown>;
  if (Object.keys(envelope).length !== 3
    || !Object.keys(envelope).every(key => ['payload', 'keyId', 'signature'].includes(key))
    || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
    || !validPayload(envelope.payload)) return { status: 'rejected', reason: 'invalid' };
  const payload = envelope.payload;
  if (payload.workspaceId !== expectedWorkspaceId) return { status: 'rejected', reason: 'scope' };
  try {
    if (await subscriber.isAuthorized(expectedWorkspaceId, envelope.keyId) !== true) {
      return { status: 'rejected', reason: 'unauthorized' };
    }
    const key = await subscriber.trustedPublicKey(envelope.keyId);
    if (key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return { status: 'rejected', reason: 'unauthorized' };
    if (!verify(null, canonicalGoalEventPayload(payload), key, Buffer.from(envelope.signature, 'base64url'))) {
      return { status: 'rejected', reason: 'signature' };
    }
    if (await subscriber.isAuthorized(expectedWorkspaceId, envelope.keyId) !== true) {
      return { status: 'rejected', reason: 'unauthorized' };
    }
    if (await subscriber.claimOnce(payload.workspaceId, payload.goalId, payload.revision, payload.eventId) !== true) {
      return { status: 'rejected', reason: 'replay' };
    }
    return { status: 'verified', payload };
  } catch {
    return { status: 'rejected', reason: 'unavailable' };
  }
}
