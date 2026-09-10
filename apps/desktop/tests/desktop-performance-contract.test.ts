import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop performance contract', () => {
  it('keeps the main renderer refresh single-flight and below the old 1 Hz pressure', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (refreshBusyRef.current) return;');
    expect(source).toContain('window.setInterval(() => { void refresh(); }, 2_000)');
    expect(source).not.toContain('window.setInterval(() => { void refresh(); }, 1_000)');
  });

  it('batches pushed log events instead of copying a 30k-line React state array for every line', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const viewer = readFileSync(new URL('../src/renderer/features/live/StandaloneLogViewer.tsx', import.meta.url), 'utf8');
    for (const source of [app, viewer]) {
      expect(source).toContain('pendingLogLines.current.push(line);');
      expect(source).toContain('window.setTimeout(flushPendingLogLines, 40)');
      expect(source).toContain('appendLogBatch(previous, batch, MAX_CLIENT_LOG_LINES)');
      expect(source).toContain('rememberLogId(logIds.current, line.id, MAX_CLIENT_LOG_LINES * 2)');
      expect(source).not.toContain('setLogLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line])');
      expect(source).not.toContain('setLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line])');
    }
  });

  it('does not wake the full dashboard from the standalone live-log viewer', () => {
    const source = readFileSync(new URL('../src/renderer/features/live/StandaloneLogViewer.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('window.setInterval');
  });

  it('caches expensive dashboard probes and shares the WSL availability probe', () => {
    const desktop = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const capabilities = readFileSync(new URL('../../../packages/capabilities/src/platform-capability-set.ts', import.meta.url), 'utf8');

    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['gitSummary']>(5_000)");
    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['codex']>(60_000)");
    expect(desktop).toContain("new AsyncTtlCache<DashboardSnapshot['capabilities']>(15_000)");
    expect(capabilities).toContain('const wslAvailabilityCache = new AsyncTtlCache<import(\'@lnwjud/domain\').Result<unknown>>(15_000);');
    expect(capabilities).toContain('wslAvailabilityCache.get(async () =>');
  });
});
