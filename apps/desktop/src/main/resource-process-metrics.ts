import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export interface OwnedProcessMetrics {
  readonly workingSetBytes: number;
  /** Average usage across logical CPUs over this process lifetime (not an instantaneous sample). */
  readonly cpuPercent: number | null;
}

interface WindowsProcessSample {
  readonly pid: number;
  readonly started_at: string;
  readonly working_set_bytes: number;
  readonly cpu_seconds: number;
}

export type MetricsExecutor = (pid: number) => Promise<WindowsProcessSample>;

const WINDOWS_METRIC_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$p=Get-Process -Id ([int]$env:LNWJUD_METRIC_PID) -ErrorAction Stop',
  "[pscustomobject]@{pid=[int]$p.Id;started_at=$p.StartTime.ToUniversalTime().ToString('o');working_set_bytes=[long]$p.WorkingSet64;cpu_seconds=[double]$p.TotalProcessorTime.TotalSeconds}|ConvertTo-Json -Compress",
].join('; ');

async function readWindowsProcess(pid: number): Promise<WindowsProcessSample> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_METRIC_SCRIPT], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024,
    env: { ...process.env, LNWJUD_METRIC_PID: String(pid) },
  });
  return JSON.parse(stdout) as WindowsProcessSample;
}

/**
 * Samples only an exact, already owner-verified child. A PID by itself is not
 * ownership: reject reused PIDs unless the OS start timestamp matches the
 * manager's launch timestamp, and never reuse a cached resource reading.
 */
export async function sampleOwnedProcessMetrics(
  pid: number,
  launchedAt: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly execute?: MetricsExecutor;
    readonly now?: () => number;
    readonly logicalCpus?: number;
  } = {},
): Promise<OwnedProcessMetrics | null> {
  if ((options.platform ?? process.platform) !== 'win32' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  const launchMs = Date.parse(launchedAt);
  if (!Number.isFinite(launchMs)) return null;
  try {
    const sample = await (options.execute ?? readWindowsProcess)(pid);
    const osStartMs = Date.parse(sample.started_at);
    const sampledMs = options.now?.() ?? Date.now();
    if (sample.pid !== pid || !Number.isFinite(osStartMs) || Math.abs(osStartMs - launchMs) > 15_000
      || osStartMs > sampledMs || !Number.isSafeInteger(sample.working_set_bytes) || sample.working_set_bytes < 0
      || !Number.isFinite(sample.cpu_seconds) || sample.cpu_seconds < 0) return null;
    const ageSeconds = (sampledMs - osStartMs) / 1000;
    const logicalCpus = options.logicalCpus ?? os.availableParallelism();
    const cpuPercent = ageSeconds >= 1 && Number.isSafeInteger(logicalCpus) && logicalCpus > 0
      ? Number((sample.cpu_seconds / ageSeconds / logicalCpus * 100).toFixed(1))
      : null;
    return { workingSetBytes: sample.working_set_bytes, cpuPercent };
  } catch {
    // OS can refuse sampling exited or inaccessible processes. Never fabricate zero.
    return null;
  }
}
