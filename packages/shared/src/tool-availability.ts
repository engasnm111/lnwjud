export type ToolUserPreference = 'default' | 'enabled' | 'disabled';
export type ToolAvailabilityOverride = Exclude<ToolUserPreference, 'default'>;
export type ToolAvailabilityReason = 'enabled' | 'user_disabled' | 'system_ineligible';

export interface ToolAvailabilitySnapshot {
  readonly version: 1;
  readonly generation: number;
  readonly overrides: Readonly<Record<string, ToolAvailabilityOverride>>;
}

export interface EffectiveToolAvailability {
  readonly name: string;
  readonly systemEligible: boolean;
  readonly userPreference: ToolUserPreference;
  readonly effectiveExposed: boolean;
  readonly reason: ToolAvailabilityReason;
}

export const DEFAULT_TOOL_AVAILABILITY_SNAPSHOT: ToolAvailabilitySnapshot = Object.freeze({
  version: 1,
  generation: 0,
  overrides: Object.freeze({}),
});

export function parseToolAvailabilitySnapshot(value: string | null | undefined): ToolAvailabilitySnapshot {
  if (value === null || value === undefined || value.trim().length === 0) return DEFAULT_TOOL_AVAILABILITY_SNAPSHOT;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !Number.isInteger(parsed.generation) || (parsed.generation as number) < 0 || !isRecord(parsed.overrides)) {
      return DEFAULT_TOOL_AVAILABILITY_SNAPSHOT;
    }
    const overrides: Record<string, ToolAvailabilityOverride> = {};
    for (const [name, preference] of Object.entries(parsed.overrides)) {
      if (name.trim().length === 0) continue;
      if (preference === 'enabled' || preference === 'disabled') overrides[name] = preference;
    }
    return Object.freeze({
      version: 1,
      generation: parsed.generation as number,
      overrides: Object.freeze(overrides),
    });
  } catch {
    return DEFAULT_TOOL_AVAILABILITY_SNAPSHOT;
  }
}

export function serializeToolAvailabilitySnapshot(snapshot: ToolAvailabilitySnapshot): string {
  const overrides = Object.fromEntries(
    Object.entries(snapshot.overrides)
      .filter(([, preference]) => preference === 'enabled' || preference === 'disabled')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({ version: 1, generation: Math.max(0, Math.trunc(snapshot.generation)), overrides });
}

export function toolUserPreference(snapshot: ToolAvailabilitySnapshot, name: string): ToolUserPreference {
  return snapshot.overrides[name] ?? 'default';
}

export function resolveEffectiveToolAvailability(input: {
  readonly name: string;
  readonly snapshot: ToolAvailabilitySnapshot;
  readonly systemEligible: boolean;
  readonly defaultEnabled: boolean;
}): EffectiveToolAvailability {
  const userPreference = toolUserPreference(input.snapshot, input.name);
  if (!input.systemEligible) {
    return {
      name: input.name,
      systemEligible: false,
      userPreference,
      effectiveExposed: false,
      reason: 'system_ineligible',
    };
  }
  const effectiveExposed = userPreference === 'enabled'
    ? true
    : userPreference === 'disabled'
      ? false
      : input.defaultEnabled;
  return {
    name: input.name,
    systemEligible: true,
    userPreference,
    effectiveExposed,
    reason: effectiveExposed ? 'enabled' : 'user_disabled',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
