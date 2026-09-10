export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra';
export type PonytailModeOverride = 'inherit' | PonytailMode;
export type PonytailPolicySource = 'global' | 'workspace' | 'goal';

export const DEFAULT_PONYTAIL_MODE: PonytailMode = 'off';

export interface ResolvedPonytailPolicy {
  readonly mode: PonytailMode;
  readonly source: PonytailPolicySource;
}

export function parsePonytailMode(value: unknown, fallback: PonytailMode = DEFAULT_PONYTAIL_MODE): PonytailMode {
  return value === 'off' || value === 'lite' || value === 'full' || value === 'ultra' ? value : fallback;
}

export function parsePonytailModeOverride(value: unknown): PonytailModeOverride {
  return value === 'off' || value === 'lite' || value === 'full' || value === 'ultra' ? value : 'inherit';
}

export function workspacePonytailMode(profile: unknown): PonytailModeOverride {
  if (!isRecord(profile) || !isRecord(profile.ponytail)) return 'inherit';
  return parsePonytailModeOverride(profile.ponytail.mode);
}

export function normalizeProjectProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeProjectProfileValue(profile, 0) as Record<string, unknown>;
  if (normalized.ponytail !== undefined) {
    if (!isRecord(normalized.ponytail)) throw new Error('Project profile ponytail must be an object');
    const mode = normalized.ponytail.mode;
    if (mode !== undefined && mode !== 'off' && mode !== 'lite' && mode !== 'full' && mode !== 'ultra') {
      throw new Error('Project profile ponytail.mode must be off, lite, full, or ultra');
    }
  }
  return normalized;
}

export function resolvePonytailPolicy(
  globalMode: PonytailMode,
  workspaceMode: PonytailModeOverride = 'inherit',
  goalMode: PonytailModeOverride = 'inherit',
): ResolvedPonytailPolicy {
  if (goalMode !== 'inherit') return { mode: goalMode, source: 'goal' };
  if (workspaceMode !== 'inherit') return { mode: workspaceMode, source: 'workspace' };
  return { mode: globalMode, source: 'global' };
}

function normalizeProjectProfileValue(value: unknown, depth: number): unknown {
  if (depth > 8) throw new Error('Project profile nesting exceeds 8 levels');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > 16_384) throw new Error('Project profile string values are too large');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Project profile numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error('Project profile arrays may contain at most 256 items');
    return value.map((entry) => normalizeProjectProfileValue(entry, depth + 1));
  }
  if (!isRecord(value)) throw new Error('Project profile values must be JSON-compatible');
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error('Project profile objects may contain at most 256 keys');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 128) throw new Error('Project profile keys must be 1-128 characters');
    if (/(token|secret|password|api[_-]?key|private[_-]?key|authorization|credential)/i.test(key)) {
      throw new Error(`Project profile must not persist secret-bearing field: ${key}`);
    }
    result[key] = normalizeProjectProfileValue(entry, depth + 1);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
