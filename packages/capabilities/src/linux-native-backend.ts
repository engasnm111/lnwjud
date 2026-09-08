import type { NativeHostProcessBridge } from './native-host-protocol.js';
import { NativeCapabilityBackend, type NativeCapabilityBackendOptions, type PortableNativeCapabilityName } from './native-capability-backend.js';

export interface LinuxNativeBackendOptions {
  readonly bridge?: NativeHostProcessBridge;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

export class LinuxNativeCapabilityBackend extends NativeCapabilityBackend {
  public constructor(capability: PortableNativeCapabilityName, options: LinuxNativeBackendOptions = {}) {
    const backendOptions: NativeCapabilityBackendOptions = { platform: 'linux', ...(options.bridge === undefined ? {} : { bridge: options.bridge }), ...(options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider }) };
    super(capability, backendOptions);
  }
}
