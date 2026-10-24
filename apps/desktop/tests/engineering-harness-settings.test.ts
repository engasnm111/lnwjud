import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

describe('Desktop Engineering Harness settings and status', () => {
  it('is default-off, enables for a detected coding workspace, and exposes durable task progress without writing project policy', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-data-'));
    const rawWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-workspace-'));
    temporaryRoots.push(rawDataRoot, rawWorkspaceRoot);
    const workspaceRoot = await realpath(rawWorkspaceRoot);
    await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run' } }), 'utf8');
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        engineeringHarnessStatus: {
          workspaceId: workspace.id,
          enabled: false,
          source: 'global',
          profile: 'senior',
          task: null,
        },
      });

      const currentSettings = runtime.getUserSettings();
      await runtime.services.setUserSettings({
        settings: {
          ...currentSettings,
          engineeringHarness: {
            schemaVersion: 1,
            enabled: true,
            profile: 'senior',
            applyTo: 'coding_projects',
            autoProjectAssessment: true,
          },
        },
      });
      const enabled = await runtime.services.getDashboard();
      expect(enabled.engineeringHarnessStatus).toMatchObject({
        workspaceId: workspace.id,
        enabled: true,
        source: 'global',
        profile: 'senior',
      });

      const started = await runtime.mcpServices.goals?.runGoal(runtime.mcpActor, {
        workspaceId: workspace.id,
        goalKey: 'engineering-dashboard-status',
        objective: 'Fix the authentication persistence bug.',
        plan: { steps: [{ id: 'inspect', title: 'Inspect the existing auth flow' }] },
        engineering: {
          schemaVersion: 1,
          primaryTaskKind: 'bugfix',
          riskTier: 'high',
          policyDigest: enabled.engineeringHarnessStatus.policyDigest ?? 'missing-policy-digest',
          deliveryScope: 'local',
          gates: [{
            id: 'focused_validation',
            title: 'Focused behavioral validation',
            applicability: 'required',
            status: 'pending',
            reason: 'Auth persistence is behavior-changing.',
            basedOnUserIntentRevision: 0,
          }],
          reviewFindings: [],
        },
        leaseSeconds: 600,
      });
      expect(started).toMatchObject({ ok: true });

      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        engineeringHarnessStatus: {
          enabled: true,
          task: {
            goalKey: 'engineering-dashboard-status',
            primaryTaskKind: 'bugfix',
            riskTier: 'high',
            gates: expect.arrayContaining([expect.objectContaining({ id: 'focused_validation', status: 'stale' })]),
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });
});
