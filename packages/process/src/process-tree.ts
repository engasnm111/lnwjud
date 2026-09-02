import type { ChildProcess } from 'node:child_process';
import { PosixProcessTree } from './posix-process-tree.js';
import { WindowsProcessTree } from './windows-process-tree.js';

export interface ProcessTerminationOwnership {
  /**
   * POSIX process group created by lnwjud for this exact child. A terminator may
   * signal the group only when this ID is present and equals the spawned leader PID.
   */
  readonly processGroupId?: number;
}

export interface ProcessTreeTerminator {
  stop(process: ChildProcess, pid: number, ownership?: ProcessTerminationOwnership): Promise<void>;
  isRunning?(pid: number): boolean;
}

export function createPlatformProcessTree(platform: NodeJS.Platform = process.platform): ProcessTreeTerminator {
  return platform === 'win32' ? new WindowsProcessTree() : new PosixProcessTree();
}
