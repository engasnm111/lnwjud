export const AUTO_UPDATE_STARTUP_DELAY_MS = 5_000;
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

export type UpdateCheckSource = 'automatic' | 'tray' | 'renderer';

export class UpdateCheckInitializationQueue {
  private pending: UpdateCheckSource | null = null;

  public enqueue(source: UpdateCheckSource): void {
    if (this.pending === null || source === 'renderer' || (source === 'tray' && this.pending === 'automatic')) this.pending = source;
  }

  public finish(ready: boolean, dispatch: (source: UpdateCheckSource) => unknown): boolean {
    const pending = this.pending;
    this.pending = null;
    if (ready && pending !== null) dispatch(pending);
    return pending !== null;
  }
}

export interface UpdateCheckSchedulerOptions {
  readonly check: () => void;
  readonly startupDelayMs?: number;
  readonly intervalMs?: number;
  readonly checkOnStartup?: boolean;
}

export class UpdateCheckScheduler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(private readonly options: UpdateCheckSchedulerOptions) {}

  public start(): void {
    if (this.startupTimer !== null || this.intervalTimer !== null) return;
    const startupDelayMs = this.options.startupDelayMs ?? AUTO_UPDATE_STARTUP_DELAY_MS;
    const intervalMs = this.options.intervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS;
    if (this.options.checkOnStartup !== false) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        this.options.check();
      }, startupDelayMs);
    }
    this.intervalTimer = setInterval(() => this.options.check(), intervalMs);
  }

  public stop(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}
