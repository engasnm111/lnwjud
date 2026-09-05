import { spawn, type ChildProcess } from 'node:child_process';

export interface ProcessTreeTerminator {
  stop(child: ChildProcess, pid: number): Promise<void>;
}

export interface WindowsProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly taskkill?: (pid: number) => Promise<number | null>;
  readonly waitForExit?: (child: ChildProcess) => Promise<void>;
}

export class WindowsProcessTree implements ProcessTreeTerminator {
  private readonly platform: NodeJS.Platform;
  private readonly taskkill: (pid: number) => Promise<number | null>;
  private readonly waitForExit: (child: ChildProcess) => Promise<void>;
  private readonly acceptedTreeStops = new WeakSet<ChildProcess>();

  public constructor(options: WindowsProcessTreeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.taskkill = options.taskkill ?? runTaskkill;
    this.waitForExit = options.waitForExit ?? waitForChildExit;
  }

  public async stop(child: ChildProcess, pid: number): Promise<void> {
    if (this.platform !== 'win32') {
      if (child.exitCode === null) child.kill('SIGTERM');
      await this.waitForExit(child);
      return;
    }
    if (this.acceptedTreeStops.has(child)) {
      await this.waitForExit(child);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Process root exited before tree termination could be verified');
    }
    let taskkillExitCode: number | null;
    try {
      taskkillExitCode = await this.taskkill(pid);
    } catch (error: unknown) {
      throw new Error('Process tree termination could not be started', { cause: error });
    }
    if (taskkillExitCode !== 0) throw new Error(`Process tree termination exited with code ${taskkillExitCode ?? 'unknown'}`);
    this.acceptedTreeStops.add(child);
    await this.waitForExit(child);
  }
}

function runTaskkill(pid: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    killer.once('error', reject);
    killer.once('close', resolve);
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const complete = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', complete);
      child.removeListener('close', complete);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', complete);
      child.removeListener('close', complete);
      reject(new Error('Process tree exit could not be verified'));
    }, timeoutMs);
    child.once('exit', complete);
    child.once('close', complete);
  });
}
