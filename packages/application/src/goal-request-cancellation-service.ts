/**
 * Coordinates cancellation of MCP requests that are currently executing for
 * one durable goal. Durable process/task cancellation is handled separately;
 * this registry owns only the request AbortControllers and their settlement.
 */

export interface GoalRequestCancellationResult {
  readonly goalId: string;
  readonly requested: number;
  readonly stopped: number;
  readonly remaining: number;
  readonly timedOut: boolean;
  readonly requestIds: readonly string[];
}

export interface GoalRequestCancellationRegistration {
  readonly accepted: boolean;
  readonly done: Promise<void>;
  release(): void;
}

export interface GoalRequestCancellationPort {
  register(goalId: string, requestId: string, controller: AbortController, leaseGeneration?: number): GoalRequestCancellationRegistration;
  cancelForGoal(goalId: string, leaseGeneration?: number): Promise<GoalRequestCancellationResult>;
  admitRecoveredGeneration?(goalId: string, leaseGeneration: number): boolean;
}

export interface GoalRequestCancellationServiceOptions {
  /** Maximum time to wait for abort-aware request handlers to settle. */
  readonly waitMs?: number;
}

const DEFAULT_WAIT_MS = 5_000;

interface Entry {
  readonly goalId: string;
  readonly requestId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  released: boolean;
}

export class GoalRequestCancellationService implements GoalRequestCancellationPort {
  private readonly waitMs: number;
  private readonly entries = new Map<string, Map<string, Entry>>();
  private readonly cancelledGoals = new Map<string, number>();
  private readonly admittedGenerations = new Map<string, number>();

  public constructor(options: GoalRequestCancellationServiceOptions = {}) {
    this.waitMs = normalizeWaitMs(options.waitMs);
  }

  public register(goalId: string, requestId: string, controller: AbortController, leaseGeneration?: number): GoalRequestCancellationRegistration {
    const normalizedGoalId = normalizeId(goalId, 'goalId');
    const normalizedRequestId = normalizeId(requestId, 'requestId');
    const admittedGeneration = this.admittedGenerations.get(normalizedGoalId);
    if ((this.cancelledGoals.has(normalizedGoalId) && admittedGeneration === undefined)
      || (admittedGeneration !== undefined && leaseGeneration !== admittedGeneration)) {
      return { accepted: false, done: Promise.resolve(), release: (): void => undefined };
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const entry: Entry = {
      goalId: normalizedGoalId,
      requestId: normalizedRequestId,
      controller,
      done,
      resolveDone,
      released: false,
    };
    let goalEntries = this.entries.get(normalizedGoalId);
    if (goalEntries === undefined) {
      goalEntries = new Map<string, Entry>();
      this.entries.set(normalizedGoalId, goalEntries);
    }
    goalEntries.set(normalizedRequestId, entry);

    return {
      accepted: true,
      done,
      release: (): void => this.release(entry),
    };
  }

  public admitRecoveredGeneration(goalId: string, leaseGeneration: number): boolean {
    const id = normalizeId(goalId, 'goalId');
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false;
    if (leaseGeneration <= (this.cancelledGoals.get(id) ?? -1)
      || leaseGeneration <= (this.admittedGenerations.get(id) ?? -1)) return false;
    // Called only after the durable blocked-goal recovery CAS commits.
    // Preserve the tombstone: registrations require the exact new generation.
    this.admittedGenerations.set(id, leaseGeneration);
    return true;
  }

  public async cancelForGoal(goalId: string, leaseGeneration?: number): Promise<GoalRequestCancellationResult> {
    const normalizedGoalId = normalizeId(goalId, 'goalId');
    const generation = leaseGeneration ?? 0;
    const admitted = this.admittedGenerations.get(normalizedGoalId);
    if (!Number.isSafeInteger(generation) || generation < 0 || (admitted !== undefined && generation < admitted)) {
      return { goalId: normalizedGoalId, requested: 0, stopped: 0, remaining: 0, timedOut: false, requestIds: [] };
    }
    this.cancelledGoals.set(normalizedGoalId, Math.max(generation, this.cancelledGoals.get(normalizedGoalId) ?? 0));
    this.admittedGenerations.delete(normalizedGoalId);
    const entries = [...(this.entries.get(normalizedGoalId)?.values() ?? [])];
    for (const entry of entries) {
      if (!entry.controller.signal.aborted) entry.controller.abort();
    }

    if (entries.length > 0) {
      const settled = Promise.all(entries.map((entry) => entry.done));
      await Promise.race([settled, wait(this.waitMs)]);
    }

    const remainingEntries = [...(this.entries.get(normalizedGoalId)?.values() ?? [])];
    return {
      goalId: normalizedGoalId,
      requested: entries.length,
      stopped: entries.length - remainingEntries.length,
      remaining: remainingEntries.length,
      timedOut: remainingEntries.length > 0,
      requestIds: entries.map((entry) => entry.requestId),
    };
  }

  private release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    const goalEntries = this.entries.get(entry.goalId);
    if (goalEntries?.get(entry.requestId) === entry) {
      goalEntries.delete(entry.requestId);
      if (goalEntries.size === 0) this.entries.delete(entry.goalId);
    }
    entry.resolveDone();
  }
}

function normalizeWaitMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_MS;
  if (!Number.isInteger(value) || value < 0 || value > 60_000) throw new Error('waitMs must be between 0 and 60000');
  return value;
}

function normalizeId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) throw new Error(`${label} is invalid`);
  return value.trim();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
