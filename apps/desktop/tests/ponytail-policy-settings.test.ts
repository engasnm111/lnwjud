import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv('LNWJUD_UNRESTRICTED', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }));
});

describe('Desktop Ponytail scoped policy settings', () => {
  it('reports Default OFF separately from an explicit Global setting and persists workspace overrides safely', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ponytail-policy-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ponytail-policy-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    const workspaceRoot = await realpath(rawWorkspaceRoot);
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      await expect(runtime.services.getPonytailPolicyContext({ workspaceId: workspace.id })).resolves.toMatchObject({
        workspaceId: workspace.id,
        globalMode: 'off',
        workspaceMode: 'inherit',
        effectiveWorkspaceMode: 'off',
        effectiveWorkspaceSource: 'default',
      });

      const currentSettings = runtime.getUserSettings();
      await runtime.services.setUserSettings({ settings: { ...currentSettings, ponytailMode: 'lite' } });
      await expect(runtime.services.getPonytailPolicyContext({ workspaceId: workspace.id })).resolves.toMatchObject({
        globalMode: 'lite',
        workspaceMode: 'inherit',
        effectiveWorkspaceMode: 'lite',
        effectiveWorkspaceSource: 'global',
      });

      await expect(runtime.services.setWorkspacePonytailMode({ workspaceId: workspace.id, mode: 'full' })).resolves.toMatchObject({
        globalMode: 'lite',
        workspaceMode: 'full',
        effectiveWorkspaceMode: 'full',
        effectiveWorkspaceSource: 'workspace',
      });
      const profile = JSON.parse(await readFile(path.join(workspaceRoot, '.lnwjud', 'project-profile.json'), 'utf8')) as Record<string, unknown>;
      expect(profile).toMatchObject({ ponytail: { mode: 'full' } });

      await expect(runtime.services.setWorkspacePonytailMode({ workspaceId: workspace.id, mode: 'inherit' })).resolves.toMatchObject({
        workspaceMode: 'inherit',
        effectiveWorkspaceMode: 'lite',
        effectiveWorkspaceSource: 'global',
      });
      const inheritedProfile = JSON.parse(await readFile(path.join(workspaceRoot, '.lnwjud', 'project-profile.json'), 'utf8')) as Record<string, unknown>;
      expect(inheritedProfile).not.toHaveProperty('ponytail');
    } finally {
      await runtime.close();
    }
  });

  it('blocks Current Goal edits while a worker lease is live, then applies an idle revision-CAS override', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ponytail-goal-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ponytail-goal-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: await realpath(rawWorkspaceRoot) });
      const started = await runtime.mcpServices.goals?.runGoal(runtime.mcpActor, {
        workspaceId: workspace.id,
        goalKey: 'desktop-ponytail-policy-test',
        objective: 'Exercise Current Goal Ponytail settings safely.',
        plan: { steps: [] },
        leaseSeconds: 600,
      });
      expect(started).toMatchObject({ ok: true, value: { acquired: true, leaseToken: expect.any(String) } });
      if (started === undefined || !started.ok || started.value.leaseToken === undefined) throw new Error('test goal lease was not acquired');

      const liveContext = await runtime.services.getPonytailPolicyContext({ workspaceId: workspace.id });
      const liveGoal = liveContext.activeGoals.find((goal) => goal.goalId === started.value.goalId);
      expect(liveGoal).toMatchObject({ mode: 'inherit', editable: false, editBlockedReason: 'live_lease' });
      if (liveGoal === undefined) throw new Error('test goal was not visible to Desktop policy context');
      await expect(runtime.services.setGoalPonytailMode({
        workspaceId: workspace.id,
        goalId: liveGoal.goalId,
        expectedRevision: liveGoal.revision,
        mode: 'ultra',
      })).rejects.toThrow(/live worker lease/i);

      const released = await runtime.mcpServices.goals?.checkpointGoal(runtime.mcpActor, {
        goalId: started.value.goalId,
        leaseToken: started.value.leaseToken,
        expectedRevision: started.value.revision,
        currentPhase: 'idle-policy-edit',
        summary: 'Release the test worker before changing host policy.',
        stepUpdates: [],
        nextAction: 'Change Ponytail mode from Desktop.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: true,
      });
      expect(released).toMatchObject({ ok: true });

      const idleContext = await runtime.services.getPonytailPolicyContext({ workspaceId: workspace.id });
      const idleGoal = idleContext.activeGoals.find((goal) => goal.goalId === started.value.goalId);
      expect(idleGoal).toMatchObject({ editable: true, editBlockedReason: null });
      if (idleGoal === undefined) throw new Error('released test goal was not visible to Desktop policy context');

      const updated = await runtime.services.setGoalPonytailMode({
        workspaceId: workspace.id,
        goalId: idleGoal.goalId,
        expectedRevision: idleGoal.revision,
        mode: 'ultra',
      });
      expect(updated.activeGoals.find((goal) => goal.goalId === idleGoal.goalId)).toMatchObject({
        mode: 'ultra',
        effectiveMode: 'ultra',
        effectiveSource: 'goal',
        editable: true,
      });
      await expect(runtime.services.setGoalPonytailMode({
        workspaceId: workspace.id,
        goalId: idleGoal.goalId,
        expectedRevision: idleGoal.revision,
        mode: 'lite',
      })).rejects.toThrow(/revision is stale/i);
    } finally {
      await runtime.close();
    }
  });
});
