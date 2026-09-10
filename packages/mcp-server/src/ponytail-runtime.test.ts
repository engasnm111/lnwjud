import { describe, expect, it } from 'vitest';
import type { ResolvedPonytailPolicy } from '@lnwjud/shared';
import {
  BUNDLED_PONYTAIL_REVIEW_SKILL_ID,
  BUNDLED_PONYTAIL_SKILL_ID,
  PonytailActivationLedger,
  isCodingMutation,
  isDevelopmentArtifactPath,
} from './ponytail-runtime.js';

const context = { sessionId: 'session-1', workspaceId: 'workspace-1', goalId: 'goal-1' } as const;
const full: ResolvedPonytailPolicy = { mode: 'full', source: 'goal' };
const lite: ResolvedPonytailPolicy = { mode: 'lite', source: 'workspace' };

describe('Ponytail runtime policy state', () => {
  it('marks activation only for the exact bundled primary skill and invalidates on policy change', () => {
    const ledger = new PonytailActivationLedger();
    expect(ledger.state(context, full).primarySkillLoaded).toBe(false);
    expect(ledger.markPrimaryLoaded(context, full, 'workspace-agents-skills/ponytail').primarySkillLoaded).toBe(false);
    expect(ledger.markPrimaryLoaded(context, full, BUNDLED_PONYTAIL_SKILL_ID).primarySkillLoaded).toBe(true);
    expect(ledger.state(context, lite)).toMatchObject({ primarySkillLoaded: false, policyFingerprint: 'workspace:lite' });
  });

  it('tracks mutation and review freshness by generation', () => {
    const ledger = new PonytailActivationLedger();
    ledger.markPrimaryLoaded(context, full, BUNDLED_PONYTAIL_SKILL_ID);
    expect(ledger.recordCodeMutation(context, full)).toMatchObject({ codeMutationGeneration: 1, reviewGeneration: 0 });
    expect(ledger.markReviewComplete(context, full).reviewGeneration).toBe(0);
    ledger.markReviewSkillLoaded(context, full, BUNDLED_PONYTAIL_REVIEW_SKILL_ID);
    expect(ledger.markReviewComplete(context, full).reviewGeneration).toBe(1);
    expect(ledger.recordCodeMutation(context, full)).toMatchObject({ codeMutationGeneration: 2, reviewGeneration: 1 });
  });

  it('preserves explicit session suppression when the policy fingerprint changes', () => {
    const ledger = new PonytailActivationLedger();
    ledger.setSessionSuppressed(context, full, true);
    expect(ledger.state(context, lite).sessionSuppressed).toBe(true);
  });
});

describe('Ponytail coding mutation classification', () => {
  it('recognizes source and tooling artifacts while excluding docs-only edits', () => {
    for (const file of ['src/app.ts', 'src/view.tsx', 'server.py', 'package.json', 'tsconfig.build.json', 'vite.config.ts', 'Dockerfile']) {
      expect(isDevelopmentArtifactPath(file), file).toBe(true);
    }
    for (const file of ['README.md', 'notes.txt', 'public/logo.png', 'docs/manual.pdf']) {
      expect(isDevelopmentArtifactPath(file), file).toBe(false);
    }
  });

  it('classifies central file/refactor mutations conservatively', () => {
    expect(isCodingMutation('write_file', { path: 'src/app.ts' })).toBe(true);
    expect(isCodingMutation('write_file', { path: 'README.md' })).toBe(false);
    expect(isCodingMutation('edit_file', { path: 'package.json' })).toBe(true);
    expect(isCodingMutation('apply_patch', { files: [{ path: 'docs/a.md' }, { path: 'src/a.ts' }] })).toBe(true);
    expect(isCodingMutation('move_file', { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' })).toBe(true);
    expect(isCodingMutation('lsp_rename', { workspaceId: 'workspace-1' })).toBe(true);
    expect(isCodingMutation('project_build', { workspaceId: 'workspace-1' })).toBe(false);
  });
});
