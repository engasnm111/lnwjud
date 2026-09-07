import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../src/renderer/date-time.js';

describe('desktop date/time formatting', () => {
  it('uses DD-MM-YYYY HH:mm:ss in the local timezone', () => {
    const date = new Date(2026, 7, 29, 18, 7, 6, 999);
    expect(formatDateTime(date)).toBe('29-08-2026 18:07:06');
  });

  it('converts canonical UTC timestamps to the actual local timezone without a hard-coded offset', () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Bangkok';
      expect(formatDateTime('2026-09-07T19:00:00.000Z')).toBe('08-09-2026 02:00:00');
      process.env.TZ = 'America/New_York';
      expect(formatDateTime('2026-09-07T19:00:00.000Z')).toBe('07-09-2026 15:00:00');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('uses the host timezone rules across DST instead of applying a fixed numeric offset', () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(formatDateTime('2026-03-08T06:30:00.000Z')).toBe('08-03-2026 01:30:00');
      expect(formatDateTime('2026-03-08T07:30:00.000Z')).toBe('08-03-2026 03:30:00');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('preserves invalid source text instead of fabricating a date', () => {
    expect(formatDateTime('not-a-date', 'fallback')).toBe('not-a-date');
  });

  it('uses the supplied fallback when no timestamp exists', () => {
    expect(formatDateTime(null, 'not checked')).toBe('not checked');
  });
});
