import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_AVAILABILITY_SNAPSHOT,
  parseToolAvailabilitySnapshot,
  resolveEffectiveToolAvailability,
  serializeToolAvailabilitySnapshot,
  toolUserPreference,
} from './tool-availability.js';

describe('tool availability preferences', () => {
  it('defaults missing or corrupt settings to v4.53-compatible empty overrides', () => {
    expect(parseToolAvailabilitySnapshot(null)).toEqual(DEFAULT_TOOL_AVAILABILITY_SNAPSHOT);
    expect(parseToolAvailabilitySnapshot('')).toEqual(DEFAULT_TOOL_AVAILABILITY_SNAPSHOT);
    expect(parseToolAvailabilitySnapshot('{not-json')).toEqual(DEFAULT_TOOL_AVAILABILITY_SNAPSHOT);
    expect(parseToolAvailabilitySnapshot('{"version":2,"generation":99,"overrides":{"git":"disabled"}}'))
      .toEqual(DEFAULT_TOOL_AVAILABILITY_SNAPSHOT);
  });

  it('round-trips versioned generation and preserves valid unknown tool-name overrides', () => {
    const snapshot = parseToolAvailabilitySnapshot(JSON.stringify({
      version: 1,
      generation: 7,
      overrides: { git: 'disabled', future_tool: 'enabled', bad: 'maybe' },
    }));
    expect(snapshot).toEqual({ version: 1, generation: 7, overrides: { git: 'disabled', future_tool: 'enabled' } });
    expect(parseToolAvailabilitySnapshot(serializeToolAvailabilitySnapshot(snapshot))).toEqual(snapshot);
  });

  it('uses explicit overrides before group defaults while hard system eligibility always wins', () => {
    const snapshot = parseToolAvailabilitySnapshot(JSON.stringify({
      version: 1,
      generation: 2,
      overrides: { git: 'disabled', codex_run: 'enabled', unavailable_tool: 'enabled' },
    }));
    expect(toolUserPreference(snapshot, 'git')).toBe('disabled');
    expect(toolUserPreference(snapshot, 'read_file')).toBe('default');
    expect(resolveEffectiveToolAvailability({ name: 'git', snapshot, systemEligible: true, defaultEnabled: true }))
      .toMatchObject({ userPreference: 'disabled', effectiveExposed: false, reason: 'user_disabled' });
    expect(resolveEffectiveToolAvailability({ name: 'codex_run', snapshot, systemEligible: true, defaultEnabled: false }))
      .toMatchObject({ userPreference: 'enabled', effectiveExposed: true, reason: 'enabled' });
    expect(resolveEffectiveToolAvailability({ name: 'unavailable_tool', snapshot, systemEligible: false, defaultEnabled: true }))
      .toMatchObject({ userPreference: 'enabled', effectiveExposed: false, reason: 'system_ineligible' });
    expect(resolveEffectiveToolAvailability({ name: 'read_file', snapshot, systemEligible: true, defaultEnabled: true }))
      .toMatchObject({ userPreference: 'default', effectiveExposed: true, reason: 'enabled' });
  });
});
