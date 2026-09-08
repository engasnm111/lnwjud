import { PlatformDiagnosticsCapabilityBackend, type PlatformDiagnosticsBackendOptions } from './platform-diagnostics-backend.js';

export type MacosDiagnosticsBackendOptions = PlatformDiagnosticsBackendOptions;

export class MacosDiagnosticsCapabilityBackend extends PlatformDiagnosticsCapabilityBackend {
  public constructor(options: MacosDiagnosticsBackendOptions = {}) {
    super('darwin', options);
  }
}

export type MacOSDiagnosticsBackend = MacosDiagnosticsCapabilityBackend;
