import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scheduled continuation skill contract', () => {
  it('documents one hourly recurring native watchdog through verified terminal cleanup', async () => {
    const skill = await readFile(
      path.resolve(import.meta.dirname, '../../../.agents/skills/lnwjud-scheduled-continuation/SKILL.md'),
      'utf8',
    );

    expect(skill).toMatch(/description: Use when/);
    expect(skill).toContain('hourly recurring');
    expect(skill).toContain('intervalMinutes=60');
    expect(skill).toContain('600 seconds');
    expect(skill).toContain('Recurring cadence: **60 minutes**');
    expect(skill).toContain('independent of the worker lease');
    expect(skill).toContain('first fires in 60 minutes');
    expect(skill).toContain('2–25 minute range');
    expect(skill).toContain('changes only the **first firing**');
    expect(skill).toContain('never create a successor');
    expect(skill).toContain('never retime the recurring cadence');
    expect(skill).toContain('One recurring firing never consumes the native task');
    expect(skill).toContain('historical `occurrence=once` compatibility paths only');
    expect(skill).toContain('Never create a recurring watchdog while a confirmed live one-time watchdog');

    expect(skill).toContain('`claim_scheduled_continuation` must be the **first connected lnwjud action');
    expect(skill).toContain('`recurring_acquired`');
    expect(skill).toContain('`worker_busy_noop`');
    expect(skill).toContain('`orphan_probe_noop`');
    expect(skill).toContain('`already_claimed`');
    expect(skill).toContain('`receipt_required`');
    expect(skill).toContain('`terminal_cleanup_required`');
    expect(skill).toContain('**cleanup only**');
    expect(skill).toContain('Do not resume goal work');
    expect(skill).toContain('`terminal_noop`');
    expect(skill).toContain('`expedite_scheduled_continuation` is **one-time compatibility only**');

    expect(skill).toContain('scheduledContinuation:auto');
    expect(skill).toContain('Never require the user to type');
    expect(skill).toContain('Never report completion while `get_goal` is `active`');
    expect(skill).toContain('Native task create/update/delete/disable is host-owned');
    expect(skill).toContain('never invent or hard-code an internal operation name');
    expect(skill).toContain('Resource not found');
    expect(skill).toContain('re-resolve the Native Scheduled Task operation once');
    expect(skill).toContain('Do not retry an ambiguous possible-success');
    expect(skill).toContain('scheduler degradation only');
    expect(skill).toContain('runsOn: cloud');
    expect(skill).toContain('runsOn: unverified');
    expect(skill).toContain('explicit IANA `TZID`');
    expect(skill).toContain('releaseLease:true');
    expect(skill).toContain('A checkpoint is not a turn boundary');
    expect(skill).toContain('Work-conserving worker behavior');
    expect(skill).toContain('One failed poll never justifies abandoning the task');
    expect(skill).toContain('inspect its terminal result in the same turn');
    expect(skill).toContain('Never deliberately wait for lease expiry as a continuation strategy');
    expect(skill).toContain('Yield only when the goal is terminal');
    expect(skill).toContain('Do not promise or target a fixed 22/25-minute runtime');
    expect(skill).toContain('two-probe');
    expect(skill).toContain('Full Bypass never bypasses durable-goal ownership fences');

    expect(skill).toContain('Make the exact recurring native task non-runnable');
    expect(skill).toContain('host-confirmed delete or disable evidence');
    expect(skill).toContain('A recurring run receipt is **not** cleanup proof');
    expect(skill).toContain('finish_goal(status:completed)');
    expect(skill).toContain('completionState=completed');
    expect(skill).toContain('get_goal` confirms a terminal status');

    expect(skill).toContain('lnwjud `scheduler`');
    expect(skill).toContain('Windows Task Scheduler');
    expect(skill).toContain('cron');
    expect(skill).toContain('browser/DOM automation');
    expect(skill).not.toMatch(/Automations(?:\.|:)/i);
  });
});
