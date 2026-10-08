import { describe, expect, it, vi } from 'vitest';
import { sampleOwnedProcessMetrics } from '../src/main/resource-process-metrics.js';

describe('owned Windows process metrics', () => {
  const launchedAt = '2026-10-08T20:00:00.000Z';
  const sample = { pid: 4321, started_at: launchedAt, working_set_bytes: 123_456_789, cpu_seconds: 40 };
  const options = { platform: 'win32' as const, now: (): number => Date.parse('2026-10-08T20:01:00Z'), logicalCpus: 4 };

  it('reports actual working set and lifetime CPU average from a verified process', async () => {
    const execute = vi.fn(async () => sample);
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, execute }))
      .toEqual({ workingSetBytes: 123_456_789, cpuPercent: 16.7 });
    expect(execute).toHaveBeenCalledExactlyOnceWith(4321);
  });

  it('refuses reused PID, stale identity, invalid samples, and unsupported host data', async () => {
    const reused = vi.fn(async () => ({ ...sample, started_at: '2026-10-08T18:00:00Z' }));
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, execute: reused })).toBeNull();
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, execute: async () => ({ ...sample, working_set_bytes: -1 }) })).toBeNull();
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, execute: async () => ({ ...sample, pid: 4322 }) })).toBeNull();
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, platform: 'linux', execute: vi.fn(async () => sample) })).toBeNull();
    expect(await sampleOwnedProcessMetrics(4321, launchedAt, { ...options, execute: async () => { throw new Error('Access denied'); } })).toBeNull();
  });
});
