import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry.js';

const actor = { clientId: 'runtime-contract', clientName: 'runtime-contract' };

const required = [
  'prepare_scheduled_continuation',
  'record_scheduled_continuation_receipt',
  'claim_scheduled_continuation',
  'get_scheduled_continuation',
  'expedite_scheduled_continuation',
] as const;

describe('scheduled continuation runtime contract', () => {
  it('publishes recurring-hourly scheduling semantics while retaining explicit one-time compatibility paths', () => {
    const registry = new ToolRegistry({}, actor);
    const tools = new Map(registry.list().map((tool) => [tool.name, tool]));
    for (const name of required) expect(tools.has(name), name).toBe(true);
    expect(tools.has('run_goal')).toBe(true);
    expect(tools.has('checkpoint_goal')).toBe(true);

    const serialized = required.map((name) => `${name}:${tools.get(name)?.description ?? ''}`).join('\n');
    expect(serialized).toContain('hourly recurring watchdog');
    expect(serialized).toContain('intervalMinutes=60');
    expect(serialized).toContain('worker_busy_noop');
    expect(serialized).toContain('recurring_acquired');
    expect(serialized).toContain('one-time compatibility');
    expect(serialized).toContain('cloud');
    expect(serialized).toContain('never create a per-wake successor');
    expect(serialized).toContain('never use browser/DOM automation, Windows Task Scheduler, cron, shell timers, or an lnwjud-local scheduler as a substitute');
  });
});
