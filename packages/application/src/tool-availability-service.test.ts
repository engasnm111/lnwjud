import { describe, expect, it, vi } from 'vitest';
import { USER_SETTING_KEYS } from '@lnwjud/shared';
import { ToolAvailabilityService } from './tool-availability-service.js';

class MemorySettings {
  readonly values = new Map<string, string>();
  get(key: string): string | null { return this.values.get(key) ?? null; }
  set(key: string, value: string): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

describe('ToolAvailabilityService', () => {
  it('persists explicit overrides with monotonic generation and keeps idempotent writes quiet', () => {
    const settings = new MemorySettings();
    const service = new ToolAvailabilityService(settings);
    const listener = vi.fn();
    service.subscribe(listener);

    expect(service.snapshot()).toEqual({ version: 1, generation: 0, overrides: {} });
    expect(service.setToolEnabled('git', false)).toEqual({ version: 1, generation: 1, overrides: { git: 'disabled' } });
    expect(service.setToolEnabled('git', false)).toEqual({ version: 1, generation: 1, overrides: { git: 'disabled' } });
    expect(service.setToolEnabled('git', true)).toEqual({ version: 1, generation: 2, overrides: { git: 'enabled' } });
    expect(service.resetTool('git')).toEqual({ version: 1, generation: 3, overrides: {} });
    expect(service.resetTool('git')).toEqual({ version: 1, generation: 3, overrides: {} });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(settings.get(USER_SETTING_KEYS.toolAvailability)).toContain('"generation":3');
  });

  it('preserves unknown override keys and refreshes external cross-process writes only when state changes', () => {
    const settings = new MemorySettings();
    settings.set(USER_SETTING_KEYS.toolAvailability, JSON.stringify({
      version: 1,
      generation: 4,
      overrides: { future_tool: 'disabled' },
    }));
    const service = new ToolAvailabilityService(settings);
    const listener = vi.fn();
    service.subscribe(listener);

    expect(service.snapshot()).toMatchObject({ generation: 4, overrides: { future_tool: 'disabled' } });
    expect(service.refreshFromStore()).toBe(false);
    settings.set(USER_SETTING_KEYS.toolAvailability, JSON.stringify({
      version: 1,
      generation: 5,
      overrides: { future_tool: 'disabled', read_file: 'disabled' },
    }));
    expect(service.refreshFromStore()).toBe(true);
    expect(service.snapshot()).toMatchObject({ generation: 5, overrides: { future_tool: 'disabled', read_file: 'disabled' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('provides a bounded unrefd watcher that can be stopped cleanly', () => {
    vi.useFakeTimers();
    const settings = new MemorySettings();
    const service = new ToolAvailabilityService(settings);
    const listener = vi.fn();
    service.subscribe(listener);
    const stop = service.watch(250);
    settings.set(USER_SETTING_KEYS.toolAvailability, JSON.stringify({ version: 1, generation: 1, overrides: { git: 'disabled' } }));
    vi.advanceTimersByTime(250);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    settings.set(USER_SETTING_KEYS.toolAvailability, JSON.stringify({ version: 1, generation: 2, overrides: { git: 'enabled' } }));
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
