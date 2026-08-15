import { describe, expect, it } from 'vitest';
import { isUnrestricted, unrestrictedFromEnv, unrestrictedFromSetting, UNRESTRICTED_SETTING_KEY } from './unrestricted.js';

describe('unrestrictedFromSetting', () => {
  it('accepts common truthy values', () => {
    expect(unrestrictedFromSetting('1')).toBe(true);
    expect(unrestrictedFromSetting('true')).toBe(true);
    expect(unrestrictedFromSetting('TRUE')).toBe(true);
    expect(unrestrictedFromSetting('on')).toBe(true);
    expect(unrestrictedFromSetting(' yes ')).toBe(true);
  });

  it('rejects falsy and missing values', () => {
    expect(unrestrictedFromSetting('0')).toBe(false);
    expect(unrestrictedFromSetting('false')).toBe(false);
    expect(unrestrictedFromSetting('')).toBe(false);
    expect(unrestrictedFromSetting(null)).toBe(false);
    expect(unrestrictedFromSetting(undefined)).toBe(false);
  });
});

describe('unrestrictedFromEnv', () => {
  it('reads LNWJUD_UNRESTRICTED', () => {
    expect(unrestrictedFromEnv({ LNWJUD_UNRESTRICTED: '1' })).toBe(true);
    expect(unrestrictedFromEnv({ LNWJUD_UNRESTRICTED: 'true' })).toBe(true);
    expect(unrestrictedFromEnv({ LNWJUD_UNRESTRICTED: '0' })).toBe(false);
    expect(unrestrictedFromEnv({})).toBe(false);
  });
});

describe('isUnrestricted', () => {
  it('is true when either env or settings enables it', () => {
    expect(isUnrestricted({}, settingsValueFor(true))).toBe(true);
    expect(isUnrestricted({ LNWJUD_UNRESTRICTED: '1' }, null)).toBe(true);
    expect(isUnrestricted({}, null)).toBe(false);
  });

  it('exposes a stable settings key', () => {
    expect(UNRESTRICTED_SETTING_KEY).toBe('unrestricted_mode');
  });
});

function settingsValueFor(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}
