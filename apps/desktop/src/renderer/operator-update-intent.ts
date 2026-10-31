import type { UpdateStatus } from '@lnwjud/ipc-contracts';

export class OperatorUpdateIntent {
  private active = false;
  private requestedDownload = false;

  start(): boolean {
    if (this.active) return false;
    this.active = true;
    this.requestedDownload = false;
    return true;
  }

  cancel(): void {
    this.active = false;
  }

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
    if (status.phase === 'unavailable' || status.phase === 'error'
      || status.phase === 'up-to-date' || status.phase === 'installing') this.cancel();
    return 'none';
  }
}
