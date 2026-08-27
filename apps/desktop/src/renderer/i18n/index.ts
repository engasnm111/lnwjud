import type { UiLocale } from '@lnwjud/ipc-contracts';
import { en, th, type MessageKey, type Messages } from './messages.js';
import { unrestrictedSafetyBoundaryCopy } from './safety-boundary-copy.js';

const catalogs: Record<UiLocale, Messages> = { th, en };

export function createTranslator(locale: UiLocale): (key: MessageKey) => string {
  const catalog = catalogs[locale] ?? th;
  return (key: MessageKey): string => key === 'settings.unrestrictedHint'
    ? unrestrictedSafetyBoundaryCopy(locale)
    : catalog[key] ?? en[key] ?? key;
}
