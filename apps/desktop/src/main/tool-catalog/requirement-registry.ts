import type { RequirementResult } from '@lnwjud/ipc-contracts';

export type RequirementProbeStatus = RequirementResult['status'];
export interface RequirementProbeResult {
  readonly status: RequirementProbeStatus;
  readonly detail?: string;
}
export interface RequirementDefinition {
  readonly id: string;
  readonly required: boolean;
  readonly summaryKey: string;
  readonly remediationId?: string;
  readonly probe: () => Promise<RequirementProbeResult>;
}

export interface RequirementSnapshot extends RequirementResult {
  readonly durationMs: number;
}

export class RequirementRegistry {
  readonly #definitions: ReadonlyMap<string, RequirementDefinition>;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #cache = new Map<string, { readonly result: RequirementSnapshot; readonly expiresAt: number }>();
  readonly #inFlight = new Map<string, Promise<RequirementSnapshot>>();

  public constructor(definitions: readonly RequirementDefinition[], options: { readonly timeoutMs?: number; readonly ttlMs?: number; readonly now?: () => Date } = {}) {
    const entries = definitions.map((definition) => [definition.id, definition] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('Duplicate requirement id');
    this.#definitions = new Map(entries);
    this.#timeoutMs = options.timeoutMs ?? 2_000;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#now = options.now ?? ((): Date => new Date());
  }

  public ids(): readonly string[] { return [...this.#definitions.keys()]; }
  public definition(id: string): RequirementDefinition | undefined { return this.#definitions.get(id); }

  public async probe(ids: readonly string[] = this.ids(), force = false): Promise<ReadonlyMap<string, RequirementSnapshot>> {
    const unique = [...new Set(ids)];
    const entries = await Promise.all(unique.map(async (id) => [id, await this.#probeOne(id, force)] as const));
    return new Map(entries);
  }

  public stale(id: string): boolean {
    const cached = this.#cache.get(id);
    return cached === undefined || cached.expiresAt <= this.#now().getTime();
  }

  async #probeOne(id: string, force: boolean): Promise<RequirementSnapshot> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown requirement id: ${id}`);
    const nowMs = this.#now().getTime();
    const cached = this.#cache.get(id);
    if (!force && cached !== undefined && cached.expiresAt > nowMs) return cached.result;
    const existing = this.#inFlight.get(id);
    if (existing !== undefined) return existing;
    const promise = this.#run(definition).finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, promise);
    return promise;
  }

  async #run(definition: RequirementDefinition): Promise<RequirementSnapshot> {
    const started = this.#now().getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<RequirementProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unknown', detail: 'Probe timed out' }), this.#timeoutMs);
      });
      const value = await Promise.race([definition.probe(), timeout]);
      const checkedAt = this.#now().toISOString();
      const result: RequirementSnapshot = {
        id: definition.id,
        status: value.status,
        required: definition.required,
        checkedAt,
        summaryKey: definition.summaryKey,
        ...(value.detail === undefined ? {} : { detail: value.detail.slice(0, 2_048) }),
        ...(definition.remediationId === undefined ? {} : { remediationId: definition.remediationId }),
        durationMs: Math.max(0, this.#now().getTime() - started),
      };
      this.#cache.set(definition.id, { result, expiresAt: Date.parse(checkedAt) + this.#ttlMs });
      return result;
    } catch (error: unknown) {
      const checkedAt = this.#now().toISOString();
      const result: RequirementSnapshot = {
        id: definition.id,
        status: 'unknown',
        required: definition.required,
        checkedAt,
        summaryKey: definition.summaryKey,
        detail: error instanceof Error ? error.message.slice(0, 2_048) : 'Probe failed',
        ...(definition.remediationId === undefined ? {} : { remediationId: definition.remediationId }),
        durationMs: Math.max(0, this.#now().getTime() - started),
      };
      this.#cache.set(definition.id, { result, expiresAt: Date.parse(checkedAt) + this.#ttlMs });
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
