import { appError, err, ok, type Result } from '@lnwjud/domain';
import { capabilityToolNames, type CapabilityToolName } from './index.js';
import { capabilityDescriptors, capabilitySupportsPlatform, type CapabilityDescriptor } from './capability-descriptors.js';
import type { CapabilityBackend } from './local-capability-service.js';

interface HealthCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly domCdp?: CapabilityBackend;
  readonly accessibility?: CapabilityBackend;
  readonly inputEvent?: CapabilityBackend;
  readonly vision?: CapabilityBackend;
  readonly window?: CapabilityBackend;
  readonly systemInfo?: CapabilityBackend;
  readonly notification?: CapabilityBackend;
  readonly fileDialog?: CapabilityBackend;
  readonly clipboard?: CapabilityBackend;
  readonly audio?: CapabilityBackend;
  readonly screenRecord?: CapabilityBackend;
  readonly scheduler?: CapabilityBackend;
  readonly wslExec?: CapabilityBackend;
  readonly wslFs?: CapabilityBackend;
}

export class HealthCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly domCdp: CapabilityBackend | undefined;
  private readonly accessibility: CapabilityBackend | undefined;
  private readonly inputEvent: CapabilityBackend | undefined;
  private readonly vision: CapabilityBackend | undefined;
  private readonly window: CapabilityBackend | undefined;
  private readonly systemInfo: CapabilityBackend | undefined;
  private readonly notification: CapabilityBackend | undefined;
  private readonly fileDialog: CapabilityBackend | undefined;
  private readonly clipboard: CapabilityBackend | undefined;
  private readonly audio: CapabilityBackend | undefined;
  private readonly screenRecord: CapabilityBackend | undefined;
  private readonly scheduler: CapabilityBackend | undefined;
  private readonly wslExec: CapabilityBackend | undefined;
  private readonly wslFs: CapabilityBackend | undefined;

  public constructor(options: HealthCapabilityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.domCdp = options.domCdp;
    this.accessibility = options.accessibility;
    this.inputEvent = options.inputEvent;
    this.vision = options.vision;
    this.window = options.window;
    this.systemInfo = options.systemInfo;
    this.notification = options.notification;
    this.fileDialog = options.fileDialog;
    this.clipboard = options.clipboard;
    this.audio = options.audio;
    this.screenRecord = options.screenRecord;
    this.scheduler = options.scheduler;
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
    const descriptor = this.descriptor(tool);
    if (descriptor !== undefined && !capabilitySupportsPlatform(descriptor, this.platform)) {
      return this.describe(tool, {
        available: false,
        ready: false,
        applicable: false,
        local: true,
        reason: `Not applicable on ${this.platform}`,
      });
    }

    if (tool === 'shell' || tool === 'health' || tool === 'web_fetch') {
      return this.describe(tool, { available: true, ready: true, applicable: true, local: true });
    }
    if (tool === 'system_info') return this.describe(tool, await this.checkDelegated(this.systemInfo, { operation: 'os' }));
    if (tool === 'notification') return this.describe(tool, await this.checkDelegated(this.notification, {
      action: 'show', title: 'lnwjud', message: 'health-check', dry_run: true,
    }));
    if (tool === 'file_dialog') return this.describe(tool, await this.checkDelegated(this.fileDialog, { action: 'open', dry_run: true }));
    if (tool === 'clipboard') return this.describe(tool, await this.checkDelegated(this.clipboard, { action: 'get_text', dry_run: true }));
    if (tool === 'input_event') {
      return this.platform === 'linux'
        ? this.describe(tool, await this.checkDelegated(this.inputEvent, { action: 'status' }))
        : this.describe(tool, { available: true, ready: true, applicable: true, local: true });
    }
    if (tool === 'vision') {
      return this.platform === 'linux'
        ? this.describe(tool, await this.checkDelegated(this.vision, { action: 'status' }))
        : this.describe(tool, { available: true, ready: true, applicable: true, local: true });
    }
    if (tool === 'window') {
      return this.platform === 'linux'
        ? this.describe(tool, await this.checkDelegated(this.window, { action: 'status' }))
        : this.describe(tool, { available: true, ready: true, applicable: true, local: true });
    }
    if (tool === 'audio') {
      const probe = this.platform === 'win32' ? { action: 'record', dry_run: true } : { action: 'status' };
      return this.describe(tool, await this.checkDelegated(this.audio, probe));
    }
    if (tool === 'screen_record') return this.describe(tool, await this.checkDelegated(this.screenRecord, { action: 'status' }));
    if (tool === 'office') {
      return this.describe(tool, { available: true, ready: true, applicable: true, local: true });
    }
    if (tool === 'dom_cdp') return this.describe(tool, await this.checkDelegated(this.domCdp, { action: 'status' }));
    if (tool === 'scheduler') return this.describe(tool, await this.checkDelegated(this.scheduler, { action: 'list' }));
    if (tool === 'wsl_exec') return this.describe(tool, await this.checkDelegated(this.wslExec, { operation: 'status' }));
    if (tool === 'wsl_fs') return this.describe(tool, await this.checkDelegated(this.wslFs, { operation: 'status' }));
    return this.describe(tool, await this.checkDelegated(this.accessibility, { action: 'status' }));
  }

  private descriptor(tool: CapabilityToolName): CapabilityDescriptor | undefined {
    return capabilityDescriptors.find((candidate) => candidate.name === tool);
  }

  private describe(tool: CapabilityToolName, value: Record<string, unknown>): Record<string, unknown> {
    const descriptor = this.descriptor(tool);
    return descriptor === undefined
      ? value
      : {
        availability: descriptor.availability,
        platformPolicy: descriptor.platformPolicy,
        requirements: descriptor.requirements,
        permission: descriptor.permission,
        supportsCancel: descriptor.supportsCancel,
        supportsDryRun: descriptor.supportsDryRun,
        auditTarget: descriptor.auditTarget,
        ...value,
      };
  }

  private async checkDelegated(backend: CapabilityBackend | undefined, input: unknown): Promise<Record<string, unknown>> {
    if (backend === undefined) return { available: false, ready: false, applicable: true, local: true, reason: 'Backend is not configured' };
    const result = await backend.execute(input);
    if (!result.ok) return { available: false, ready: false, applicable: true, local: true, reason: result.error.message };
    const value = isRecord(result.value) ? result.value : {};
    return { available: value.available !== false, ready: value.ready !== false, applicable: true, local: true, ...value };
  }
}

function isCapabilityToolName(value: unknown): value is CapabilityToolName {
  return typeof value === 'string' && capabilityToolNames.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
