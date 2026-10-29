import type { EngineeringCapabilityFacts, EngineeringDeliveryContract, EngineeringFact, EngineeringGateDecision, EngineeringArtifactRole, EngineeringWorkerTarget } from './engineering.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Engineering contract object is invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Engineering contract field is invalid');
  return value;
}
function digest(value: unknown): string {
  const parsed = text(value);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error('Engineering contract digest is invalid');
  return parsed;
}
function fact<T>(value: unknown, parse: (value: unknown) => T): EngineeringFact<T> {
  const entry = record(value);
  if (entry.state === 'present') return { state: 'present', value: parse(entry.value) };
  if (entry.state === 'absent' || entry.state === 'unreadable' || entry.state === 'unsupported' || entry.state === 'unknown') return { state: entry.state, reasonCode: text(entry.reasonCode) };
  throw new Error('Engineering capability fact state is invalid');
}
function provider(value: unknown): { provider: 'github' | 'other' } {
  const entry = record(value);
  if (entry.provider !== 'github' && entry.provider !== 'other') throw new Error('Engineering provider is invalid');
  return { provider: entry.provider };
}
function role(value: unknown): EngineeringArtifactRole {
  if (value === 'worker_bundle' || value === 'static_manifest' || value === 'container_digest' || value === 'library_archive' || value === 'desktop_installer' || value === 'none') return value;
  throw new Error('Engineering artifact role is invalid');
}
export function parseEngineeringGateDecision(value: unknown): EngineeringGateDecision {
  const entry = record(value);
  if (entry.authority !== 'host_policy') throw new Error('Engineering requirement authority is invalid');
  return { authority: entry.authority, reasonCode: text(entry.reasonCode), policyDigest: text(entry.policyDigest), capabilityDigest: digest(entry.capabilityDigest), contractDigest: digest(entry.contractDigest) };
}
export function parseEngineeringDeliveryContract(value: unknown): EngineeringDeliveryContract {
  const entry = record(value);
  if (entry.schemaVersion !== 2 || (entry.hostedCi !== 'required' && entry.hostedCi !== 'local_only')) throw new Error('Engineering contract version or policy is unsupported');
  const raw = record(entry.facts);
  const facts: EngineeringCapabilityFacts = {
    git: fact(raw.git, (value) => { const head = text(record(value).head); if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('Engineering Git head is invalid'); return { head }; }),
    remote: fact(raw.remote, provider), ci: fact(raw.ci, provider), artifact: fact(raw.artifact, role),
    deployment: fact(raw.deployment, (value) => { if (value === 'cloudflare_worker' || value === 'other') return value; throw new Error('Engineering deployment provider is invalid'); }),
    source: fact(raw.source, (value) => { const source = record(value); if (!Number.isInteger(source.fileCount) || Number(source.fileCount) < 0 || Number(source.fileCount) > 4096) throw new Error('Engineering source file count is invalid'); return { digest: digest(source.digest), fileCount: Number(source.fileCount) }; }),
    digest: digest(raw.digest),
    ...(raw.workerTarget === undefined ? {} : { workerTarget: parseWorkerTarget(raw.workerTarget) }),
  };
  const sourceDigest = entry.sourceDigest === undefined ? undefined : digest(entry.sourceDigest);
  if (sourceDigest !== undefined && (facts.source.state !== 'present' || facts.source.value.digest !== sourceDigest)) throw new Error('Engineering source binding is invalid');
  return { schemaVersion: 2, digest: digest(entry.digest), facts, hostedCi: entry.hostedCi, artifactRole: entry.artifactRole === 'unresolved' ? 'unresolved' : role(entry.artifactRole), ...(sourceDigest === undefined ? {} : { sourceDigest }), ...(entry.workerTarget === undefined ? {} : { workerTarget: parseWorkerTarget(entry.workerTarget) }) };
}

function parseWorkerTarget(value: unknown): EngineeringWorkerTarget {
  const target = record(value);
  const accountId = text(target.accountId), worker = text(target.worker), environment = text(target.environment);
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-zA-Z0-9_-]{1,63}$/.test(worker) || !/^[a-zA-Z0-9_-]{1,63}$/.test(environment)
    || typeof target.trafficPercent !== 'number' || target.trafficPercent <= 0 || target.trafficPercent > 100) throw new Error('Engineering Worker target is invalid');
  return { accountId, worker, environment, trafficPercent: target.trafficPercent };
}
