import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { observeSourceSnapshot, type FileActor, type GoalContinuationService, type ProcessService } from '@lnwjud/application';
import { appError, err, ok, type EngineeringDeliveryContract, type GoalRepository, type Result, type InvocationAuthorization } from '@lnwjud/domain';
import { readEngineeringArtifactBytes as artifactBytes, type EngineeringBuildReceipt } from './engineering-delivery-observations.js';

const CHANNEL = 'engineering.host-build.v1';
const identifier = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const engineeringCaptureHandleSchema = z.object({
  workspaceId: identifier,
  observationId: identifier,
  goalLease: z.object({ goalId: identifier, leaseToken: z.string().min(1).max(1024), leaseGeneration: z.number().int().nonnegative() }).strict(),
  expectedRevision: z.number().int().nonnegative(),
  expectedUserIntentRevision: z.number().int().nonnegative(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const engineeringBuildArtifactSchema = engineeringCaptureHandleSchema.extend({
  artifactPath: z.string().min(1).max(4096),
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(32_768)).max(128),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  userConfirmed: z.boolean().optional(),
}).strict();
export const engineeringUploadWorkerSchema = engineeringCaptureHandleSchema.extend({ buildObservationId: identifier }).strict();
type CaptureHandle = z.infer<typeof engineeringCaptureHandleSchema>;
type BuildRequest = z.infer<typeof engineeringBuildArtifactSchema>;
type UploadRequest = z.infer<typeof engineeringUploadWorkerSchema>;

const workerTarget = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/i), worker: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/), environment: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/), trafficPercent: z.number().positive().max(100), versionId: z.uuid(), scriptEtag: z.string().min(1).max(256) }).strict();
const receiptSchema = z.object({
  id: identifier, workspaceId: identifier, sourceDigest: digest, artifactDigest: digest, contractDigest: digest,
  artifactPath: z.string().min(1).max(4096), artifactRole: z.enum(['worker_bundle', 'static_manifest', 'container_digest', 'library_archive', 'desktop_installer', 'none']),
  completedAt: z.iso.datetime(), provider: z.enum(['local', 'cloudflare_worker']), worker: workerTarget.optional(),
}).strict().transform(({ worker, ...receipt }): EngineeringBuildReceipt => ({ ...receipt, ...(worker === undefined ? {} : { worker }) }));
const signedPayloadSchema = z.object({ schemaVersion: z.literal(1), goalId: identifier, userIntentRevision: z.number().int().nonnegative(), leaseGeneration: z.number().int().nonnegative(), commandDigest: digest, processId: identifier, receipt: receiptSchema }).strict();
type SignedPayload = z.infer<typeof signedPayloadSchema>;
const envelopeSchema = z.object({ payload: z.string().max(16_384), signature: digest }).strict();
const moduleName = z.string().min(1).max(256).refine((value) => value !== 'metadata' && !value.includes('\\') && !value.startsWith('/') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== '"'));
const bundleSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({ main_module: moduleName, compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).catchall(z.unknown()),
  modules: z.array(z.object({ name: moduleName, type: z.enum(['application/javascript+module', 'application/javascript', 'application/wasm', 'text/plain', 'application/octet-stream', 'text/x-python']), base64: z.string().max(24 * 1024 * 1024) }).strict()).min(1).max(128),
}).strict();

export interface EngineeringBuildCaptureOptions {
  readonly goals: Pick<GoalContinuationService, 'validateGoalLease'>;
  readonly receipts: Pick<GoalRepository, 'recordDeliveryReceipt' | 'getDeliveryReceipt' | 'getById'>;
  readonly process: Pick<ProcessService, 'start' | 'status'>;
  readonly workspaceRoot: (workspaceId: string) => string | undefined | Promise<string | undefined>;
  readonly signingKey: () => Uint8Array | Promise<Uint8Array>;
  readonly cloudflareToken: () => string | undefined | Promise<string | undefined>;
  readonly fetch?: typeof fetch;
}
interface BuildAttempt {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly userIntentRevision: number;
  readonly leaseGeneration: number;
  readonly contractDigest: string;
  readonly sourceDigest: string;
  readonly commandDigest: string;
  readonly artifactPath: string;
  readonly processId: string;
}
class CaptureFailure extends Error {
  public constructor(readonly code: 'CONFLICT' | 'ENGINEERING_SOURCE_CHANGED' | 'ENGINEERING_EVIDENCE_REJECTED' | 'INVALID_INPUT' | 'UNSUPPORTED_PLATFORM', message: string) { super(message); }
}
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Only this live host can complete an in-flight attempt; signed completed receipts survive restart. */
export class EngineeringBuildCaptureService {
  private readonly attempts = new Map<string, BuildAttempt>();
  public constructor(private readonly options: EngineeringBuildCaptureOptions) {}

  public async start(actor: FileActor, raw: BuildRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<{ observationId: string; processId: string }>> {
    return this.result(async () => {
      const request = engineeringBuildArtifactSchema.parse(raw);
      const { root, contract } = await this.current(actor, request);
      await this.key();
      const artifactPath = relativeArtifact(request.artifactPath);
      const previousArtifact = await artifactFingerprint(root, artifactPath);
      if (previousArtifact !== null) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Build output already exists; use a fresh unique output path for each observation');
      const cwd = await realpath(path.resolve(root, request.cwd ?? '.'));
      if (!inside(root, cwd)) throw new CaptureFailure('INVALID_INPUT', 'Build working directory must remain inside the workspace');
      const command = { executable: request.executable, args: request.args, cwd, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) };
      const commandDigest = hash(JSON.stringify(command));
      const binding = { goalId: request.goalLease.goalId, workspaceId: request.workspaceId, userIntentRevision: request.expectedUserIntentRevision, leaseGeneration: request.goalLease.leaseGeneration, commandDigest, sourceDigest: contract.sourceDigest, contractDigest: contract.digest, artifactPath };
      await this.persist(actor, request, 'reserved', JSON.stringify(binding), true);
      await this.persist(actor, request, 'attempted_unresolved', JSON.stringify(binding));
      const started = await this.options.process.start(actor, request.workspaceId, { ...command, ...(request.userConfirmed === undefined ? {} : { userConfirmed: request.userConfirmed }) }, signal, authorization);
      if (!started.ok) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', `Build did not start (${started.error.code}); this observation ID is reserved and cannot be replayed`);
      const sourceDigest = contract.sourceDigest;
      if (sourceDigest === undefined) throw new CaptureFailure('ENGINEERING_SOURCE_CHANGED', 'Source snapshot is unavailable');
      this.attempts.set(request.observationId, { goalId: request.goalLease.goalId, workspaceId: request.workspaceId, userIntentRevision: request.expectedUserIntentRevision, leaseGeneration: request.goalLease.leaseGeneration, contractDigest: contract.digest, sourceDigest, commandDigest, artifactPath, processId: started.value.processId });
      await this.persist(actor, request, 'dispatched_unresolved', JSON.stringify({ ...binding, processId: started.value.processId }));
      return { observationId: request.observationId, processId: started.value.processId };
    });
  }

  public async complete(actor: FileActor, raw: CaptureHandle): Promise<Result<EngineeringBuildReceipt>> {
    return this.result(async () => {
      const request = engineeringCaptureHandleSchema.parse(raw);
      const { root, contract } = await this.current(actor, request);
      const completed = await this.readSigned(request.workspaceId, request.observationId);
      if (completed !== undefined && completed.goalId === request.goalLease.goalId && completed.receipt.provider === 'local') {
        this.matches(completed.receipt, contract);
        if (hash(await artifactBytes(root, completed.receipt.artifactPath)) !== completed.receipt.artifactDigest) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Artifact changed since the captured build');
        return completed.receipt;
      }
      const attempt = this.attempts.get(request.observationId);
      if (attempt === undefined || attempt.goalId !== request.goalLease.goalId || attempt.workspaceId !== request.workspaceId || attempt.userIntentRevision !== request.expectedUserIntentRevision || attempt.leaseGeneration !== request.goalLease.leaseGeneration || attempt.contractDigest !== contract.digest || attempt.sourceDigest !== contract.sourceDigest) throw new CaptureFailure('CONFLICT', 'Build attempt is unavailable or stale; unknown attempts cannot be replayed or adopted after restart');
      const status = await this.options.process.status(actor, request.workspaceId, attempt.processId);
      if (!status.ok || status.value.state !== 'exited' || status.value.exitCode !== 0 || status.value.finishedAt === undefined) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Build must have host-verified successful terminal process status before completion');
      const bytes = await artifactBytes(root, attempt.artifactPath);
      if (contract.artifactRole === 'worker_bundle') parseBundle(bytes);
      if (contract.artifactRole === 'unresolved' || contract.artifactRole === 'none') throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'A supported artifact role is required');
      const receipt: EngineeringBuildReceipt = { id: request.observationId, workspaceId: request.workspaceId, sourceDigest: attempt.sourceDigest, artifactDigest: hash(bytes), contractDigest: contract.digest, artifactPath: attempt.artifactPath, artifactRole: contract.artifactRole, completedAt: status.value.finishedAt, provider: 'local' };
      await this.current(actor, request);
      await this.signAndPersist(actor, request, { schemaVersion: 1, goalId: attempt.goalId, userIntentRevision: attempt.userIntentRevision, leaseGeneration: attempt.leaseGeneration, commandDigest: attempt.commandDigest, processId: attempt.processId, receipt });
      this.attempts.delete(request.observationId);
      return receipt;
    });
  }

  public async uploadWorker(actor: FileActor, raw: UploadRequest): Promise<Result<EngineeringBuildReceipt>> {
    return this.result(async () => {
      const request = engineeringUploadWorkerSchema.parse(raw);
      const { root, contract } = await this.current(actor, request);
      const build = await this.readSigned(request.workspaceId, request.buildObservationId);
      if (build === undefined || build.goalId !== request.goalLease.goalId || build.receipt.provider !== 'local') throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'A signed local build receipt from this Goal is required');
      this.matches(build.receipt, contract);
      const target = contract.workerTarget;
      if (contract.artifactRole !== 'worker_bundle' || target === undefined) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'The current contract must specify a Cloudflare Worker target');
      const bytes = await artifactBytes(root, build.receipt.artifactPath);
      if (hash(bytes) !== build.receipt.artifactDigest) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Artifact changed since the captured build');
      const bundle = parseBundle(bytes);
      const token = await this.options.cloudflareToken();
      if (token === undefined || token.length === 0) throw new CaptureFailure('UNSUPPORTED_PLATFORM', 'Configure CLOUDFLARE_API_TOKEN in the host before uploading a Worker version');
      const completed = await this.readSigned(request.workspaceId, request.observationId);
      if (completed !== undefined && completed.goalId === request.goalLease.goalId && completed.receipt.provider === 'cloudflare_worker') {
        this.matches(completed.receipt, contract);
        if (completed.receipt.artifactDigest !== build.receipt.artifactDigest || completed.commandDigest !== build.commandDigest || completed.processId !== build.processId) throw new CaptureFailure('CONFLICT', 'Upload observation is already bound to another captured build');
        return completed.receipt;
      }
      const binding = JSON.stringify({ buildObservationId: request.buildObservationId, artifactDigest: build.receipt.artifactDigest, sourceDigest: build.receipt.sourceDigest, contractDigest: contract.digest, target });
      await this.persist(actor, request, 'reserved', binding, true);
      await this.persist(actor, request, 'attempted_unresolved', binding);
      const form = new FormData();
      form.set('metadata', new Blob([JSON.stringify(bundle.metadata)], { type: 'application/json' }));
      for (const module of bundle.modules) form.set(module.name, new Blob([Uint8Array.from(Buffer.from(module.base64, 'base64'))], { type: module.type }), module.name);
      const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.worker)}/versions`;
      const uploaded = await this.provider(base, token, { method: 'POST', body: form });
      const version = providerVersion.parse(uploaded);
      const readback = providerVersion.parse(await this.provider(`${base}/${version.id}`, token));
      if (version.id !== readback.id || version.resources.script.etag !== readback.resources.script.etag) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Worker version readback did not match the uploaded version');
      const receipt: EngineeringBuildReceipt = { ...build.receipt, id: request.observationId, completedAt: new Date().toISOString(), provider: 'cloudflare_worker', worker: { ...target, versionId: version.id, scriptEtag: version.resources.script.etag } };
      await this.current(actor, request);
      if (hash(await artifactBytes(root, receipt.artifactPath)) !== receipt.artifactDigest) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Artifact changed during upload; inspect the reserved attempt before starting new work');
      await this.signAndPersist(actor, request, { ...build, leaseGeneration: request.goalLease.leaseGeneration, receipt });
      return receipt;
    });
  }

  public async resolveReceipt(workspaceId: string, observationId: string): Promise<EngineeringBuildReceipt | undefined> {
    return (await this.readSigned(workspaceId, observationId))?.receipt;
  }

  private async readSigned(workspaceId: string, observationId: string): Promise<SignedPayload | undefined> {
    try {
      const row = await this.options.receipts.getDeliveryReceipt?.(observationId);
      if (row === undefined || row === null || row.channel !== CHANNEL || row.state !== 'host_confirmed' || row.detail === undefined) return undefined;
      const envelope = envelopeSchema.parse(JSON.parse(row.detail));
      const actual = createHmac('sha256', await this.key()).update(envelope.payload).digest();
      const supplied = Buffer.from(envelope.signature, 'hex');
      if (!timingSafeEqual(actual, supplied)) return undefined;
      const payload = signedPayloadSchema.parse(JSON.parse(envelope.payload));
      const goal = await this.options.receipts.getById(row.goalId);
      if (payload.goalId !== row.goalId || row.id !== observationId || payload.receipt.id !== observationId || payload.receipt.workspaceId !== workspaceId || goal?.workspaceId !== workspaceId || payload.userIntentRevision !== row.basedOnUserIntentRevision || goal.userIntentRevision !== payload.userIntentRevision || goal.engineering?.contract?.digest !== payload.receipt.contractDigest) return undefined;
      return payload;
    } catch { return undefined; }
  }

  private async current(actor: FileActor, request: CaptureHandle): Promise<{ root: string; contract: EngineeringDeliveryContract }> {
    const validated = await this.options.goals.validateGoalLease(actor, { goalId: request.goalLease.goalId, leaseToken: request.goalLease.leaseToken });
    if (!validated.ok) throw new CaptureFailure('CONFLICT', 'Goal lease is invalid; reacquire the current lease before retrying');
    const goal = validated.value;
    if (goal.status !== 'active' || goal.workspaceId !== request.workspaceId || goal.revision !== request.expectedRevision || goal.userIntentRevision !== request.expectedUserIntentRevision || goal.leaseGeneration !== request.goalLease.leaseGeneration) throw new CaptureFailure('CONFLICT', 'Goal generation, revision, or user intent changed');
    const contract = goal.engineering?.contract;
    const configuredRoot = await this.options.workspaceRoot(request.workspaceId);
    if (contract === undefined || contract.sourceDigest === undefined || configuredRoot === undefined) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Prepare an Engineering delivery contract with a readable source snapshot first');
    const root = await realpath(configuredRoot);
    const source = await observeSourceSnapshot(root);
    if (source.state !== 'present' || source.value.digest !== contract.sourceDigest) throw new CaptureFailure('ENGINEERING_SOURCE_CHANGED', 'Source changed or is unreadable; reconcile the Engineering contract before building');
    return { root, contract };
  }

  private matches(receipt: EngineeringBuildReceipt, contract: EngineeringDeliveryContract): void {
    if (receipt.sourceDigest !== contract.sourceDigest || receipt.contractDigest !== contract.digest || receipt.artifactRole !== contract.artifactRole) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Build receipt does not match the current source and delivery contract');
  }

  private async persist(actor: FileActor, request: CaptureHandle, state: 'reserved' | 'attempted_unresolved' | 'dispatched_unresolved' | 'host_confirmed', detail?: string, createOnly = false): Promise<void> {
    await this.current(actor, request);
    const write = this.options.receipts.recordDeliveryReceipt;
    if (write === undefined) throw new CaptureFailure('UNSUPPORTED_PLATFORM', 'Durable Goal receipt storage is unavailable');
    const goal = await this.options.receipts.getById(request.goalLease.goalId);
    if (goal?.leaseOwnerSessionId === undefined) throw new CaptureFailure('CONFLICT', 'Goal lease ownership is unavailable');
    await write.call(this.options.receipts, { id: request.observationId, goalId: request.goalLease.goalId, channel: CHANNEL, state, basedOnUserIntentRevision: request.expectedUserIntentRevision, now: new Date().toISOString(), createOnly,
      mutationFence: { ownerClientId: goal.ownerClientId, ownerSessionId: goal.leaseOwnerSessionId, leaseTokenHash: hash(request.goalLease.leaseToken), leaseGeneration: request.goalLease.leaseGeneration, expectedRevision: request.expectedRevision },
      ...(detail === undefined ? {} : { detail }) });
  }

  private async signAndPersist(actor: FileActor, request: CaptureHandle, payload: SignedPayload): Promise<void> {
    const serialized = JSON.stringify(signedPayloadSchema.parse(payload));
    const signature = createHmac('sha256', await this.key()).update(serialized).digest('hex');
    await this.persist(actor, request, 'host_confirmed', JSON.stringify({ payload: serialized, signature }));
  }

  private async key(): Promise<Uint8Array> {
    const key = await Promise.resolve().then(() => this.options.signingKey()).catch(() => undefined);
    if (key !== undefined && key.byteLength >= 32) return key;
    throw new CaptureFailure('UNSUPPORTED_PLATFORM', 'Secure host signing storage is unavailable; enable the host key store before building');
  }

  private async provider(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(url, { ...init, headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || response.body === null) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Cloudflare upload/readback failed; the reserved attempt must not be replayed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 256 * 1024) throw new Error('Response limit'); chunks.push(next.value); } } finally { await reader.cancel(); }
    return z.object({ success: z.literal(true), result: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).result;
  }

  private async result<T>(run: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await run()); } catch (error) { return err(appError(error instanceof CaptureFailure ? error.code : 'ENGINEERING_EVIDENCE_REJECTED', error instanceof CaptureFailure ? error.message : 'Build evidence could not be verified; inspect the current Goal and reserved observation before retrying', true)); }
  }
}

const providerVersion = z.object({ id: z.uuid(), resources: z.object({ script: z.object({ etag: z.string().min(1).max(256) }) }) });
function inside(root: string, file: string): boolean { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function relativeArtifact(value: string): string {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).some((part) => part === '..' || part === '')) throw new CaptureFailure('INVALID_INPUT', 'Artifact must be a relative workspace file path');
  return value;
}
function parseBundle(bytes: Buffer): z.infer<typeof bundleSchema> {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Worker manifest exceeds the supported size');
  const bundle = bundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  const names = new Set<string>();
  let size = 0;
  for (const module of bundle.modules) {
    const decoded = Buffer.from(module.base64, 'base64');
    size += decoded.byteLength;
    if (names.has(module.name) || decoded.toString('base64') !== module.base64 || size > 16 * 1024 * 1024) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Worker manifest contains duplicate names, invalid base64, or oversized modules');
    names.add(module.name);
  }
  if (!names.has(bundle.metadata.main_module)) throw new CaptureFailure('ENGINEERING_EVIDENCE_REJECTED', 'Worker manifest main_module is missing');
  return bundle;
}
async function artifactFingerprint(root: string, relative: string): Promise<string | null> {
  try {
    const bytes = await artifactBytes(root, relative);
    const stat = await lstat(path.resolve(root, relative));
    return hash(JSON.stringify([hash(bytes), stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
