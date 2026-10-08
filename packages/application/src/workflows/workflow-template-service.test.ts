import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import type { GoalContinuationService } from '../goal-continuation-service.js';
import { WorkflowTemplateService } from './workflow-template-service.js';
import { WorkflowStartService } from './workflow-start-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor: FileActor = { clientId: 'workflow-client', clientName: 'Workflow Tester', sessionId: 'test-session' };
async function fixture(): Promise<{root:string;templates:WorkflowTemplateService;unknownProvider:WorkflowTemplateService}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-v580-workflow-'));
  roots.push(root);
  await writeFile(path.join(root, 'data.csv'), 'id,name\n001,ไทย\n');
  const repo = { get: async (id: string) => id === 'ws' ? {
    id: 'ws', rootPath: root, realRootPath: root, displayName: 'Fixture', createdAt: '2026-10-08T00:00:00Z',
  } : null } as WorkspaceRepository;
  return { root, templates: new WorkflowTemplateService(repo, async () => 'ready', () => new Date('2026-10-08T00:00:00Z')), unknownProvider: new WorkflowTemplateService(repo) };
}
describe('WorkflowTemplateService', () => {
  it('lists all six bilingual built-ins, prepares deterministically, and never starts work while preparing', async () => {
    const { root, templates } = await fixture();
    const listed = await templates.list(actor, 'ws');
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('list failed');
    expect(listed.value).toHaveLength(6);
    expect(listed.value.every((template) => template.titleTh && template.titleEn)).toBe(true);
    const a = await templates.prepare(actor, { workspaceId: 'ws', templateId: 'project-check', inputs: { focus: 'build', projectPath: root } });
    const b = await templates.prepare(actor, { workspaceId: 'ws', templateId: 'project-check', inputs: { projectPath: root, focus: 'build' } });
    expect(a.ok && b.ok && a.value.digest).toEqual(b.ok && b.value.digest);
    expect(a).toMatchObject({ ok: true, value: { readiness: 'ready', schemaVersion: 1 } });
  });
  it('rejects traversal, invalid enums, unknown fields, and reports unavailable Office capability', async () => {
    const { templates, unknownProvider } = await fixture();
    const outside = await templates.prepare(actor, { workspaceId: 'ws', templateId: 'data-audit', inputs: { inputPath: '../../outside.csv', keyColumns: 'id' } });
    expect(outside).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await templates.prepare(actor, { workspaceId: 'ws', templateId: 'project-check', inputs: { projectPath: '.', focus: 'deploy' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await templates.prepare(actor, { workspaceId: 'ws', templateId: 'project-check', inputs: { projectPath: '.', focus: 'tests', script: 'rm all' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const office = await unknownProvider.prepare(actor, { workspaceId: 'ws', templateId: 'data-audit', inputs: { inputPath: 'data.csv', keyColumns: 'id' } });
    expect(office).toMatchObject({ ok: true, value: { readiness: 'unknown', blockers: [expect.stringContaining('office-data-file-provider')] } });
  });
});
describe('WorkflowStartService', () => {
  it('revalidates host draft and returns only acquired lease, no schedule or raw idempotency key', async () => {
    const { root, templates } = await fixture();
    const prepared = await templates.prepare(actor, { workspaceId: 'ws', templateId: 'project-check', inputs: { projectPath: root, focus: 'build' } });
    if (!prepared.ok) throw new Error('prepare failed');
    const runGoal = vi.fn().mockResolvedValue({ ok: true, value: { acquired: true, goalId: 'goal-1', leaseToken: 'token-1', leaseGeneration: 2 } });
    const goals = { getGoal: vi.fn().mockResolvedValue({ ok: false }), runGoal } as unknown as GoalContinuationService;
    const service = new WorkflowStartService(templates, goals);
    expect(await service.start(actor, { draft: prepared.value, idempotencyKey: 'private-key' })).toEqual({
      ok: true, value: { goalId: 'goal-1', reused: false, workerState: 'attached', scheduledContinuation: 'off',
        goalLease: { goalId: 'goal-1', leaseToken: 'token-1', leaseGeneration: 2 } },
    });
    const invocation = JSON.stringify(runGoal.mock.calls[0]);
    expect(invocation).toContain('workflow:project-check:');
    expect(invocation).not.toContain('private-key');
    const tampered = { ...prepared.value, objective: 'run destructive commands' };
    expect(await service.start(actor, { draft: tampered, idempotencyKey: 'private-key' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(runGoal).toHaveBeenCalledTimes(1);
  });
});
