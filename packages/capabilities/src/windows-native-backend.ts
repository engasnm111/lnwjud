import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

export type WindowsCapabilityName =
  | 'accessibility'
  | 'input_event'
  | 'vision'
  | 'window'
  | 'system_info'
  | 'notification'
  | 'file_dialog'
  | 'clipboard'
  | 'audio'
  | 'screen_record'
  | 'office';

export interface WindowsCapabilityBridge {
  execute(request: { readonly capability: WindowsCapabilityName; readonly input: unknown }): Promise<Result<unknown>>;
}

export class WindowsNativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: WindowsCapabilityName,
    private readonly bridge: WindowsCapabilityBridge,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public execute(input: unknown): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return Promise.resolve(err(appError('INTERNAL_ERROR', 'Windows capability is unavailable on this platform', true)));
    if (!isRecord(input)) return Promise.resolve(err(appError('INVALID_INPUT', 'Native capability input must be an object')));
    if (input.dry_run === true) return Promise.resolve(ok({ dry_run: true, capability: this.capability }));
    return this.bridge.execute({ capability: this.capability, input });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
