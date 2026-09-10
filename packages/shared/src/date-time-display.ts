export type DisplayDateTimeLocale = 'th' | 'en';

export interface DisplayDateTimeOptions {
  readonly fallback?: string;
  /** Primarily for deterministic tests; Thai UI intentionally remains pinned to Asia/Bangkok. */
  readonly timeZone?: string;
}

const THAI_DISPLAY_TIME_ZONE = 'Asia/Bangkok';
const EXACT_OFFSET_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Format one absolute instant for human-facing lnwjud UI/export text.
 *
 * Storage, audit, protocol, deadline and ordering values must stay as their
 * canonical absolute timestamps. This function is presentation-only.
 */
export function formatDisplayDateTime(
  value: string | number | Date | null | undefined,
  locale: DisplayDateTimeLocale,
  options: DisplayDateTimeOptions = {},
): string {
  const fallback = options.fallback ?? '—';
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : fallback;

  const thai = locale === 'th';
  const formatter = new Intl.DateTimeFormat(thai ? 'en-GB-u-ca-gregory-nu-latn' : 'en-US-u-ca-gregory-nu-latn', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: thai ? THAI_DISPLAY_TIME_ZONE : options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: thai ? 'h23' : 'h12',
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const datePart = `${requiredPart(parts, 'day')}-${requiredPart(parts, 'month')}-${requiredPart(parts, 'year')}`;
  const timePart = `${requiredPart(parts, 'hour')}:${requiredPart(parts, 'minute')}:${requiredPart(parts, 'second')}`;
  if (thai) return `${datePart} ${timePart}`;
  return `${datePart} ${timePart} ${requiredPart(parts, 'dayPeriod').toUpperCase()}`;
}

/**
 * Localize an exact ISO timestamp value embedded in a flattened diagnostic
 * item such as `started_at=2026-09-09T05:23:22.224Z`. Arbitrary text and URLs
 * are intentionally left untouched so presentation cannot rewrite evidence.
 */
export function formatDisplayTimestampItem(
  item: string,
  locale: DisplayDateTimeLocale,
  options: DisplayDateTimeOptions = {},
): string {
  const separator = item.indexOf('=');
  if (separator < 0) {
    return EXACT_OFFSET_ISO_TIMESTAMP.test(item)
      ? formatDisplayDateTime(item, locale, { ...options, fallback: item })
      : item;
  }
  const key = item.slice(0, separator + 1);
  const value = item.slice(separator + 1);
  if (!EXACT_OFFSET_ISO_TIMESTAMP.test(value)) return item;
  return `${key}${formatDisplayDateTime(value, locale, { ...options, fallback: value })}`;
}

export function displayTimeZone(locale: DisplayDateTimeLocale): string | undefined {
  return locale === 'th' ? THAI_DISPLAY_TIME_ZONE : undefined;
}

function requiredPart(parts: ReadonlyMap<string, string>, name: string): string {
  const value = parts.get(name);
  if (value === undefined || value.length === 0) throw new Error(`Intl.DateTimeFormat omitted required ${name} part`);
  return value;
}
