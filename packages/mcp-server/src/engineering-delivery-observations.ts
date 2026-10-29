import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringArtifactRole, EngineeringDeliveryContract, EngineeringGateEvidence, EngineeringWorkerTarget } from '@lnwjud/domain';

export interface EngineeringBuildReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceDigest: string;
  readonly artifactDigest: string;
  readonly contractDigest: string;
  readonly artifactPath: string;
  readonly artifactRole: EngineeringArtifactRole;
  readonly completedAt: string;
  readonly provider: 'local' | 'cloudflare_worker';
  readonly worker?: EngineeringWorkerTarget & { readonly versionId: string; readonly scriptEtag: string };
}

export interface EngineeringDeliveryObservationRequest {
  readonly workspaceId: string;
  readonly gateId: string;
  readonly contract: EngineeringDeliveryContract;
  readonly evidence: EngineeringGateEvidence;
}

export interface EngineeringDeliveryObservationProvider {
  verify(request: EngineeringDeliveryObservationRequest): Promise<boolean>;
}

export function createEngineeringReceiptArtifactVerifier(resolveRoot: (workspaceId: string) => string | undefined | Promise<string | undefined>): (receipt: EngineeringBuildReceipt) => Promise<boolean> {
  return async (receipt) => {
    try {
      const configuredRoot = await resolveRoot(receipt.workspaceId);
      if (configuredRoot === undefined) return false;
      const root = await realpath(configuredRoot);
      return createHash('sha256').update(await readEngineeringArtifactBytes(root, receipt.artifactPath)).digest('hex') === receipt.artifactDigest;
    } catch { return false; }
  };
}

/** One bounded descriptor read, shared by capture and later evidence verification. */
export async function readEngineeringArtifactBytes(root: string, relative: string): Promise<Buffer> {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some((part) => part === '..' || part === '')) throw new Error('ARTIFACT_PATH_INVALID');
  const candidate = path.resolve(root, relative);
  const canonical = await realpath(candidate);
  const contained = path.relative(root, canonical);
  const entry = await lstat(candidate);
  if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('ARTIFACT_PATH_INVALID');
  const handle = await open(canonical, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024 || before.ino !== entry.ino || before.dev !== entry.dev) throw new Error('ARTIFACT_TYPE_OR_IDENTITY_INVALID');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (read.bytesRead === 0) throw new Error('ARTIFACT_CHANGED');
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    const current = await lstat(candidate);
    if (extra.bytesRead !== 0 || before.ino !== current.ino || before.dev !== current.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(candidate) !== canonical) throw new Error('ARTIFACT_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

export class LocalEngineeringObservationProvider implements EngineeringDeliveryObservationProvider {
  public constructor(private readonly receipt: CloudflareEngineeringObservationOptions['receipt'], private readonly verifyArtifact: CloudflareEngineeringObservationOptions['verifyArtifact']) {}
  public async verify(request: EngineeringDeliveryObservationRequest): Promise<boolean> {
    if (request.gateId !== 'package' || request.evidence.observationId === undefined) return false;
    const receipt = await this.receipt(request.workspaceId, request.evidence.observationId);
    return receipt !== undefined && receipt.provider === 'local' && receipt.workspaceId === request.workspaceId
      && receipt.artifactRole === request.contract.artifactRole && receipt.sourceDigest === request.contract.sourceDigest
      && receipt.contractDigest === request.contract.digest && receipt.sourceDigest === request.evidence.sourceDigest
      && receipt.artifactDigest === request.evidence.artifactDigest && receipt.contractDigest === request.evidence.contractDigest
      && await this.verifyArtifact(receipt);
  }
}

export interface CloudflareEngineeringObservationOptions {
  /** Host-owned upload/build receipt lookup. Never read a client-authored receipt as authority. */
  readonly receipt: (workspaceId: string, observationId: string) => Promise<EngineeringBuildReceipt | undefined>;
  readonly token: () => string | undefined | Promise<string | undefined>;
  readonly verifyArtifact: (receipt: EngineeringBuildReceipt) => Promise<boolean>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Read-only Cloudflare API adapter; unsupported/missing bindings fail closed. */
export class CloudflareEngineeringObservationProvider implements EngineeringDeliveryObservationProvider {
  public constructor(private readonly options: CloudflareEngineeringObservationOptions) {}

  public async verify(request: EngineeringDeliveryObservationRequest): Promise<boolean> {
    try {
      const { evidence, contract } = request;
      if (evidence.observationId === undefined || contract.artifactRole !== 'worker_bundle' || contract.workerTarget === undefined) return false;
      const receipt = await this.options.receipt(request.workspaceId, evidence.observationId);
      const target = contract.workerTarget;
      if (receipt === undefined || receipt.provider !== 'cloudflare_worker' || receipt.artifactRole !== 'worker_bundle' || receipt.worker === undefined
        || receipt.workspaceId !== request.workspaceId || receipt.contractDigest !== contract.digest || receipt.sourceDigest !== contract.sourceDigest
        || evidence.sourceDigest !== receipt.sourceDigest || evidence.artifactDigest !== receipt.artifactDigest || evidence.contractDigest !== receipt.contractDigest
        || receipt.worker.accountId !== target.accountId || receipt.worker.worker !== target.worker || receipt.worker.environment !== target.environment
        || receipt.worker.trafficPercent !== target.trafficPercent || !validTarget(target) || !/^[a-f0-9-]{36}$/i.test(receipt.worker.versionId)
        || !/^[a-f0-9]{64}$/i.test(receipt.artifactDigest) || !(await this.options.verifyArtifact(receipt))) return false;
      const now = this.options.now?.() ?? Date.now();
      const completed = Date.parse(receipt.completedAt);
      if (!Number.isFinite(completed) || completed > now || now - completed > 24 * 60 * 60_000) return false;
      const token = await this.options.token();
      if (token === undefined || token.length === 0) return false;
      const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.worker)}`;
      const version = await this.read(`${base}/versions/${receipt.worker.versionId}`, token);
      if (!isRecord(version) || version.id !== receipt.worker.versionId || !isRecord(version.resources)
        || !isRecord(version.resources.script) || version.resources.script.etag !== receipt.worker.scriptEtag) return false;
      if (request.gateId === 'package') return true;
      if (request.gateId !== 'deployment') return false;
      const listed = await this.read(`${base}/deployments`, token);
      if (!isRecord(listed) || !Array.isArray(listed.deployments) || listed.deployments.length === 0 || listed.deployments.length > 100) return false;
      const deployments = listed.deployments.filter(isRecord);
      if (deployments.length !== listed.deployments.length || deployments.some((entry) => typeof entry.created_on !== 'string' || !Number.isFinite(Date.parse(entry.created_on)))) return false;
      deployments.sort((a, b) => Date.parse(String(b.created_on)) - Date.parse(String(a.created_on)));
      const latest = deployments[0];
      if (latest === undefined || typeof latest.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(latest.id)) return false;
      const deployment = await this.read(`${base}/deployments/${latest.id}`, token);
      if (!isRecord(deployment) || deployment.id !== latest.id || deployment.strategy !== 'percentage' || !Array.isArray(deployment.versions) || deployment.versions.length > 100) return false;
      let total = 0;
      let matching = 0;
      const versions = new Set<string>();
      for (const entry of deployment.versions) {
        if (!isRecord(entry) || typeof entry.version_id !== 'string' || versions.has(entry.version_id) || typeof entry.percentage !== 'number' || entry.percentage <= 0 || entry.percentage > 100) return false;
        versions.add(entry.version_id);
        total += entry.percentage;
        if (entry.version_id === receipt.worker.versionId) matching = entry.percentage;
      }
      return Math.abs(total - 100) < 0.00001 && Math.abs(matching - target.trafficPercent) < 0.00001;
    } catch { return false; }
  }

  private async read(url: string, token: string): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok || response.body === null) throw new Error('PROVIDER_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 256 * 1024) throw new Error('PROVIDER_RESPONSE_LIMIT');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(parsed) || parsed.success !== true) throw new Error('PROVIDER_UNAVAILABLE');
    return parsed.result;
  }
}

function validTarget(target: EngineeringWorkerTarget): boolean {
  return /^[a-f0-9]{32}$/i.test(target.accountId) && /^[a-zA-Z0-9_-]{1,63}$/.test(target.worker) && /^[a-zA-Z0-9_-]{1,63}$/.test(target.environment) && target.trafficPercent > 0 && target.trafficPercent <= 100;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
