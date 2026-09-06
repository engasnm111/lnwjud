import {
  DEFAULT_TOOL_AVAILABILITY_SNAPSHOT,
  USER_SETTING_KEYS,
  parseToolAvailabilitySnapshot,
  serializeToolAvailabilitySnapshot,
  type ToolAvailabilityOverride,
  type ToolAvailabilitySnapshot,
} from '@lnwjud/shared';

export interface ToolAvailabilitySettingsPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete?(key: string): void;
}

export type ToolAvailabilityListener = (snapshot: ToolAvailabilitySnapshot) => void;

export class ToolAvailabilityService {
  private current: ToolAvailabilitySnapshot;
  private readonly listeners = new Set<ToolAvailabilityListener>();

  public constructor(private readonly settings: ToolAvailabilitySettingsPort) {
    this.current = parseToolAvailabilitySnapshot(settings.get(USER_SETTING_KEYS.toolAvailability));
  }

  public snapshot(): ToolAvailabilitySnapshot {
    return this.current;
  }

  public subscribe(listener: ToolAvailabilityListener): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  public setToolEnabled(name: string, enabled: boolean): ToolAvailabilitySnapshot {
    const normalizedName = normalizeToolName(name);
    const preference: ToolAvailabilityOverride = enabled ? 'enabled' : 'disabled';
    if (this.current.overrides[normalizedName] === preference) return this.current;
    return this.persist({ ...this.current.overrides, [normalizedName]: preference });
  }

  public resetTool(name: string): ToolAvailabilitySnapshot {
    const normalizedName = normalizeToolName(name);
    if (!(normalizedName in this.current.overrides)) return this.current;
    const overrides = { ...this.current.overrides };
    delete overrides[normalizedName];
    return this.persist(overrides);
  }

  public resetAll(): ToolAvailabilitySnapshot {
    if (Object.keys(this.current.overrides).length === 0) return this.current;
    return this.persist({});
  }

  public refreshFromStore(): boolean {
    const next = parseToolAvailabilitySnapshot(this.settings.get(USER_SETTING_KEYS.toolAvailability));
    if (sameSnapshot(this.current, next)) return false;
    this.current = next;
    this.emit();
    return true;
  }

  public watch(intervalMs: number = 1_000): () => void {
    const normalizedInterval = Number.isFinite(intervalMs) ? Math.max(100, Math.trunc(intervalMs)) : 1_000;
    const timer = setInterval(() => { this.refreshFromStore(); }, normalizedInterval);
    timer.unref?.();
    return (): void => clearInterval(timer);
  }

  private persist(overrides: Readonly<Record<string, ToolAvailabilityOverride>>): ToolAvailabilitySnapshot {
    const next: ToolAvailabilitySnapshot = {
      version: 1,
      generation: this.current.generation + 1,
      overrides: Object.freeze({ ...overrides }),
    };
    this.settings.set(USER_SETTING_KEYS.toolAvailability, serializeToolAvailabilitySnapshot(next));
    this.current = next;
    this.emit();
    return next;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.current);
  }
}

function normalizeToolName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 256) throw new Error('Tool name is invalid');
  return normalized;
}

function sameSnapshot(left: ToolAvailabilitySnapshot, right: ToolAvailabilitySnapshot): boolean {
  if (left.version !== right.version || left.generation !== right.generation) return false;
  const leftEntries = Object.entries(left.overrides).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right.overrides).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export { DEFAULT_TOOL_AVAILABILITY_SNAPSHOT };
