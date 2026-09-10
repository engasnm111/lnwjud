import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PONYTAIL_MODE,
  normalizeProjectProfile,
  parsePonytailMode,
  resolvePonytailPolicy,
  workspacePonytailMode,
} from './ponytail-policy.js';

describe('Ponytail policy', () => {
  it('defaults global mode to off and fails invalid values safely', () => {
    expect(DEFAULT_PONYTAIL_MODE).toBe('off');
    expect(parsePonytailMode(undefined)).toBe('off');
    expect(parsePonytailMode('ultra')).toBe('ultra');
    expect(parsePonytailMode('surprise')).toBe('off');
  });

  it('reads only the supported workspace project-profile override', () => {
    expect(workspacePonytailMode(null)).toBe('inherit');
    expect(workspacePonytailMode({ ponytail: { mode: 'full' } })).toBe('full');
    expect(workspacePonytailMode({ ponytail: { mode: 'inherit' } })).toBe('inherit');
    expect(workspacePonytailMode({ ponytail: { mode: 'invalid' } })).toBe('inherit');
  });

  it('resolves goal over workspace over global', () => {
    expect(resolvePonytailPolicy('off')).toEqual({ mode: 'off', source: 'global' });
    expect(resolvePonytailPolicy('full', 'lite')).toEqual({ mode: 'lite', source: 'workspace' });
    expect(resolvePonytailPolicy('full', 'off')).toEqual({ mode: 'off', source: 'workspace' });
    expect(resolvePonytailPolicy('lite', 'ultra', 'full')).toEqual({ mode: 'full', source: 'goal' });
    expect(resolvePonytailPolicy('off', 'full', 'ultra')).toEqual({ mode: 'ultra', source: 'goal' });
  });

  it('normalizes safe project profiles while preserving unrelated settings', () => {
    expect(normalizeProjectProfile({
      ponytail: { mode: 'full' },
      project: { language: 'typescript', tags: ['desktop', 'mcp'] },
    })).toEqual({
      ponytail: { mode: 'full' },
      project: { language: 'typescript', tags: ['desktop', 'mcp'] },
    });
  });

  it('rejects malformed Ponytail overrides and secret-bearing project profile fields', () => {
    expect(() => normalizeProjectProfile({ ponytail: { mode: 'maximum' } })).toThrow(/ponytail\.mode/i);
    expect(() => normalizeProjectProfile({ project: { apiKey: 'must-not-persist' } })).toThrow(/secret-bearing field/i);
    expect(() => normalizeProjectProfile({ credentials: { user: 'demo' } })).toThrow(/secret-bearing field/i);
  });
});
