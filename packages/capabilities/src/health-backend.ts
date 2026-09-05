import { appError, err, ok, type Result } from '@lnwjud/domain';
import { capabilityToolNames, type CapabilityToolName } from './index.js';
import { capabilityDescriptors } from './capability-descriptors.js';
import type { CapabilityBackend } from './local-capability-service.js';

interface HealthCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly domCdp?: CapabilityBackend;
  readonly accessibility?: CapabilityBackend;
  readonly wslExec?: CapabilityBackend;
  readonly wslFs?: CapabilityBackend;
}

export class HealthCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly domCdp: CapabilityBackend | undefined;
  private readonly accessibility: CapabilityBackend | undefined;
  private readonly wslExec: CapabilityBackend | undefined;
  private readonly wslFs: CapabilityBackend | undefined;

  public constructor(options: HealthCapabilityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.domCdp = options.domCdp;
    this.accessibility = options.accessibility;
    this.wslExec = options.wslExec;
    this.wslFs = options.wslFs;
  }

  public async execute(input: unknown): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Health input must be an object'));
    const operation = input.operation === undefined ? 'check_all' : input.operation;
    if (operation !== 'check_all' && operation !== 'check_tool') return err(appError('INVALID_INPUT', 'Health operation is invalid'));
    const tool = input.tool;
    const validatedTool = isCapabilityToolName(tool) ? tool : undefined;
    if (operation === 'check_tool' && validatedTool === undefined) return err(appError('INVALID_INPUT', 'Health tool is required'));
    if (operation === 'check_tool' && validatedTool !== undefined) return ok({ tool: validatedTool, ...(await this.check(validatedTool)) });

    const capabilities: Record<string, unknown> = {};
    for (const name of capabilityToolNames) capabilities[name] = await this.check(name);
    return ok({ capabilities });
  }

  private async check(tool: CapabilityToolName): Promise<Record<string, unknown>> {
    if (tool === 'shell' || tool === 'health' || tool === 'web_fetch' || tool === 'scheduler') return this.describe(tool, { available: true, ready: true, local: true });
    if (tool === 'system_info' || tool === 'notification' || tool === 'file_dialog' || tool === 'clipboard'
      || tool === 'audio' || tool === 'screen_record' || tool === 'office') {
      return this.describe(tool, { available: this.platform === 'win32', ready: this.platform === 'win32', local: true });
    }
    if (tool === 'input_event' || tool === 'vision' || tool === 'window') return this.describe(tool, { available: this.platform === 'win32', ready: this.platform === 'win32', local: true });
    if (tool === 'dom_cdp') return this.describe(tool, await this.checkDelegated(this.domCdp, { action: 'status' }));
    if (tool === 'wsl_exec') return this.describe(tool, await this.checkDelegated(this.wslExec, { operation: 'status' }));
    if (tool === 'wsl_fs') return this.describe(tool, await this.checkDelegated(this.wslFs, { operation: 'status' }));
    return this.describe(tool, await this.checkDelegated(this.accessibility, { action: 'status' }));
  }

  private describe(tool: CapabilityToolName, value: Record<string, unknown>): Record<string, unknown> {
    const descriptor = capabilityDescriptors.find((candidate) => candidate.name === tool);
    return descriptor === undefined
      ? value
      : {
        availability: descriptor.availability,
        requirements: descriptor.requirements,
        permission: descriptor.permission,
        supportsCancel: descriptor.supportsCancel,
        supportsDryRun: descriptor.supportsDryRun,
        auditTarget: descriptor.auditTarget,
        ...value,
      };
  }

  private async checkDelegated(backend: CapabilityBackend | undefined, input: unknown): Promise<Record<string, unknown>> {
    if (backend === undefined) return { available: false, ready: false, local: true, reason: 'Backend is not configured' };
    const result = await backend.execute(input);
    if (!result.ok) return { available: false, ready: false, local: true, reason: result.error.message };
    const value = isRecord(result.value) ? result.value : {};
    return { available: value.available !== false, ready: value.ready !== false, local: true, ...value };
  }
}

function isCapabilityToolName(value: unknown): value is CapabilityToolName {
  return typeof value === 'string' && capabilityToolNames.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
