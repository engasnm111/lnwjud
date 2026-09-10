import type { UiLocale } from '@lnwjud/ipc-contracts';
import { formatDateTime } from './date-time.js';

export function formatLogUiTime(value: string, locale: UiLocale = 'th'): string {
  return formatDateTime(value, value, locale);
}

export function formatLogExportDateTime(value: string, locale: UiLocale = 'th'): string {
  return formatDateTime(value, value, locale);
}
