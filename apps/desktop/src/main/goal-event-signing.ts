import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalGoalEvent, type GoalCommitEvent } from '@lnwjud/domain';
import type { SecretProtector } from '@lnwjud/shared';
import { SqliteGoalEventStore, type GoalEventSigningKey } from '@lnwjud/storage';

export interface GoalEventPublicKey { readonly keyId: string; readonly publicKey: string }
export interface SignedGoalEvent { readonly event: GoalCommitEvent; readonly keyId: string; readonly signature: string }
export interface GoalEventKeyCertificate extends GoalEventPublicKey {
  readonly contract: 'lnwjud.goal-event-key.v1';
  readonly previousKeyId: string | null;
  readonly issuedAt: string;
}
export interface SignedGoalEventKey { readonly certificate: GoalEventKeyCertificate; readonly previousSignature: string | null }
export interface GoalEventAuthorizationReceipt {
  readonly contract: 'lnwjud.goal-event-authorization.v1';
  readonly nonce: string;
  readonly subscriberId: string;
  readonly workspaceId: string;
  readonly authorizationEpoch: number;
  readonly active: boolean;
  readonly observedAt: string;
  readonly expiresAt: string;
}
export interface SignedGoalEventAuthorization { readonly authorization: GoalEventAuthorizationReceipt; readonly keyId: string; readonly signature: string }

const eventMessage = (event: unknown): Buffer => Buffer.from(`lnwjud.goal-event-signature.v1\0${canonicalGoalEvent(event)}`);

export class GoalEventSigner {
  private current: { readonly record: GoalEventSigningKey; readonly privateKey: KeyObject } | undefined;
  public constructor(private readonly store: SqliteGoalEventStore, private readonly protector: SecretProtector) {}

  public async initialize(): Promise<void> {
    const status = await this.protector.status();
    if (!status.available || !status.secure) throw new Error('GOAL_EVENT_SECURE_STORAGE_UNAVAILABLE');
    const record = this.store.signingKeys().at(-1);
    if (record === undefined) { await this.rotate(); return; }
    const decrypted = await this.protector.decrypt('goal_event_signing_key', record.encryptedPrivateKey);
    const privateKey = createPrivateKey({ key: Buffer.from(decrypted.plainText, 'base64'), type: 'pkcs8', format: 'der' });
    if (privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== record.publicKey
      || keyId(record.publicKey) !== record.keyId) throw new Error('GOAL_EVENT_SIGNING_KEY_INVALID');
    this.current = { record, privateKey };
  }

  public publicKey(): GoalEventPublicKey {
    const { record } = this.requireCurrent();
    return { keyId: record.keyId, publicKey: record.publicKey };
  }

  public sign(event: GoalCommitEvent): SignedGoalEvent {
    const { record, privateKey } = this.requireCurrent();
    return { event, keyId: record.keyId, signature: sign(null, eventMessage(event), privateKey).toString('base64') };
  }

  public authorize(receipt: GoalEventAuthorizationReceipt): SignedGoalEventAuthorization {
    const { record, privateKey } = this.requireCurrent();
    return { authorization: receipt, keyId: record.keyId,
      signature: sign(null, Buffer.from(canonicalAuthorization(receipt)), privateKey).toString('base64') };
  }

  public certificates(enrolledKeyId: string): readonly SignedGoalEventKey[] {
    const keys = this.store.signingKeys();
    const index = keys.findIndex((key) => key.keyId === enrolledKeyId);
    if (index < 0) throw new Error('GOAL_EVENT_KEY_ENROLLMENT_INVALID');
    return keys.slice(index).map((key) => ({ certificate: parseCertificate(JSON.parse(key.certificateJson)), previousSignature: key.previousSignature }));
  }

  public async rotate(beforePublish?: () => Promise<boolean>): Promise<GoalEventPublicKey> {
    const previous = this.current;
    if (previous === undefined && this.store.signingKeys().length > 0) throw new Error('GOAL_EVENT_SIGNING_KEY_UNAVAILABLE');
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const certificate: GoalEventKeyCertificate = {
      contract: 'lnwjud.goal-event-key.v1', keyId: keyId(publicKey), publicKey,
      previousKeyId: previous?.record.keyId ?? null, issuedAt: new Date().toISOString(),
    };
    const certificateJson = canonicalCertificate(certificate);
    const record: GoalEventSigningKey = {
      keyId: certificate.keyId, publicKey,
      encryptedPrivateKey: await this.protector.encrypt('goal_event_signing_key', keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')),
      certificateJson,
      previousSignature: previous === undefined ? null : sign(null, Buffer.from(certificateJson), previous.privateKey).toString('base64'),
    };
    if (beforePublish !== undefined && !await beforePublish()) throw new Error('GOAL_EVENT_AUTHORIZATION_REVOKED');
    this.store.appendSigningKey(record, previous?.record.keyId ?? null);
    this.current = { record, privateKey: keys.privateKey };
    return this.publicKey();
  }

  private requireCurrent(): NonNullable<GoalEventSigner['current']> {
    if (this.current === undefined) throw new Error('GOAL_EVENT_SIGNING_KEY_UNAVAILABLE');
    return this.current;
  }
}

export function verifySignedGoalEvent(input: unknown, trustedKey: GoalEventPublicKey): GoalCommitEvent {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'event,keyId,signature' || input.keyId !== trustedKey.keyId
    || typeof input.signature !== 'string' || !verify(null, eventMessage(input.event), publicKeyObject(trustedKey), signatureBytes(input.signature))) throw new Error('GOAL_EVENT_SIGNATURE_INVALID');
  return input.event as GoalCommitEvent;
}

export function verifyGoalEventAuthorization(input: unknown, trustedKey: GoalEventPublicKey, expected: {
  readonly nonce: string; readonly subscriberId: string; readonly workspaceId: string; readonly authorizationEpoch: number; readonly now: Date;
}): GoalEventAuthorizationReceipt {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'authorization,keyId,signature' || input.keyId !== trustedKey.keyId
    || typeof input.signature !== 'string' || !verify(null, Buffer.from(canonicalAuthorization(input.authorization)), publicKeyObject(trustedKey), signatureBytes(input.signature))) throw new Error('GOAL_EVENT_AUTHORIZATION_INVALID');
  const receipt = input.authorization as GoalEventAuthorizationReceipt;
  if (!receipt.active || receipt.nonce !== expected.nonce || receipt.subscriberId !== expected.subscriberId
    || receipt.workspaceId !== expected.workspaceId || receipt.authorizationEpoch !== expected.authorizationEpoch
    || Date.parse(receipt.observedAt) > expected.now.getTime() || Date.parse(receipt.expiresAt) <= expected.now.getTime()) throw new Error('GOAL_EVENT_AUTHORIZATION_INVALID');
  return receipt;
}

export function verifyGoalEventKeyChain(pinned: GoalEventPublicKey, input: readonly SignedGoalEventKey[]): GoalEventPublicKey {
  let current = pinned;
  publicKeyObject(current);
  if (input.length < 1 || input.length > 64) throw new Error('GOAL_EVENT_KEY_CHAIN_INVALID');
  const anchor = input.findIndex((item) => item.certificate.keyId === pinned.keyId && item.certificate.publicKey === pinned.publicKey);
  if (anchor < 0 || input.filter((item) => item.certificate.keyId === pinned.keyId).length !== 1) throw new Error('GOAL_EVENT_KEY_CHAIN_INVALID');
  parseCertificate(input[anchor]!.certificate);
  for (const item of input.slice(anchor + 1)) {
    const certificate = parseCertificate(item.certificate);
    if (certificate.previousKeyId !== current.keyId || typeof item.previousSignature !== 'string'
      || !verify(null, Buffer.from(canonicalCertificate(certificate)), publicKeyObject(current), signatureBytes(item.previousSignature))) throw new Error('GOAL_EVENT_KEY_CHAIN_INVALID');
    current = { keyId: certificate.keyId, publicKey: certificate.publicKey };
  }
  return current;
}

function publicKeyObject(key: GoalEventPublicKey): KeyObject {
  if (keyId(key.publicKey) !== key.keyId) throw new Error('GOAL_EVENT_KEY_INVALID');
  const bytes = Buffer.from(key.publicKey, 'base64');
  if (bytes.toString('base64') !== key.publicKey || bytes.length !== 44) throw new Error('GOAL_EVENT_KEY_INVALID');
  const object = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  if (object.asymmetricKeyType !== 'ed25519') throw new Error('GOAL_EVENT_KEY_INVALID');
  return object;
}

function keyId(publicKey: string): string { return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex'); }
function signatureBytes(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw new Error('GOAL_EVENT_SIGNATURE_INVALID');
  return bytes;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseCertificate(value: unknown): GoalEventKeyCertificate {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'contract,issuedAt,keyId,previousKeyId,publicKey'
    || value.contract !== 'lnwjud.goal-event-key.v1' || typeof value.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyId)
    || typeof value.publicKey !== 'string' || value.previousKeyId !== null && (typeof value.previousKeyId !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousKeyId))
    || typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt)) || new Date(value.issuedAt).toISOString() !== value.issuedAt) throw new Error('GOAL_EVENT_KEY_INVALID');
  const certificate = value as unknown as GoalEventKeyCertificate;
  publicKeyObject(certificate);
  return certificate;
}
function canonicalCertificate(value: GoalEventKeyCertificate): string {
  return JSON.stringify({ contract: value.contract, keyId: value.keyId, publicKey: value.publicKey, previousKeyId: value.previousKeyId, issuedAt: value.issuedAt });
}
function canonicalAuthorization(input: unknown): string {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'active,authorizationEpoch,contract,expiresAt,nonce,observedAt,subscriberId,workspaceId'
    || input.contract !== 'lnwjud.goal-event-authorization.v1' || typeof input.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.nonce)
    || typeof input.subscriberId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.subscriberId)
    || typeof input.workspaceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.workspaceId)
    || typeof input.authorizationEpoch !== 'number' || !Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch < 1
    || typeof input.active !== 'boolean' || typeof input.observedAt !== 'string' || typeof input.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(input.observedAt)) || !Number.isFinite(Date.parse(input.expiresAt))
    || new Date(input.observedAt).toISOString() !== input.observedAt || new Date(input.expiresAt).toISOString() !== input.expiresAt
    || Date.parse(input.expiresAt) - Date.parse(input.observedAt) !== 15_000) throw new Error('GOAL_EVENT_AUTHORIZATION_INVALID');
  return JSON.stringify({ contract: input.contract, nonce: input.nonce, subscriberId: input.subscriberId, workspaceId: input.workspaceId,
    authorizationEpoch: input.authorizationEpoch, active: input.active, observedAt: input.observedAt, expiresAt: input.expiresAt });
}
