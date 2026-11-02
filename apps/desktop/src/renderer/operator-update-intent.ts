import type { UpdateStatus } from '@lnwjud/ipc-contracts';

export class UpdateStatusEventRevision {
  private value = 0;
  private latestPhase: UpdateStatus['phase'] | null = null;

  event(phase: UpdateStatus['phase']): void { this.value += 1; this.latestPhase = phase; }
  capture(): number { return this.value; }
  isCurrent(revision: number): boolean { return revision === this.value; }
  isCurrentFailure(revision: number): boolean { return this.isCurrent(revision) || this.latestPhase === 'checking'; }
}

export class OperatorUpdateIntent {
  private active = false;
  private requestedDownload = false;
  private attempt = 0;

  start(): boolean {
    if (this.active) return false;
    this.active = true;
    this.attempt += 1;
    this.requestedDownload = false;
    return true;
  }

  cancel(): void {
    this.active = false;
  }

  currentAttempt(): number { return this.attempt; }
  isCurrentAttempt(attempt: number): boolean { return this.active && this.attempt === attempt; }

  onStatus(status: Pick<UpdateStatus, 'phase'> & Partial<Pick<UpdateStatus, 'canInstall'>>): 'none' | 'request-download' | 'confirm-install' {
    if (!this.active) return 'none';
    if (status.phase === 'available' && !this.requestedDownload) {
      this.requestedDownload = true;
      return 'request-download';
    }
    if (status.phase === 'ready') {
      this.cancel();
      return status.canInstall === true ? 'confirm-install' : 'none';
    }
    if (status.phase === 'idle' || status.phase === 'unavailable' || status.phase === 'error'
      || status.phase === 'up-to-date' || status.phase === 'installing') this.cancel();
    return 'none';
  }
}
