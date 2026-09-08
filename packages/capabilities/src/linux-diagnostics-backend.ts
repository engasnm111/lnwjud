import { PlatformDiagnosticsCapabilityBackend, type PlatformDiagnosticsBackendOptions } from './platform-diagnostics-backend.js';

export type LinuxDiagnosticsBackendOptions = PlatformDiagnosticsBackendOptions;

export class LinuxDiagnosticsCapabilityBackend extends PlatformDiagnosticsCapabilityBackend {
  public constructor(options: LinuxDiagnosticsBackendOptions = {}) {
    super('linux', options);
  }
}

export type LinuxDiagnosticsBackend = LinuxDiagnosticsCapabilityBackend;
