import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';
import { BUNDLED_PONYTAIL_REVIEW_SKILL_ID, BUNDLED_PONYTAIL_SKILL_ID, PonytailActivationLedger } from './ponytail-runtime.js';

const actor = { clientId: 'client-ponytail', clientName: 'Ponytail test', sessionId: 'session-ponytail' };
const fakeWorkspaceSkillId = 'workspace-agents-skills/ponytail';

function createServices(workspaceProfile?: unknown, skillMatchFailure = false): { readonly services: McpApplicationServices; readonly writes: string[] } {
  const writes: string[] = [];
  const services = {
    file: {
      async readFile(_actor: unknown, _workspaceId: string, request: { readonly path: string }) {
        if (request.path === '.lnwjud/project-profile.json') {
          if (workspaceProfile === undefined) return err(appError('FILE_NOT_FOUND', 'missing profile'));
          return ok({ path: request.path, content: JSON.stringify(workspaceProfile), startLine: 1, endLine: 1 });
        }
        return ok({ path: request.path, content: '', startLine: 1, endLine: 1 });
      },
      async writeFile(_actor: unknown, _workspaceId: string, request: { readonly path: string }) {
        writes.push(request.path);
        return ok({ path: request.path, replacedExisting: false });
      },
    },
    extensions: {
      async listSkills() {
        return skillMatchFailure
          ? err(appError('CONFLICT', 'skill matcher unavailable', true))
          : ok({ skills: [] });
      },
      async readSkill(input: { readonly skillId: string }) {
        if (input.skillId === BUNDLED_PONYTAIL_SKILL_ID) {
          return ok({
            id: BUNDLED_PONYTAIL_SKILL_ID,
            name: 'ponytail',
            description: 'bundled primary',
            source: 'bundled:agent-skills',
            trustTier: 'bundled',
            path: 'resources/agent-skills/ponytail/SKILL.md',
            content: '# Ponytail',
          });
        }
        if (input.skillId === BUNDLED_PONYTAIL_REVIEW_SKILL_ID) {
          return ok({
            id: BUNDLED_PONYTAIL_REVIEW_SKILL_ID,
            name: 'ponytail-review',
            description: 'bundled review',
            source: 'bundled:agent-skills',
            trustTier: 'bundled',
            path: 'resources/agent-skills/ponytail-review/SKILL.md',
            content: '# Ponytail Review',
          });
        }
        if (input.skillId === fakeWorkspaceSkillId) {
          return ok({
            id: fakeWorkspaceSkillId,
            name: 'ponytail',
            description: 'workspace collision',
            source: 'workspace-agents-skills',
            trustTier: 'workspace',
            path: '.agents/skills/ponytail/SKILL.md',
            content: '# Fake Ponytail',
          });
        }
        return err(appError('INVALID_INPUT', `Unknown skill ${input.skillId}`));
      },
    },
  } as unknown as McpApplicationServices;
  return { services, writes };
}

function fullRegistry(services: McpApplicationServices, extra: ConstructorParameters<typeof ToolRegistry>[2] = {}): ToolRegistry {
  return new ToolRegistry(services, actor, {
    ponytailModeProvider: () => 'full',
    ...extra,
  });
}

describe('Ponytail ToolRegistry enforcement', () => {
  it('blocks the first code mutation until the exact bundled skill loads, while docs remain unblocked', async () => {
    const { services, writes } = createServices();
    const registry = fullRegistry(services);

    const blocked = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 1;\n' });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', recoverable: true } } });
    expect(JSON.stringify(blocked.structuredContent)).toContain(BUNDLED_PONYTAIL_SKILL_ID);
    expect(writes).toEqual([]);

    const docs = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'README.md', content: '# docs\n' });
    expect(docs.isError).not.toBe(true);
    expect(writes).toEqual(['README.md']);

    const fakeLoad = await registry.invoke('skill_load', { skillId: fakeWorkspaceSkillId, workspaceId: 'workspace-1' });
    expect(fakeLoad.isError).not.toBe(true);
    const stillBlocked = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 2;\n' });
    expect(stillBlocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });

    const exactLoad = await registry.invoke('skill_load', { skillId: BUNDLED_PONYTAIL_SKILL_ID, workspaceId: 'workspace-1' });
    expect(exactLoad).toMatchObject({ structuredContent: { skill: { id: BUNDLED_PONYTAIL_SKILL_ID, trustTier: 'bundled' } } });
    const allowed = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 3;\n' });
    expect(allowed.isError).not.toBe(true);
    expect(writes).toEqual(['README.md', 'src/app.ts']);
  });

  it('activates from the exact bundled skill_load even when skill_match returns zero results or fails', async () => {
    for (const skillMatchFailure of [false, true]) {
      const { services, writes } = createServices(undefined, skillMatchFailure);
      const registry = fullRegistry(services);

      const matched = await registry.invoke('skill_match', { query: 'ponytail' });
      if (skillMatchFailure) {
        expect(matched).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', recoverable: true } } });
      } else {
        expect(matched).toMatchObject({ structuredContent: { skills: [] } });
      }

      const beforeLoad = await registry.invoke('write_file', {
        workspaceId: 'workspace-1',
        path: 'src/matcher-independent.ts',
        content: 'export const beforeLoad = true;\n',
      });
      expect(beforeLoad).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      expect(writes).toEqual([]);

      const exactLoad = await registry.invoke('skill_load', {
        skillId: BUNDLED_PONYTAIL_SKILL_ID,
        workspaceId: 'workspace-1',
      });
      expect(exactLoad).toMatchObject({ structuredContent: { skill: { id: BUNDLED_PONYTAIL_SKILL_ID, trustTier: 'bundled' } } });

      const allowed = await registry.invoke('write_file', {
        workspaceId: 'workspace-1',
        path: 'src/matcher-independent.ts',
        content: 'export const matcherIndependent = true;\n',
      });
      expect(allowed.isError).not.toBe(true);
      expect(writes).toEqual(['src/matcher-independent.ts']);
    }
  });

  it('keeps recovery operations above Ponytail activation policy', async () => {
    const { services } = createServices();
    const registry = fullRegistry(services);

    const recovery = await registry.invoke('self_heal_apply', {
      workspaceId: 'workspace-1',
      dryRun: true,
    });
    expect(recovery.isError).not.toBe(true);
    expect(recovery.structuredContent).toMatchObject({ tool: 'self_heal_apply', dryRun: true });
  });

  it('keeps OFF baseline behavior and honors a workspace OFF override over global FULL', async () => {
    const baseline = createServices();
    const offRegistry = new ToolRegistry(baseline.services, actor, { ponytailModeProvider: (): 'off' => 'off' });
    expect((await offRegistry.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/off.ts', content: 'x\n' })).isError).not.toBe(true);
    expect(baseline.writes).toEqual(['src/off.ts']);

    const workspaceOff = createServices({ ponytail: { mode: 'off' } });
    const inherited = fullRegistry(workspaceOff.services);
    expect((await inherited.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/workspace-off.ts', content: 'x\n' })).isError).not.toBe(true);
    expect(workspaceOff.writes).toEqual(['src/workspace-off.ts']);
  });

  it('suppresses Ponytail only for the requested session context and resumes enforcement without changing policy', async () => {
    const { services, writes } = createServices();
    const ledger = new PonytailActivationLedger();
    const sessionA = new ToolRegistry(services, actor, {
      ponytailModeProvider: (): 'full' => 'full',
      ponytailActivationLedger: ledger,
    });
    const sessionB = new ToolRegistry(services, { ...actor, sessionId: 'session-other' }, {
      ponytailModeProvider: (): 'full' => 'full',
      ponytailActivationLedger: ledger,
    });

    const suppressed = await sessionA.invoke('ponytail_session', {
      workspaceId: 'workspace-1',
      suppressed: true,
    });
    expect(suppressed).toMatchObject({ structuredContent: { applied: true, suppressed: true, persistence: 'session_only' } });
    expect((await sessionA.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/suppressed.ts', content: 'export const suppressed = true;\n',
    })).isError).not.toBe(true);

    const otherSession = await sessionB.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/other.ts', content: 'export const other = true;\n',
    });
    expect(otherSession).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });

    const resumed = await sessionA.invoke('ponytail_session', {
      workspaceId: 'workspace-1',
      suppressed: false,
    });
    expect(resumed).toMatchObject({ structuredContent: { applied: true, suppressed: false, persistence: 'session_only' } });
    const blockedAgain = await sessionA.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/resumed.ts', content: 'export const resumed = true;\n',
    });
    expect(blockedAgain).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(writes).toEqual(['src/suppressed.ts']);
  });

  it('does not let Full Bypass skip the Ponytail correctness gate', async () => {
    const { services, writes } = createServices();
    const registry = fullRegistry(services, {
      profileProvider: () => permissionProfiles.full,
      authorizationModeProvider: () => 'full_bypass',
    });
    const result = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'src/bypass.ts', content: 'x\n' });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(writes).toEqual([]);
  });

  it('enforces the same gate for a tool_batch child mutation', async () => {
    const { services, writes } = createServices();
    const registry = fullRegistry(services);
    const result = await registry.invoke('tool_batch', {
      parallel: false,
      maxConcurrency: 1,
      calls: [{
        id: 'write-code',
        tool: 'write_file',
        arguments: { workspaceId: 'workspace-1', path: 'src/batch.ts', content: 'x\n' },
        dependsOn: [],
      }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      summary: { failed: 1, succeeded: 0 },
      results: [{ status: 'failed', error: { code: 'CONFLICT', message: expect.stringContaining('Ponytail FULL is active') } }],
    });
    expect(writes).toEqual([]);
  });

  it('does not require the FULL/ULTRA review gate for a LITE goal', async () => {
    const base = createServices();
    let finishes = 0;
    const goalSnapshot = { workspaceId: 'workspace-1', ponytailMode: 'lite' } as const;
    const services = {
      ...base.services,
      goals: {
        async getGoal() { return ok(goalSnapshot); },
        async finishGoal() { finishes += 1; return ok({ status: 'completed' }); },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, { ponytailModeProvider: (): 'off' => 'off' });
    const goalLease = { goalId: 'goal-lite', leaseToken: 'lease-token', leaseGeneration: 1 };
    expect((await registry.invoke('skill_load', {
      skillId: BUNDLED_PONYTAIL_SKILL_ID, workspaceId: 'workspace-1', goalId: 'goal-lite',
    })).isError).not.toBe(true);
    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/lite.ts', content: 'export const lite = true;\n', goalLease,
    })).isError).not.toBe(true);
    expect((await registry.invoke('finish_goal', {
      goalId: 'goal-lite', leaseToken: 'lease-token', expectedRevision: 1, status: 'completed', summary: 'done', evidence: [],
    })).isError).not.toBe(true);
    expect(finishes).toBe(1);
  });

  it('requires a fresh exact Ponytail review before completing a FULL goal after code mutation', async () => {
    const base = createServices();
    let finishes = 0;
    const goalSnapshot = {
      goalId: 'goal-full',
      goalKey: 'goal-full-key',
      workspaceId: 'workspace-1',
      objective: 'change code',
      status: 'active',
      revision: 2,
      currentPhase: 'implement',
      plan: { steps: [] },
      completedSteps: [],
      pendingSteps: [],
      nextAction: 'review',
      blockers: [],
      activeTaskIds: [],
      trackedTasks: [],
      ponytailMode: 'full',
      lastCheckpoint: null,
      leaseGeneration: 1,
      leaseActivitySeq: 0,
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    } as const;
    const services = {
      ...base.services,
      goals: {
        async getGoal() { return ok(goalSnapshot); },
        async finishGoal() {
          finishes += 1;
          return ok({ ...goalSnapshot, status: 'completed', completionState: 'completed', scheduledTaskCancellation: { action: 'none', reason: 'no_live_task' } });
        },
      },
      git: {
        async status() { return ok({ entries: [{ path: 'src/goal.ts', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' }] }); },
        async diff() { return ok({ text: 'diff --git a/src/goal.ts b/src/goal.ts' }); },
        async log() { return ok({ commits: [] }); },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, { ponytailModeProvider: (): 'off' => 'off' });
    const goalLease = { goalId: 'goal-full', leaseToken: 'lease-token', leaseGeneration: 1 };

    expect((await registry.invoke('skill_load', {
      skillId: BUNDLED_PONYTAIL_SKILL_ID, workspaceId: 'workspace-1', goalId: 'goal-full',
    })).isError).not.toBe(true);
    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/goal.ts', content: 'export const goal = 1;\n', goalLease,
    })).isError).not.toBe(true);

    const stale = await registry.invoke('finish_goal', {
      goalId: 'goal-full', leaseToken: 'lease-token', expectedRevision: 2, status: 'completed', summary: 'done', evidence: [],
    });
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', recoverable: true } } });
    expect(JSON.stringify(stale.structuredContent)).toContain(BUNDLED_PONYTAIL_REVIEW_SKILL_ID);
    expect(finishes).toBe(0);

    expect((await registry.invoke('skill_load', {
      skillId: BUNDLED_PONYTAIL_REVIEW_SKILL_ID, workspaceId: 'workspace-1', goalId: 'goal-full',
    })).isError).not.toBe(true);
    expect((await registry.invoke('review_changes', { workspaceId: 'workspace-1', goalId: 'goal-full' })).isError).not.toBe(true);
    expect((await registry.invoke('finish_goal', {
      goalId: 'goal-full', leaseToken: 'lease-token', expectedRevision: 2, status: 'completed', summary: 'done', evidence: [],
    })).isError).not.toBe(true);
    expect(finishes).toBe(1);

    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/goal.ts', content: 'export const goal = 2;\n', goalLease,
    })).isError).not.toBe(true);
    const staleAgain = await registry.invoke('finish_goal', {
      goalId: 'goal-full', leaseToken: 'lease-token', expectedRevision: 2, status: 'completed', summary: 'done again', evidence: [],
    });
    expect(staleAgain).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(finishes).toBe(1);
  });
});
