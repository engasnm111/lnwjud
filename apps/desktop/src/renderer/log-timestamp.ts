import { formatDateTime } from './date-time.js';

export function formatLogUiTime(value: string): string {
  return formatDateTime(value, value);
}

export function formatLogExportDateTime(value: string): string {
  return formatDateTime(value, value);
}
