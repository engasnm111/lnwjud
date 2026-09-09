import { describe, expect, it } from 'vitest';
import { formatDisplayDateTime, formatDisplayTimestampItem } from './date-time-display.js';

describe('shared display date/time contract', () => {
  it('always renders Thai UI time in Asia/Bangkok with Gregorian DD-MM-YYYY 24-hour time', () => {
    expect(formatDisplayDateTime('2026-09-09T05:23:22.224Z', 'th')).toBe('09-09-2026 12:23:22');
    expect(formatDisplayDateTime('2026-12-31T18:30:00.000Z', 'th')).toBe('01-01-2027 01:30:00');
  });

  it('renders English UI time with 12-hour AM/PM in the requested host timezone', () => {
    expect(formatDisplayDateTime('2026-09-09T05:23:22.224Z', 'en', { timeZone: 'America/New_York' })).toBe('09-09-2026 01:23:22 AM');
    expect(formatDisplayDateTime('2026-09-09T17:23:22.224Z', 'en', { timeZone: 'America/New_York' })).toBe('09-09-2026 01:23:22 PM');
  });

  it('uses real IANA timezone/DST rules instead of fixed offsets', () => {
    expect(formatDisplayDateTime('2026-03-08T06:30:00.000Z', 'en', { timeZone: 'America/New_York' })).toBe('08-03-2026 01:30:00 AM');
    expect(formatDisplayDateTime('2026-03-08T07:30:00.000Z', 'en', { timeZone: 'America/New_York' })).toBe('08-03-2026 03:30:00 AM');
  });

  it('localizes exact ISO timestamp values inside structured detail items without changing other diagnostic text', () => {
    expect(formatDisplayTimestampItem('started_at=2026-09-09T05:23:22.224Z', 'th')).toBe('started_at=09-09-2026 12:23:22');
    expect(formatDisplayTimestampItem('deadline_at=2026-09-09T05:24:22.224Z', 'en', { timeZone: 'Asia/Bangkok' })).toBe('deadline_at=09-09-2026 12:24:22 PM');
    expect(formatDisplayTimestampItem('status=running', 'th')).toBe('status=running');
    expect(formatDisplayTimestampItem('url=https://example.com/2026-09-09T05:23:22.224Z', 'th')).toBe('url=https://example.com/2026-09-09T05:23:22.224Z');
  });

  it('preserves invalid source text and supports an explicit fallback for missing values', () => {
    expect(formatDisplayDateTime('not-a-date', 'th', { fallback: 'fallback' })).toBe('not-a-date');
    expect(formatDisplayDateTime(null, 'th', { fallback: 'not checked' })).toBe('not checked');
  });
});
