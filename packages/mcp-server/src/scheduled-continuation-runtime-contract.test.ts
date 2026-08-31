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
  it('publishes all five scheduling tools with adaptive one-time cloud handoff semantics', () => {
    const registry = new ToolRegistry({}, actor);
    const tools = new Map(registry.list().map((tool) => [tool.name, tool]));
    for (const name of required) expect(tools.has(name), name).toBe(true);
    expect(tools.has('run_goal')).toBe(true);
    expect(tools.has('checkpoint_goal')).toBe(true);

    const serialized = required.map((name) => `${name}:${tools.get(name)?.description ?? ''}`).join('\n');
    expect(serialized).toContain('adaptive');
    expect(serialized).toContain('2 and 25 minutes');
    expect(serialized).toContain('120 seconds early');
    expect(serialized).toContain('cloud');
    expect(serialized).toContain('same');
    expect(serialized).not.toMatch(/RRULE|recurr|schtasks|executable|shell command/i);
  });
});
