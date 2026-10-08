import type { CallTimingAggregate, CallTimingObservation } from '@lnwjud/domain';

/** Percentiles use nearest-rank on independently observed terminal samples, never estimated transport time. */
export function aggregateCallTimings(observations: readonly CallTimingObservation[]): CallTimingAggregate {
  const unique = new Map<string, CallTimingObservation>();
  for (const observation of observations) {
    const previous = unique.get(observation.correlationKey);
    if (!previous || (!isTerminal(previous) && isTerminal(observation))) {
      unique.set(observation.correlationKey, observation);
    }
  }
  const terminal = [...unique.values()].filter(isTerminal);
  const server = terminal.map((item) => item.serverMs).filter(isMeasured).sort((a, b) => a - b);
  const tunnel = terminal.map((item) => item.tunnelObservedMs).filter(isMeasured).sort((a, b) => a - b);
  return {
    completedCount: terminal.length,
    incompleteCount: unique.size - terminal.length,
    serverSampleCount: server.length,
    serverP50Ms: nearestRank(server, 0.5),
    serverP95Ms: nearestRank(server, 0.95),
    tunnelSampleCount: tunnel.length,
    tunnelP50Ms: nearestRank(tunnel, 0.5),
    tunnelP95Ms: nearestRank(tunnel, 0.95),
  };
}
function isTerminal(value: CallTimingObservation): boolean {
  return (value.outcome === 'success' || value.outcome === 'failure' || value.outcome === 'cancelled')
    && value.completedAt !== null && Number.isFinite(Date.parse(value.completedAt));
}
function isMeasured(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
function nearestRank(sorted: readonly number[], percentile: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.ceil(percentile * sorted.length) - 1]!;
}
