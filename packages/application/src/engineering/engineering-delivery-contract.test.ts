import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENGINEERING_HARNESS_SETTINGS } from '@lnwjud/shared';
import { observeEngineeringCapabilities, observeSourceSnapshot } from './engineering-capabilities.js';
import { applyDeliveryContract } from './engineering-delivery-contract.js';
import type { EngineeringWorkflowPlan } from './engineering-workflow.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> { const root = await mkdtemp(path.join(tmpdir(), 'engineering-source-')); roots.push(root); await writeFile(path.join(root, 'worker.js'), 'export default { fetch() {} };'); await writeFile(path.join(root, 'wrangler.toml'), `name = "fixture"\naccount_id = "${'a'.repeat(32)}"\n`); return root; }
const plan: EngineeringWorkflowPlan = { primaryTaskKind: 'feature', riskTier: 'high', analysisMode: 'cross_file', riskReasons: [], workflow: [], gates: [], selectedCodeIntelligence: 'lsp_search', codeIntelligenceReason: '', deliveryScope: 'deploy' };

describe('host delivery contract', () => {
  it('binds ignored configuration consumed by a build without revealing its contents', async () => {
    const root = await fixture();
    execFileSync('git', ['init', root], { windowsHide: true });
    await writeFile(path.join(root, '.gitignore'), 'private-build.json\nnode_modules/\ndist/\n');
    await writeFile(path.join(root, 'build.cjs'), 'process.stdout.write(JSON.parse(require("fs").readFileSync("private-build.json", "utf8")).value)');
    await writeFile(path.join(root, 'private-build.json'), '{"value":"private-before"}');
    const before = await observeSourceSnapshot(root);
    expect(before.state).toBe('present');
    const buildBefore = execFileSync(process.execPath, ['build.cjs'], { cwd: root }).toString();
    await writeFile(path.join(root, 'private-build.json'), '{"value":"private-after"}');
    expect(execFileSync(process.execPath, ['build.cjs'], { cwd: root }).toString()).not.toBe(buildBefore);
    const after = await observeSourceSnapshot(root);
    expect(after.state).toBe('present');
    expect(after).not.toEqual(before);
    expect(JSON.stringify(after)).not.toContain('private-');
  });
  it('requires CI by default and justifies N/A only for explicit local policy plus observed absence', async () => {
    const facts = await observeEngineeringCapabilities(await fixture());
    const required = applyDeliveryContract(plan, facts, DEFAULT_ENGINEERING_HARNESS_SETTINGS, 'policy');
    expect(required.gates.find((gate) => gate.id === 'exact_sha_ci')).toMatchObject({ applicability: 'required', status: 'pending' });
    const local = applyDeliveryContract(plan, facts, { ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, hostedCi: 'local_only', allowNoGit: true }, 'policy');
    expect(local.gates.find((gate) => gate.id === 'exact_sha_ci')).toMatchObject({ applicability: 'not_applicable', status: 'not_applicable', decision: { authority: 'host_policy', reasonCode: 'TRUSTED_LOCAL_WORKFLOW' } });
    expect(local.gates.find((gate) => gate.id === 'focused_validation')?.applicability).toBe('required');
    expect(local.contract?.artifactRole).toBe('worker_bundle');
    expect(local.gates.find((gate) => gate.id === 'deployment')?.applicability).toBe('required');

    const noArtifact = applyDeliveryContract(plan, { ...facts, artifact: { state: 'present', value: 'none' } }, DEFAULT_ENGINEERING_HARNESS_SETTINGS, 'policy');
    expect(noArtifact.contract?.artifactRole).toBe('none');
    expect(noArtifact.gates.find((gate) => gate.id === 'package')).toMatchObject({
      applicability: 'not_applicable',
      status: 'not_applicable',
      decision: { authority: 'host_policy', reasonCode: 'NO_ARTIFACT_EXPECTED' },
    });
    expect(noArtifact.gates.find((gate) => gate.id === 'deployment')?.applicability).toBe('required');

    const unresolvedArtifact = applyDeliveryContract(plan, { ...facts, artifact: { state: 'unreadable', reasonCode: 'ARTIFACT_UNREADABLE' } }, DEFAULT_ENGINEERING_HARNESS_SETTINGS, 'policy');
    expect(unresolvedArtifact.gates.find((gate) => gate.id === 'package')).toMatchObject({ applicability: 'unresolved', status: 'pending' });

    const unreadable = applyDeliveryContract(plan, { ...facts, ci: { state: 'unreadable', reasonCode: 'DENIED' } }, { ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, hostedCi: 'local_only' }, 'policy');
    expect(unreadable.gates.find((gate) => gate.id === 'exact_sha_ci')?.applicability).toBe('unresolved');
  });
  it('hashes no-Git source content and file names, including newly added inputs', async () => {
    const root = await fixture();
    const initial = await observeSourceSnapshot(root);
    expect(initial.state).toBe('present');
    await writeFile(path.join(root, 'worker.js'), 'export default { fetch() { return 1; } };');
    const changed = await observeSourceSnapshot(root);
    expect(changed).not.toEqual(initial);
    await writeFile(path.join(root, 'untracked.js'), 'new build input');
    expect(await observeSourceSnapshot(root)).not.toEqual(changed);
  });
  it('does not execute package scripts and cannot treat unsupported provider config as absent', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'write-secret-data' } }));
    await writeFile(path.join(root, '.gitlab-ci.yml'), 'job: {}');
    const facts = await observeEngineeringCapabilities(root);
    expect(facts.ci).toEqual({ state: 'present', value: { provider: 'other' } });
    expect(applyDeliveryContract(plan, facts, { ...DEFAULT_ENGINEERING_HARNESS_SETTINGS, hostedCi: 'local_only' }, 'p').gates.find((gate) => gate.id === 'exact_sha_ci')?.applicability).toBe('unresolved');
  });
  it('does not turn a directory masquerading as CI config into absence', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.github', 'workflows', 'main.yml'), { recursive: true });
    expect((await observeEngineeringCapabilities(root)).ci.state).toBe('unreadable');
  });
});
