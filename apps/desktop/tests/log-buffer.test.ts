import { describe, expect, it } from 'vitest';
import type { LogLine } from '@lnwjud/ipc-contracts';
import { appendLogBatch, applyLogSnapshot, rememberLogId } from '../src/renderer/features/live/log-buffer.js';

function line(id: number, text: string): LogLine {
  return { id, source: 'mcp', timestamp: '2026-01-01T00:00:00.000Z', level: 'info', text };
}

describe('log buffer helpers', () => {
  it('keeps live lines that arrived before a stale snapshot resolves', () => {
    const live = line(2, 'live mcp');
    const snapshot = [line(1, 'older')];
    const merged = applyLogSnapshot([live], new Set([2]), snapshot);
    expect(merged.lines.map((entry) => entry.text)).toEqual(['older', 'live mcp']);
    expect(merged.ids.has(2)).toBe(true);
    expect(merged.ids.has(1)).toBe(true);
  });

  it('bounds snapshot state and the remembered id set for long desktop sessions', () => {
    const previous = Array.from({ length: 6 }, (_, index) => line(index + 1, `previous-${index + 1}`));
    const snapshot = Array.from({ length: 6 }, (_, index) => line(index + 7, `snapshot-${index + 7}`));
    const merged = applyLogSnapshot(previous, new Set(previous.map((entry) => entry.id)), snapshot, 5);

    expect(merged.lines.map((entry) => entry.id)).toEqual([8, 9, 10, 11, 12]);
    expect(merged.ids.size).toBeLessThanOrEqual(10);
  });

  it('appends a pushed burst with one bounded batch and avoids snapshot-race duplicates', () => {
    const previous = [line(1, 'one'), line(2, 'two')];
    const batch = [line(2, 'two duplicate'), line(3, 'three'), line(4, 'four')];

    expect(appendLogBatch(previous, batch, 3).map((entry) => entry.id)).toEqual([2, 3, 4]);
  });

  it('keeps live-event dedupe ids bounded while preserving recent ids', () => {
    const ids = new Set<number>();
    for (let id = 1; id <= 8; id += 1) expect(rememberLogId(ids, id, 5)).toBe(true);

    expect([...ids]).toEqual([4, 5, 6, 7, 8]);
    expect(rememberLogId(ids, 8, 5)).toBe(false);
    expect(rememberLogId(ids, 9, 5)).toBe(true);
    expect([...ids]).toEqual([5, 6, 7, 8, 9]);
  });
});
