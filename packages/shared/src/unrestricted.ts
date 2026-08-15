export const UNRESTRICTED_SETTING_KEY = 'unrestricted_mode';

export type ProcessEnvLike = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function unrestrictedFromEnv(env: ProcessEnvLike = process.env): boolean {
  return unrestrictedFromSetting(env.LNWJUD_UNRESTRICTED);
}

export function unrestrictedFromSetting(value: string | null | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

export function isUnrestricted(env: ProcessEnvLike, settingValue: string | null | undefined): boolean {
  return unrestrictedFromEnv(env) || unrestrictedFromSetting(settingValue);
}
