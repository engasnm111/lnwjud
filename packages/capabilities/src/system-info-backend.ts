import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const execFile = promisify(execFileCallback);

type SystemInfoOperation = 'all' | 'cpu' | 'memory' | 'disks' | 'battery' | 'uptime' | 'os' | 'processes';

export interface NodeSystemInfoCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/**
 * Cross-platform system diagnostics for non-Windows desktop targets.
 * Windows keeps its existing native PowerShell/CIM provider to minimize regression risk.
 */
export class NodeSystemInfoCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  public constructor(options: NodeSystemInfoCapabilityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'system_info input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: 'system_info' });
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'system_info operation was cancelled', true));

    const operation = readOperation(input.operation);
    if (operation === null) return err(appError('INVALID_INPUT', 'Unsupported system_info operation'));
    const topCount = readTopCount(input.top_count);
    if (topCount === null) return err(appError('INVALID_INPUT', 'top_count must be from 1 to 50'));

    try {
      return ok(await this.read(operation, topCount, signal));
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `system_info failed: ${errorMessage(error)}`, true));
    }
  }

  private async read(operation: SystemInfoOperation, topCount: number, signal?: AbortSignal): Promise<unknown> {
    switch (operation) {
      case 'cpu': return this.cpu();
      case 'memory': return this.memory();
      case 'disks': return this.disks(signal);
      case 'battery': return this.battery(signal);
      case 'uptime': return this.uptime();
      case 'os': return this.osInfo();
      case 'processes': return this.processes(topCount, signal);
      case 'all':
        return {
          os: this.osInfo(),
          cpu: this.cpu(),
          memory: this.memory(),
          disks: await this.disks(signal),
          battery: await this.battery(signal),
          uptime: this.uptime(),
          top_processes: await this.processes(topCount, signal),
        };
    }
  }

  private cpu(): unknown {
    const cpus = os.cpus();
    const logical = Math.max(1, cpus.length);
    const load = os.loadavg()[0] ?? 0;
    return {
      model: cpus[0]?.model ?? '',
      cores: logical,
      logical_processors: logical,
      load_percent: Math.max(0, Math.min(100, Math.round((load / logical) * 100))),
    };
  }

  private memory(): unknown {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      total_bytes: total,
      free_bytes: free,
      used_percent: total > 0 ? Math.round((1 - (free / total)) * 100) : 0,
    };
  }

  private uptime(): unknown {
    const uptimeSeconds = Math.max(0, Math.round(os.uptime()));
    return {
      boot_time: new Date(Date.now() - (uptimeSeconds * 1000)).toISOString(),
      uptime_seconds: uptimeSeconds,
    };
  }

  private osInfo(): unknown {
    return {
      name: this.platform === 'darwin' ? 'macOS' : this.platform === 'linux' ? 'Linux' : os.type(),
      version: os.release(),
      build: typeof os.version === 'function' ? os.version() : os.release(),
      architecture: this.arch,
      computer_name: os.hostname(),
      manufacturer: '',
      model: '',
    };
  }

  private async disks(signal?: AbortSignal): Promise<unknown> {
    if (this.platform !== 'darwin' && this.platform !== 'linux') return { drives: [] };
    const stdout = await runOptional('df', ['-kP'], signal);
    if (stdout === null) return { drives: [] };
    const drives = stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      const columns = line.split(/\s+/);
      if (columns.length < 6) return [];
      const blocks = Number(columns[1]);
      const available = Number(columns[3]);
      if (!Number.isFinite(blocks) || !Number.isFinite(available)) return [];
      return [{
        device: columns[0] ?? '',
        volume: columns.slice(5).join(' '),
        filesystem: '',
        total_bytes: Math.round(blocks * 1024),
        free_bytes: Math.round(available * 1024),
      }];
    });
    return { drives };
  }

  private async battery(signal?: AbortSignal): Promise<unknown> {
    if (this.platform === 'darwin') {
      const stdout = await runOptional('/usr/bin/pmset', ['-g', 'batt'], signal);
      const match = stdout?.match(/(\d{1,3})%;\s*([^;\n]+)/);
      if (match === undefined || match === null) return { present: false };
      return { present: true, percent: Number(match[1]), status: match[2]?.trim() ?? '' };
    }
    if (this.platform === 'linux') {
      const stdout = await runOptional('sh', ['-c', "for d in /sys/class/power_supply/BAT*; do [ -r \"$d/capacity\" ] || continue; cat \"$d/capacity\"; [ -r \"$d/status\" ] && cat \"$d/status\"; break; done"], signal);
      if (stdout === null || stdout.trim().length === 0) return { present: false };
      const [percentRaw, status = ''] = stdout.trim().split(/\r?\n/);
      const percent = Number(percentRaw);
      return Number.isFinite(percent)
        ? { present: true, percent, status: status.trim() }
        : { present: false };
    }
    return { present: false };
  }

  private async processes(topCount: number, signal?: AbortSignal): Promise<unknown> {
    if (this.platform !== 'darwin' && this.platform !== 'linux') return { processes: [] };
    const stdout = await runOptional('ps', ['-axo', 'comm=,pid=,rss=,time='], signal);
    if (stdout === null) return { processes: [] };
    const processes = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      const match = line.match(/^(.*?)\s+(\d+)\s+(\d+)\s+([0-9:-]+)$/);
      if (match === null) return [];
      const memoryKb = Number(match[3]);
      return [{
        name: match[1]?.trim() ?? '',
        pid: Number(match[2]),
        memory_bytes: Number.isFinite(memoryKb) ? Math.round(memoryKb * 1024) : 0,
        cpu_time_seconds: parsePsCpuTime(match[4] ?? ''),
      }];
    }).sort((left, right) => right.memory_bytes - left.memory_bytes).slice(0, topCount);
    return { processes };
  }
}

async function runOptional(file: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await execFile(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: 5_000, signal });
    return result.stdout;
  } catch {
    return null;
  }
}

function readOperation(value: unknown): SystemInfoOperation | null {
  if (value === undefined) return 'all';
  return value === 'all' || value === 'cpu' || value === 'memory' || value === 'disks' || value === 'battery'
    || value === 'uptime' || value === 'os' || value === 'processes'
    ? value
    : null;
}

function readTopCount(value: unknown): number | null {
  if (value === undefined) return 10;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50 ? value : null;
}

function parsePsCpuTime(value: string): number {
  const fields = value.split(':').map(Number);
  if (fields.some((part) => !Number.isFinite(part))) return 0;
  if (fields.length === 3) return Math.round((fields[0]! * 3600) + (fields[1]! * 60) + fields[2]!);
  if (fields.length === 2) return Math.round((fields[0]! * 60) + fields[1]!);
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
