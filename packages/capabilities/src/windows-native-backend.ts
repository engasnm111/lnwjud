import path from 'node:path';
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

export interface WindowsNativeBackendOptions {
  /**
   * When unrestricted is false, path-bearing inputs (audio/screen_record/office targets)
   * must resolve inside one of these roots. Unused in unrestricted mode.
   */
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly unrestricted?: boolean;
}

const PATH_FIELDS: Readonly<Record<WindowsCapabilityName, readonly string[]>> = {
  accessibility: [],
  input_event: [],
  vision: [],
  window: [],
  system_info: [],
  notification: [],
  file_dialog: [],
  clipboard: [],
  audio: ['file_path', 'output_path'],
  screen_record: ['output_path'],
  office: ['file_path', 'target_path'],
};

export class WindowsNativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: WindowsCapabilityName,
    private readonly bridge: WindowsCapabilityBridge,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: WindowsNativeBackendOptions = {},
  ) {}

  public async execute(input: unknown): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return err(appError('INTERNAL_ERROR', 'Windows capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Native capability input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability });

    const pathCheck = await this.assertPathsAllowed(input);
    if (!pathCheck.ok) return pathCheck;

    return this.bridge.execute({ capability: this.capability, input });
  }

  private async assertPathsAllowed(input: Record<string, unknown>): Promise<Result<void>> {
    if (this.options.unrestricted === true) return ok(undefined);
    const fields = PATH_FIELDS[this.capability];
    const targets: string[] = [];
    for (const field of fields) {
      const value = input[field];
      if (typeof value === 'string' && value.trim().length > 0) targets.push(path.resolve(value.trim()));
    }
    if (targets.length === 0) return ok(undefined);

    const roots = this.options.allowedRootsProvider === undefined
      ? []
      : (await this.options.allowedRootsProvider()).map((root) => path.resolve(root));
    for (const target of targets) {
      const within = roots.some((root) => isWithin(root, target));
      if (!within) return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} target path is outside configured local roots`));
    }
    return ok(undefined);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
