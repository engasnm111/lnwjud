export const DESKTOP_IPC_DRAINING_ERROR = 'Desktop is shutting down; new IPC requests are temporarily unavailable';

/**
 * Tracks renderer IPC that owns DesktopRuntime resources. Shutdown first stops
 * accepting new work, waits for every already-started invocation to settle,
 * and only then closes the runtime/SQLite. A deferred shutdown can resume IPC.
 */
export class DesktopIpcDrainBarrier {
  private accepting = true;
  private active = 0;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;

  public isDraining(): boolean {
    return !this.accepting;
  }

  public activeCount(): number {
    return this.active;
  }

  public async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error(DESKTOP_IPC_DRAINING_ERROR);
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0 && this.resolveDrain !== null) {
        const resolve = this.resolveDrain;
        this.resolveDrain = null;
        this.drainPromise = null;
        resolve();
      }
    }
  }

  public beginDrain(): Promise<void> {
    this.accepting = false;
    if (this.active === 0) return Promise.resolve();
    if (this.drainPromise !== null) return this.drainPromise;
    this.drainPromise = new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
    return this.drainPromise;
  }

  public resume(): void {
    this.accepting = true;
  }
}
