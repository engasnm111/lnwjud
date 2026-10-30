import type { UpdateStatus } from '@lnwjud/ipc-contracts';

export class OperatorUpdateIntent {
  private active = false;
  private requestedDownload = false;

  start(): void {
    this.active = true;
    this.requestedDownload = false;
  }

  cancel(): void {
    this.active = false;
  }

  onStatus(status: Pick<UpdateStatus, 'phase'>): 'none' | 'request-download' | 'confirm-install' {
    if (!this.active) return 'none';
    if (status.phase === 'available' && !this.requestedDownload) {
      this.requestedDownload = true;
      return 'request-download';
    }
    if (status.phase === 'ready') {
      this.cancel();
      return 'confirm-install';
    }
    if (status.phase === 'unavailable' || status.phase === 'error'
      || status.phase === 'up-to-date' || status.phase === 'installing') this.cancel();
    return 'none';
  }
}
