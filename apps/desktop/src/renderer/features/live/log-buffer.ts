import type { LogLine } from '@lnwjud/ipc-contracts';

export function applyLogSnapshot(
  previous: readonly LogLine[],
  previousIds: ReadonlySet<number>,
  snapshotLines: readonly LogLine[],
  maxLines = 30_000,
): { readonly lines: LogLine[]; readonly ids: Set<number> } {
  const byId = new Map<number, LogLine>();
  for (const line of previous) byId.set(line.id, line);
  for (const line of snapshotLines) {
    if (!byId.has(line.id)) byId.set(line.id, line);
  }
  const lines = [...byId.values()].sort((left, right) => left.id - right.id).slice(-maxLines);
  const ids = new Set(previousIds);
  for (const line of lines) ids.add(line.id);
  pruneLogIds(ids, maxLines * 2);
  return { lines, ids };
}

/**
 * Append an already de-duplicated live batch with one array copy per flush,
 * instead of copying the entire retained log buffer once per incoming IPC line.
 */
export function appendLogBatch(
  previous: readonly LogLine[],
  batch: readonly LogLine[],
  maxLines = 30_000,
): LogLine[] {
  if (batch.length === 0) return [...previous];
  const existingIds = new Set(previous.map((line) => line.id));
  const additions = batch.filter((line) => !existingIds.has(line.id));
  if (additions.length === 0) return [...previous];
  const merged = [...previous, ...additions];
  return merged.length <= maxLines ? merged : merged.slice(-maxLines);
}

/**
 * Track recent pushed log ids without allowing a long desktop session to grow
 * the de-duplication Set forever. Set insertion order gives us a cheap FIFO.
 */
export function rememberLogId(ids: Set<number>, id: number, maxIds = 60_000): boolean {
  if (ids.has(id)) return false;
  ids.add(id);
  pruneLogIds(ids, maxIds);
  return true;
}

function pruneLogIds(ids: Set<number>, maxIds: number): void {
  while (ids.size > maxIds) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}
