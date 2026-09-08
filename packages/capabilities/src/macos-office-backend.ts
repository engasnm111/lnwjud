import { existsSync } from 'node:fs';
import { PlatformOfficeCapabilityBackend, type PlatformOfficeBackendOptions } from './office-backend.js';

export interface MacosOfficeBackendOptions {
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly applicationExists?: (applicationPath: string) => boolean;
}

const OFFICE_APPLICATIONS = [
  '/Applications/Microsoft Excel.app',
  '/Applications/Microsoft Word.app',
  '/Applications/Microsoft PowerPoint.app',
];

export class MacosOfficeCapabilityBackend extends PlatformOfficeCapabilityBackend {
  public constructor(options: MacosOfficeBackendOptions = {}) {
    const applicationExists = options.applicationExists ?? existsSync;
    const configuration: PlatformOfficeBackendOptions = {
      platform: 'darwin',
      backend: 'apple-events-office',
      dependency: 'Microsoft Office and Automation permission',
      supportedApps: ['excel', 'word', 'powerpoint'],
      dependencyAvailable: () => OFFICE_APPLICATIONS.some((applicationPath) => applicationExists(applicationPath)),
      ...(options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider }),
    };
    super(configuration);
  }
}

export type MacOSOfficeBackend = MacosOfficeCapabilityBackend;
