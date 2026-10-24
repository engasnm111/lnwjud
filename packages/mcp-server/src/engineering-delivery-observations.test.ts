import { describe, expect, it } from 'vitest';
import type { EngineeringDeliveryContract } from '@lnwjud/domain';
import { CloudflareEngineeringObservationProvider, type EngineeringBuildReceipt } from './engineering-delivery-observations.js';

const target = { accountId: 'a'.repeat(32), worker: 'worker-production', environment: 'production', trafficPercent: 100 };
const versionId = '11111111-1111-1111-1111-111111111111';
const deploymentId = '22222222-2222-2222-2222-222222222222';
const absent = { state: 'absent', reasonCode: 'NONE' } as const;
const contract: EngineeringDeliveryContract = { schemaVersion: 2, digest: 'c'.repeat(64), sourceDigest: 'a'.repeat(64), hostedCi: 'local_only', artifactRole: 'worker_bundle', workerTarget: target, facts: { git: absent, remote: absent, ci: absent, artifact: { state: 'present', value: 'worker_bundle' }, deployment: { state: 'present', value: 'cloudflare_worker' }, source: { state: 'present', value: { digest: 'a'.repeat(64), fileCount: 1 } }, digest: 'd'.repeat(64), workerTarget: target } };
const receipt: EngineeringBuildReceipt = { id: 'host-upload', workspaceId: 'workspace', sourceDigest: contract.sourceDigest!, artifactDigest: 'b'.repeat(64), contractDigest: contract.digest, artifactPath: 'dist/worker.js', artifactRole: 'worker_bundle', completedAt: '2026-10-18T00:00:00Z', provider: 'cloudflare_worker', worker: { ...target, versionId, scriptEtag: 'provider-etag' } };
function fixture(traffic = 100, suppliedReceipt: EngineeringBuildReceipt | undefined = receipt, version = versionId): { adapter: CloudflareEngineeringObservationProvider; requests: string[] } {
  const requests: string[] = [];
  const adapter = new CloudflareEngineeringObservationProvider({
    receipt: async (): Promise<EngineeringBuildReceipt | undefined> => suppliedReceipt,
    token: (): string => 'host-secret-never-returned',
    verifyArtifact: async (observed): Promise<boolean> => observed.artifactDigest === receipt.artifactDigest,
    now: (): number => Date.parse('2026-10-18T00:01:00Z'),
    fetch: async (input): Promise<Response> => {
      const url = String(input); requests.push(url);
      const result = url.includes('/versions/') ? { id: version, resources: { script: { etag: 'provider-etag' } } }
        : url.endsWith('/deployments') ? { deployments: [{ id: deploymentId, created_on: '2026-10-18T00:00:30Z' }] }
          : { id: deploymentId, strategy: 'percentage', versions: [{ version_id: versionId, percentage: traffic }, ...(traffic < 100 ? [{ version_id: '33333333-3333-3333-3333-333333333333', percentage: 100 - traffic }] : [])] };
      return new Response(JSON.stringify({ success: true, result }));
    },
  });
  return { adapter, requests };
}
const request = { workspaceId: 'workspace', gateId: 'deployment', contract, evidence: { source: 'host_observed' as const, observedAt: '2026-10-18T00:01:00Z', workspaceId: 'workspace', sourceDigest: receipt.sourceDigest, artifactDigest: receipt.artifactDigest, contractDigest: receipt.contractDigest, observationId: receipt.id } };

describe('Cloudflare host readback binding', () => {
  it('requires version readback and current 100 percent deployment for full rollout', async () => {
    const { adapter, requests } = fixture();
    expect(await adapter.verify(request)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(await fixture(50).adapter.verify(request)).toBe(false);
    expect(await fixture(100, receipt, deploymentId).adapter.verify(request)).toBe(false);
  });
  it('does not mistake an uploaded version for deployment and supports an explicitly approved canary', async () => {
    const uploaded = fixture(50);
    expect(await uploaded.adapter.verify({ ...request, gateId: 'package' })).toBe(true);
    expect(uploaded.requests).toHaveLength(1);
    const canary = { ...target, trafficPercent: 50 };
    const bound = { ...receipt, worker: { ...canary, versionId, scriptEtag: 'provider-etag' } };
    expect(await fixture(50, bound).adapter.verify({ ...request, contract: { ...contract, workerTarget: canary } })).toBe(true);
  });
  it('rejects replay across target, workspace, contract, source or artifact before using credentials', async () => {
    for (const mutation of [
      { workspaceId: 'different' }, { sourceDigest: '0'.repeat(64) }, { contractDigest: '0'.repeat(64) }, { artifactDigest: '0'.repeat(64) },
      { worker: { ...receipt.worker!, environment: 'staging' } },
    ]) {
      const { adapter, requests } = fixture(100, { ...receipt, ...mutation });
      expect(await adapter.verify(request)).toBe(false);
      expect(requests).toEqual([]);
    }
  });
});
