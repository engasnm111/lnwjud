import { appError, err, type Result } from '@lnwjud/domain';
import type { CapabilityService, CapabilityToolName } from './index.js';

export interface CapabilityBackend {
  execute(input: unknown): Promise<Result<unknown>>;
}

export interface LocalCapabilityBackends {
  readonly shell: CapabilityBackend;
  readonly domCdp: CapabilityBackend;
  readonly accessibility: CapabilityBackend;
  readonly inputEvent: CapabilityBackend;
  readonly vision: CapabilityBackend;
  readonly window: CapabilityBackend;
  readonly health: CapabilityBackend;
  readonly systemInfo?: CapabilityBackend;
  readonly notification?: CapabilityBackend;
  readonly fileDialog?: CapabilityBackend;
  readonly clipboard?: CapabilityBackend;
  readonly webFetch?: CapabilityBackend;
  readonly audio?: CapabilityBackend;
  readonly screenRecord?: CapabilityBackend;
  readonly office?: CapabilityBackend;
  readonly scheduler?: CapabilityBackend;
}

export class LocalCapabilityService implements CapabilityService {
  public constructor(private readonly backends: LocalCapabilityBackends) {}

  public execute(tool: CapabilityToolName, input: unknown): Promise<Result<unknown>> {
    const backend = this.backendFor(tool);
    return backend === undefined
      ? Promise.resolve(err(appError('INVALID_INPUT', 'Capability tool is not supported')))
      : backend.execute(input);
  }

  private backendFor(tool: CapabilityToolName): CapabilityBackend | undefined {
    switch (tool) {
      case 'shell': return this.backends.shell;
      case 'dom_cdp': return this.backends.domCdp;
      case 'accessibility': return this.backends.accessibility;
      case 'input_event': return this.backends.inputEvent;
      case 'vision': return this.backends.vision;
      case 'window': return this.backends.window;
      case 'health': return this.backends.health;
      case 'system_info': return this.backends.systemInfo;
      case 'notification': return this.backends.notification;
      case 'file_dialog': return this.backends.fileDialog;
      case 'clipboard': return this.backends.clipboard;
      case 'web_fetch': return this.backends.webFetch;
      case 'audio': return this.backends.audio;
      case 'screen_record': return this.backends.screenRecord;
      case 'office': return this.backends.office;
      case 'scheduler': return this.backends.scheduler;
    }
  }
}
