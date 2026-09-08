import type { NativeHostProcessBridge } from './native-host-protocol.js';
import { NativeCapabilityBackend, type NativeCapabilityBackendOptions, type PortableNativeCapabilityName } from './native-capability-backend.js';

export interface MacosNativeBackendOptions {
  readonly bridge?: NativeHostProcessBridge;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

export class MacosNativeCapabilityBackend extends NativeCapabilityBackend {
  public constructor(capability: PortableNativeCapabilityName, options: MacosNativeBackendOptions = {}) {
    const backendOptions: NativeCapabilityBackendOptions = { platform: 'darwin', ...(options.bridge === undefined ? {} : { bridge: options.bridge }), ...(options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider }) };
    super(capability, backendOptions);
  }
}
