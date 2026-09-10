import { existsSync } from 'node:fs';
import path from 'node:path';
import { executableInPath, PlatformOfficeCapabilityBackend, type PlatformOfficeBackendOptions } from './office-backend.js';

export interface LinuxOfficeBackendOptions {
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly executableExists?: (executable: string) => boolean;
}

export class LinuxOfficeCapabilityBackend extends PlatformOfficeCapabilityBackend {
  public constructor(options: LinuxOfficeBackendOptions = {}) {
    const executableExists = options.executableExists ?? ((executable: string): boolean => executable.includes(path.posix.sep) ? existsSync(executable) : executableInPath(executable));
    const configuration: PlatformOfficeBackendOptions = {
      platform: 'linux',
      backend: 'libreoffice-uno',
      dependency: 'LibreOffice (soffice)',
      supportedApps: ['libreoffice', 'soffice'],
      dependencyAvailable: () => executableExists('soffice') || executableExists('libreoffice'),
      ...(options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider }),
    };
    super(configuration);
  }
}

export type LinuxOfficeBackend = LinuxOfficeCapabilityBackend;
