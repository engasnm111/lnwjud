export class AsyncTtlCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inFlight: Promise<T> | null = null;

  public constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be a non-negative finite number');
  }

  public get(load: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && this.now() < this.expiresAt) return Promise.resolve(this.value);
    if (this.inFlight !== null) return this.inFlight;

    const pending = load().then((value) => {
      this.value = value;
      this.expiresAt = this.now() + this.ttlMs;
      return value;
    });
    this.inFlight = pending;
    void pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    }).catch(() => undefined);
    return pending;
  }

  public clear(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }
}
