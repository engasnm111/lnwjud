import { describe, expect, it } from 'vitest';

import { DEFAULT_RECOVERY_RETENTION_DAYS, parseIntegerSetting } from './user-settings.js';

describe('recovery retention defaults', () => {
  it('uses 30 days only when retention has never been configured', () => {
    const missingStoredValue: string | null = null;
    expect(parseIntegerSetting(missingStoredValue ?? undefined, DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(30);
    expect(parseIntegerSetting('0', DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(0);
    expect(parseIntegerSetting('90', DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(90);
  });
});
