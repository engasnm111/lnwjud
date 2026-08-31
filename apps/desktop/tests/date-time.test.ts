import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../src/renderer/date-time.js';

describe('desktop date/time formatting', () => {
  it('uses DD-MM-YYYY HH:mm:ss in the local timezone', () => {
    const date = new Date(2026, 7, 29, 18, 7, 6, 999);
    expect(formatDateTime(date)).toBe('29-08-2026 18:07:06');
  });

  it('preserves invalid source text instead of fabricating a date', () => {
    expect(formatDateTime('not-a-date', 'fallback')).toBe('not-a-date');
  });

  it('uses the supplied fallback when no timestamp exists', () => {
    expect(formatDateTime(null, 'not checked')).toBe('not checked');
  });
});
