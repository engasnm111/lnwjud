import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scheduled continuation skill contract', () => {
  it('documents adaptive autonomous continuation through verified terminal goal closure', async () => {
    const skill = await readFile(path.resolve(process.cwd(), '../../.agents/skills/lnwjud-scheduled-continuation/SKILL.md'), 'utf8');
    expect(skill).toMatch(/description: Use when/);
    expect(skill).toContain('2–25 minutes');
    expect(skill).toContain('The API default is deliberately **2 minutes** as a fail-safe');
    expect(skill).toContain('25 minutes is the maximum watchdog, not the default handoff');
    expect(skill).toContain('use +2 because there will be no live worker after the turn');
    expect(skill).toContain('A request to stop scheduling cancels only the successor');
    expect(skill).toContain('Never send a completion report while `get_goal` reports `active`');
    expect(skill).toContain('`run_goal` defaults to `scheduledContinuation: auto`');
    expect(skill).toContain('the client MUST apply this skill automatically');
    expect(skill).toContain('never require another user prompt to resume an unfinished goal');
    expect(skill).toContain('wait for every active task ID to reach a terminal state');
    expect(skill).toContain('finish_goal');
    expect(skill).toContain('same native task');
    expect(skill).toContain('+2 minutes');
    expect(skill).toContain('successor_required');
    expect(skill).toContain('fresh disposable +2-minute successor ticket');
    expect(skill).toContain('must not be reused');
    expect(skill).toContain('runsOn: cloud');
    expect(skill).toContain('claim_scheduled_continuation');
    expect(skill).toContain('expedite_scheduled_continuation');
    expect(skill).toContain('goalLease');
    expect(skill).toContain('orphan_recovered');
    expect(skill).toContain('cancel');
    expect(skill).toContain('native host deletion receipt');
    expect(skill).toContain('record_scheduled_continuation_receipt(outcome: consumed)');
    expect(skill).toContain('does **not** mean the goal work completed');
    expect(skill).toContain('Never report cancellation as successful');
    expect(skill).not.toMatch(/due \*\*25 minutes\*\* later|successor due T\+25/);
    expect(skill).not.toMatch(/retry_prepared|Windows Task Scheduler as fallback/i);
  });
});
