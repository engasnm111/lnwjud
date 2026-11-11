export function wantsMcpStdio(argv: readonly string[]): boolean {
  return argv.includes('--mcp-stdio');
}

export function shouldHoldSingleInstanceLock(argv: readonly string[]): boolean {
  return !wantsMcpStdio(argv);
}

export class DesktopStartupIntents {
  private state: 'starting' | 'ready' | 'cancelled' = 'starting';
  private readonly pending = new Set<'show' | 'log-viewer'>();

  public constructor(private readonly handle: (intent: 'show' | 'log-viewer') => void) {}

  public receive(argv: readonly string[]): void {
    if (this.state === 'cancelled') return;
    const intent = argv.includes('--log-viewer') ? 'log-viewer' : 'show';
    if (this.state === 'ready') this.handle(intent);
    else this.pending.add(intent);
  }

  public ready(): void {
    if (this.state !== 'starting') return;
    this.state = 'ready';
    for (const intent of this.pending) this.handle(intent);
    this.pending.clear();
  }

  public cancel(): void {
    this.state = 'cancelled';
    this.pending.clear();
  }
}
