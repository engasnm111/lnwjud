import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scheduled continuation skill contract', () => {
  it('documents adaptive autonomous continuation through verified terminal goal closure', async () => {
    const skill = await readFile(
      path.resolve(import.meta.dirname, '../../../.agents/skills/lnwjud-scheduled-continuation/SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(/description: Use when/);
    expect(skill).toContain('2–25 minutes');
    expect(skill).toContain('600 seconds (10 minutes)');
    expect(skill).toContain('derives the successor from the current durable-goal lease');
    expect(skill).toContain('4 → 8 → 16 → 25 minutes');
    expect(skill).toContain('do not hard-code +2');
    expect(skill).toContain('120 seconds early');
    expect(skill).toContain('safety invariants');
    expect(skill).toContain('still-pending future');
    expect(skill).toContain('fired is consumed transport identity');
    expect(skill).toContain('fresh adaptive successor');
    expect(skill).toContain('A request to stop scheduling cancels only the successor');
    expect(skill).toContain('Never send a completion report while `get_goal` reports `active`');
    expect(skill).toContain('`run_goal` defaults to `scheduledContinuation: auto`');
    expect(skill).toContain('the client MUST apply this skill automatically');
    expect(skill).toContain('never require another user prompt to resume an unfinished goal');
    expect(skill).toContain('wait for every active task ID to reach a terminal state');
    expect(skill).toContain('finish_goal');
    expect(skill).toContain('reschedule_required');
    expect(skill).toContain('runsOn: cloud');
    expect(skill).toContain('runsOn: unverified');
    expect(skill).toContain('browser/DOM automation');
    expect(skill).toContain('native ChatGPT Scheduled Task host tool/API surface');
    expect(skill).toContain('exactly as it is exposed by the current ChatGPT host/tool registry');
    expect(skill).toContain('Do **not** assume, invent, or hard-code an internal host tool/resource name');
    expect(skill).toContain('immediately call `record_scheduled_continuation_receipt(outcome: create_failed)`');
    expect(skill).not.toContain('Automations.create');
    expect(skill).not.toContain('Automations.update');
    expect(skill).toContain('Explicitly confirmed `local`');
    expect(skill).toContain('`prepared` means **reservation only**');
    expect(skill).toContain('never a confirmed successor');
    expect(skill).toContain('may keep doing useful fenced work while native-task creation is retried');
    expect(skill).toContain('explicit IANA `TZID`');
    expect(skill).toContain('`status: scheduled`, a non-empty `nativeTaskId`, and `confirmedRunsOn: cloud|unverified`');
    expect(skill).toContain('Do **not** call `prepare_scheduled_continuation` again');
    expect(skill).toContain('returned `scheduleRequest`');
    expect(skill).toContain('`successor_required`');
    expect(skill).toContain('expedite_scheduled_continuation');
    expect(skill).toContain('goalLease');
    expect(skill).toContain('orphan_recovered');
    expect(skill).toContain('native host deletion receipt');
    expect(skill).toContain('record_scheduled_continuation_receipt(outcome: consumed)');
    expect(skill).toContain('does **not** mean the goal work completed');
    expect(skill).toContain('Never report cancellation as successful');
    expect(skill).not.toMatch(/Windows Task Scheduler as fallback/i);
  });
});
