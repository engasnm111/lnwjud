import os from 'node:os';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

export interface SystemInfoSnapshot {
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly arch: string;
  readonly hostname: string;
  readonly cpu_count: number;
  readonly cpu_model: string | null;
  readonly memory_bytes: { readonly total: number; readonly free: number };
  readonly uptime_seconds: number;
  readonly backend: 'node-system-info';
}

/**
 * Portable read-only system metadata for direct STDIO and non-Electron hosts.
 * Display metadata deliberately stays in the Electron provider because Node
 * alone cannot prove monitor geometry on every target desktop session.
 */
export class SystemInfoCapabilityBackend implements CapabilityBackend {
  public constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'system_info input must be an object'));
    const action = input.action === undefined ? 'summary' : input.action;
    if (action !== 'status' && action !== 'summary' && action !== 'get') return err(appError('INVALID_INPUT', 'system_info supports status, summary, or get'));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'system_info operation was cancelled', true));
    if (input.dry_run === true) return ok({ dry_run: true, capability: 'system_info', platform: this.platform });
    if (action === 'status') return ok({ available: true, ready: true, local: true, backend: 'node-system-info', platform: this.platform });

    try {
      const cpus = os.cpus();
      const snapshot: SystemInfoSnapshot = {
        platform: this.platform,
        release: os.release(),
        arch: process.arch,
        hostname: os.hostname(),
        cpu_count: cpus.length,
        cpu_model: cpus[0]?.model ?? null,
        memory_bytes: { total: os.totalmem(), free: os.freemem() },
        uptime_seconds: os.uptime(),
        backend: 'node-system-info',
      };
      return ok(snapshot);
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `system_info probe failed: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown error'}`, true));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
