import type { TunnelStatus } from '@lnwjud/ipc-contracts';

export interface UpdateTunnelStopConfirmationOptions {
  readonly getTunnelStatus: () => Promise<TunnelStatus>;
  readonly confirmStop: () => Promise<boolean>;
}

export function updateInstallNeedsTunnelStopConfirmation(status: TunnelStatus): boolean {
  if (status.state === 'running' || status.state === 'starting') return true;
  const persistent = status.persistent;
  if (persistent === null) return false;
  if (persistent.runtimeAliasActive === true) return true;
  return persistent.state === 'starting' || persistent.state === 'running' || persistent.state === 'reconnecting';
}

export async function confirmTunnelStopForUpdate(options: UpdateTunnelStopConfirmationOptions): Promise<boolean> {
  try {
    const status = await options.getTunnelStatus();
    if (!updateInstallNeedsTunnelStopConfirmation(status)) return true;
  } catch {
    // Fail safe: if the tunnel status cannot be verified, require explicit user
    // consent before the installer attempts to stop it.
  }
  return options.confirmStop();
}

/** Revalidate after a potentially long backup, immediately before native install. */
export async function silentInstallStillSafe(options: {
  readonly enabled: () => boolean;
  readonly activeCalls: () => number;
  readonly tunnelStopped: () => Promise<boolean>;
}): Promise<boolean> {
  if (!options.enabled() || options.activeCalls() !== 0) return false;
  try {
    if (!await options.tunnelStopped()) return false;
  } catch {
    return false;
  }
  return options.enabled() && options.activeCalls() === 0;
}

export interface UpdateReadyDialogOptions {
  readonly type: 'info';
  readonly title: string;
  readonly message: string;
  readonly buttons: ['Restart Now', 'Later'];
  readonly defaultId: 1;
  readonly cancelId: 1;
}

export interface UpdateInstallCoordinatorOptions {
  readonly activeCallCount: () => number;
  readonly activityRevision?: () => number;
  readonly tunnelRunning?: () => Promise<boolean | 'unverifiable'>;
  readonly sharedActivitySnapshot?: () => Promise<UpdateSharedActivitySnapshot>;
  readonly install: (unattended: boolean) => void;
  readonly quietPeriodMs?: number;
  readonly pollIntervalMs?: number;
}

export type UpdateSharedActivitySnapshot =
  | { readonly state: 'available'; readonly activeCallCount: number; readonly revision: number; readonly ownerKey?: string }
  | { readonly state: 'missing' | 'stale' | 'unverifiable'; readonly reason?: string };

export interface UpdateDownloadedDialogControllerOptions {
  readonly showDialog: (options: UpdateReadyDialogOptions) => Promise<{ readonly response: number }>;
  readonly requestInstall: () => void;
  readonly hasPendingInstall: () => boolean;
  readonly onShow?: (version: string) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_QUIET_PERIOD_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function updateReadyDialogOptions(version: string): UpdateReadyDialogOptions {
  return {
    type: 'info',
    title: 'Update Ready - lnwjud',
    message: `Version v${version} has been downloaded. Restart lnwjud now to install?`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 1,
    cancelId: 1,
  };
}

export class UpdateDownloadedDialogController {
  private dialogPending = false;
  private readonly handledVersions = new Set<string>();

  public constructor(private readonly options: UpdateDownloadedDialogControllerOptions) {}

  public async handle(version: string): Promise<boolean> {
    if (this.dialogPending || this.options.hasPendingInstall() || this.handledVersions.has(version)) return false;
    this.dialogPending = true;
    try {
      this.options.onShow?.(version);
      const result = await this.options.showDialog(updateReadyDialogOptions(version));
      this.handledVersions.add(version);
      while (this.handledVersions.size > 20) {
        const oldest = this.handledVersions.values().next().value;
        if (oldest === undefined) break;
        this.handledVersions.delete(oldest);
      }
      if (result.response === 0) this.options.requestInstall();
      return true;
    } catch (error: unknown) {
      this.options.onError?.(error);
      return true;
    } finally {
      this.dialogPending = false;
    }
  }
}

export class UpdateInstallCoordinator {
  private readonly quietPeriodMs: number;
  private readonly pollIntervalMs: number;
  private pending = false;
  private unattended = false;
  private shutdown = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  private quietRevision = '';
  private evaluating = false;

  public constructor(private readonly options: UpdateInstallCoordinatorOptions) {
    this.quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  public requestInstall(unattended = false): void {
    if (this.shutdown || this.pending) return;
    this.pending = true;
    this.unattended = unattended;
    void this.evaluate();
  }

  /** Disabling silent updates withdraws the unattended request without disabling manual installs. */
  public cancelUnattended(): void {
    if (!this.unattended) return;
    this.pending = false;
    this.unattended = false;
    this.clearTimer();
  }

  public cancel(): void {
    this.shutdown = true;
    this.pending = false;
    this.unattended = false;
    this.clearTimer();
  }

  public hasPendingInstall(): boolean {
    return this.pending;
  }

  private async evaluate(): Promise<void> {
    if (!this.pending || this.shutdown || this.evaluating) return;
    this.evaluating = true;
    let activity: { readonly trustworthy: boolean; readonly activeCount: number; readonly revision: string };
    try {
      activity = await this.observeActivity();
    } finally {
      this.evaluating = false;
    }
    if (!this.pending || this.shutdown) return;
    if (!activity.trustworthy || activity.activeCount > 0) {
      this.quietUntil = 0;
      this.schedule(this.pollIntervalMs, () => { void this.evaluate(); });
      return;
    }
    this.quietUntil = Date.now() + this.quietPeriodMs;
    this.quietRevision = activity.revision;
    void this.waitForQuietPeriod();
  }

  private async waitForQuietPeriod(): Promise<void> {
    if (!this.pending || this.shutdown) return;
    // Poll the existing tracker throughout the quiet period so a short call
    // that starts and ends inside the interval restarts the quiet clock.
    const activity = await this.observeActivity();
    if (!this.pending || this.shutdown) return;
    if (!activity.trustworthy || activity.activeCount > 0 || activity.revision !== this.quietRevision) {
      void this.evaluate();
      return;
    }
    const remaining = this.quietUntil - Date.now();
    if (remaining <= 0) {
      this.pending = false;
      this.options.install(this.unattended);
      return;
    }
    this.schedule(Math.min(this.pollIntervalMs, remaining), () => { void this.waitForQuietPeriod(); });
  }

  private async observeActivity(): Promise<{ readonly trustworthy: boolean; readonly activeCount: number; readonly revision: string }> {
    const initialLocal = this.sampleLocalActivity();
    let tunnelState: boolean | 'unverifiable' = false;
    try {
      tunnelState = this.options.tunnelRunning === undefined ? false : await this.options.tunnelRunning();
    } catch {
      tunnelState = 'unverifiable';
    }

    const afterTunnel = this.sampleLocalActivity();
    if (!sameLocalActivity(initialLocal, afterTunnel)) return staleLocalActivity(afterTunnel);
    // Unattended restarts never tear down a live or unverifiable Secure Tunnel.
    // Manual installation retains its separate user-confirmed tunnel-stop flow.
    if (this.unattended && tunnelState !== false) {
      return { trustworthy: false, activeCount: afterTunnel.activeCount, revision: `${localRevisionKey(afterTunnel)}:silent:tunnel-not-stopped` };
    }
    if (tunnelState === false) {
      return { trustworthy: true, activeCount: afterTunnel.activeCount, revision: localRevisionKey(afterTunnel) };
    }
    if (this.options.sharedActivitySnapshot === undefined) {
      return { trustworthy: false, activeCount: afterTunnel.activeCount, revision: `${localRevisionKey(afterTunnel)}:shared:missing` };
    }
    try {
      const shared = await this.options.sharedActivitySnapshot();
      const afterShared = this.sampleLocalActivity();
      if (!sameLocalActivity(afterTunnel, afterShared)) return staleLocalActivity(afterShared);
      if (shared.state !== 'available') return { trustworthy: false, activeCount: afterShared.activeCount, revision: `${localRevisionKey(afterShared)}:shared:${shared.state}` };
      return { trustworthy: true, activeCount: afterShared.activeCount + shared.activeCallCount, revision: `${localRevisionKey(afterShared)}:shared:${shared.ownerKey ?? ''}:${shared.revision}` };
    } catch {
      const afterShared = this.sampleLocalActivity();
      return { trustworthy: false, activeCount: afterShared.activeCount, revision: `${localRevisionKey(afterShared)}:shared:unverifiable` };
    }
  }

  private sampleLocalActivity(): LocalActivityObservation {
    return { activeCount: this.options.activeCallCount(), revision: this.options.activityRevision?.() ?? 0 };
  }

  private schedule(delayMs: number, action: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      action();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

interface LocalActivityObservation {
  readonly activeCount: number;
  readonly revision: number;
}

function sameLocalActivity(left: LocalActivityObservation, right: LocalActivityObservation): boolean {
  return left.activeCount === right.activeCount && left.revision === right.revision;
}

function localRevisionKey(activity: LocalActivityObservation): string {
  return `local:${activity.revision}`;
}

function staleLocalActivity(activity: LocalActivityObservation): { readonly trustworthy: false; readonly activeCount: number; readonly revision: string } {
  return { trustworthy: false, activeCount: activity.activeCount, revision: `${localRevisionKey(activity)}:changed` };
}
