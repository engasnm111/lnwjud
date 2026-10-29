import type { TunnelStatus } from '@lnwjud/ipc-contracts';

export function updateInstallNeedsTunnelStopConfirmation(status: TunnelStatus): boolean {
  if (status.state === 'running' || status.state === 'starting') return true;
  const persistent = status.persistent;
  if (persistent === null) return false;
  if (persistent.runtimeAliasActive === true) return true;
  return persistent.state === 'starting' || persistent.state === 'running' || persistent.state === 'reconnecting';
}

export interface DownloadedUpdateOffer {
  readonly generation: number;
  readonly version: string;
  readonly artifactIdentity: string;
}

export async function installAfterPreUpdateBackup(
  createBackup: () => Promise<unknown>,
  startInstall: () => Promise<void>,
): Promise<void> {
  await createBackup();
  await startInstall();
}

export interface UpdateInstallConsentControllerOptions {
  readonly getCurrentOffer: () => DownloadedUpdateOffer | null;
  readonly hasPendingInstall: () => boolean;
  readonly confirmVersion: (version: string) => Promise<boolean>;
  readonly queueInstall: (offer: DownloadedUpdateOffer) => boolean;
}

/** One native confirmation grants one in-memory attempt for one downloaded artifact. */
export class UpdateInstallConsentController {
  private promptPending = false;

  public constructor(private readonly options: UpdateInstallConsentControllerOptions) {}

  public async requestInstall(): Promise<boolean> {
    if (this.promptPending || this.options.hasPendingInstall()) return false;
    const offer = this.options.getCurrentOffer();
    if (offer === null) return false;

    this.promptPending = true;
    try {
      if (!await this.options.confirmVersion(offer.version)) return false;
      const currentOffer = this.options.getCurrentOffer();
      if (!sameDownloadedOffer(offer, currentOffer)) return false;
      return this.options.queueInstall(offer);
    } finally {
      this.promptPending = false;
    }
  }
}

/** Restores the pre-update Tunnel state once when the install handoff fails. */
export class UpdateTunnelRecovery {
  private restoreRunningTunnel: (() => void | Promise<void>) | null = null;
  private restoration: Promise<string | null> | null = null;

  public rememberRunningTunnel(restore: () => void | Promise<void>): void {
    if (this.restoreRunningTunnel !== null || this.restoration !== null) return;
    this.restoreRunningTunnel = restore;
  }

  public restoreAfterFailure(): Promise<string | null> {
    if (this.restoration !== null) return this.restoration;
    const restore = this.restoreRunningTunnel;
    this.restoreRunningTunnel = null;
    if (restore === null) return Promise.resolve(null);

    const restoration = (async (): Promise<string | null> => {
      try {
        await restore();
        return null;
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    this.restoration = restoration;
    void restoration.finally(() => {
      if (this.restoration === restoration) this.restoration = null;
    });
    return restoration;
  }
}

function sameDownloadedOffer(left: DownloadedUpdateOffer, right: DownloadedUpdateOffer | null): boolean {
  return right !== null
    && left.generation === right.generation
    && left.version === right.version
    && left.artifactIdentity === right.artifactIdentity;
}

export interface UpdateInstallCoordinatorOptions {
  readonly activeCallCount: () => number;
  readonly activityRevision?: () => number;
  readonly tunnelRunning?: () => Promise<boolean | 'unverifiable'>;
  readonly sharedActivitySnapshot?: () => Promise<UpdateSharedActivitySnapshot>;
  readonly install: (offer: DownloadedUpdateOffer) => void | Promise<void>;
  readonly onInstallError?: (error: unknown) => void | Promise<void>;
  readonly quietPeriodMs?: number;
  readonly pollIntervalMs?: number;
}

export type UpdateSharedActivitySnapshot =
  | { readonly state: 'available'; readonly activeCallCount: number; readonly revision: number; readonly ownerKey?: string }
  | { readonly state: 'missing' | 'stale' | 'unverifiable'; readonly reason?: string };

const DEFAULT_QUIET_PERIOD_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class UpdateInstallCoordinator {
  private readonly quietPeriodMs: number;
  private readonly pollIntervalMs: number;
  private pending = false;
  private handoffPending = false;
  private offer: DownloadedUpdateOffer | null = null;
  private shutdown = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  private quietRevision = '';
  private evaluating = false;

  public constructor(private readonly options: UpdateInstallCoordinatorOptions) {
    this.quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  public requestInstall(offer: DownloadedUpdateOffer): boolean {
    if (this.shutdown || this.pending || this.handoffPending) return false;
    this.pending = true;
    this.offer = offer;
    void this.evaluate();
    return true;
  }

  public cancel(): void {
    this.shutdown = true;
    this.pending = false;
    this.offer = null;
    this.clearTimer();
  }

  public hasPendingInstall(): boolean {
    return this.pending || this.handoffPending;
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
      const offer = this.offer;
      if (offer === null) {
        this.pending = false;
        return;
      }
      this.pending = false;
      this.offer = null;
      this.handoffPending = true;
      try {
        await this.options.install(offer);
      } catch (error: unknown) {
        try {
          await this.options.onInstallError?.(error);
        } catch (handlerError: unknown) {
          console.error(`Update installation error handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`);
        }
      } finally {
        this.handoffPending = false;
      }
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
