import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GOAL_POSTCOMMIT_CONTRACT,
  canonicalGoalEventPayload,
  signCommittedGoalEvent,
  verifyAndClaimGoalEvent,
  type SignedGoalEventPayload,
} from '../src/main/host-goal-postcommit-event-contract.js';

const workspaceId = 'aabf6b4d-0df9-4461-800e-f9dadddec961';
const goalId = 'ee54fd17-3050-4da9-ac64-038e2d5602e1';
const payload: SignedGoalEventPayload = {
  contract: GOAL_POSTCOMMIT_CONTRACT,
  eventId: 'abc8f370-3050-4da9-ac64-038e2d5602e1',
  workspaceId,
  goalId,
  revision: 10,
  operation: 'finish_goal',
  fromStatus: 'active',
  toStatus: 'completed',
  committedAt: '2026-11-08T10:00:00.000Z',
  origin: 'host-goal-repository',
  authorizationMode: 'standard',
};
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function fixture(authorized = true) {
  const claimed = new Set<string>();
  const subscriber = {
    isAuthorized: () => authorized,
    trustedPublicKey: () => publicKey,
    claimOnce: (_workspace: string, _goal: string, rev: number, id: string) => {
      // Durable claim identity is workspace + Goal + revision; an altered eventId
      // must not make the same committed revision writable twice.
      const key = _workspace + ':' + _goal + ':' + rev;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
  return { subscriber, claimed };
}

describe('authenticated Host post-commit envelope contract (source only)', () => {
  it('signs and verifies minimal metadata with an enrolled Host public key', async () => {
    const envelope = signCommittedGoalEvent(payload, 'host-k1', privateKey);
    const result = await verifyAndClaimGoalEvent(envelope, workspaceId, fixture().subscriber);
    expect(result).toEqual({ status: 'verified', payload });
    expect(JSON.parse(canonicalGoalEventPayload(payload).toString('utf8'))).toEqual(payload);
  });

  it('rejects forged status and extra transcript fields before claiming', async () => {
    const envelope = signCommittedGoalEvent(payload, 'host-k1', privateKey);
    const f = fixture();
    expect(await verifyAndClaimGoalEvent({
      ...envelope, payload: { ...payload, toStatus: 'failed' },
    }, workspaceId, f.subscriber)).toEqual({ status: 'rejected', reason: 'signature' });
    expect(await verifyAndClaimGoalEvent({
      ...envelope, payload: { ...payload, transcript: 'private chat contents' },
    }, workspaceId, f.subscriber)).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(f.claimed.size).toBe(0);
  });

  it('rejects a different project, revoked pairing, and replay', async () => {
    const envelope = signCommittedGoalEvent(payload, 'host-k1', privateKey);
    const f = fixture();
    expect(await verifyAndClaimGoalEvent(envelope, '00000000-0000-4000-8000-000000000001', f.subscriber))
      .toEqual({ status: 'rejected', reason: 'scope' });
    expect(await verifyAndClaimGoalEvent(envelope, workspaceId, fixture(false).subscriber))
      .toEqual({ status: 'rejected', reason: 'unauthorized' });
    expect((await verifyAndClaimGoalEvent(envelope, workspaceId, f.subscriber)).status).toBe('verified');
    expect(await verifyAndClaimGoalEvent(envelope, workspaceId, f.subscriber))
      .toEqual({ status: 'rejected', reason: 'replay' });
  });

  it('does not accept an unenrolled signature key or unknown journal result', async () => {
    const envelope = signCommittedGoalEvent(payload, 'host-k1', privateKey);
    const f = fixture();
    expect(await verifyAndClaimGoalEvent(envelope, workspaceId, {
      ...f.subscriber, trustedPublicKey: () => null,
    })).toEqual({ status: 'rejected', reason: 'unauthorized' });
    expect(await verifyAndClaimGoalEvent(envelope, workspaceId, {
      ...f.subscriber, claimOnce: () => { throw new Error('database unavailable'); },
    })).toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('accepts a committed active checkpoint revision but rejects no-op run/finish', async () => {
    const checkpoint = { ...payload, operation: 'checkpoint_goal' as const, toStatus: 'active' as const };
    const envelope = signCommittedGoalEvent(checkpoint, 'host-k1', privateKey);
    expect((await verifyAndClaimGoalEvent(envelope, workspaceId, fixture().subscriber)).status).toBe('verified');
  });

  it('rejects caller-side Full Bypass and no-op transitions', () => {
    expect(() => signCommittedGoalEvent({ ...payload, authorizationMode: 'full_bypass' } as never,
      'host-k1', privateKey)).toThrow('INVALID_HOST_GOAL_EVENT_CONTRACT');
    expect(() => signCommittedGoalEvent({ ...payload, toStatus: 'active' },
      'host-k1', privateKey)).toThrow('INVALID_HOST_GOAL_EVENT_CONTRACT');
  });
});
