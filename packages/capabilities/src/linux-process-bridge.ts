import { appError, err, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { ProcessTreeTerminator } from '@lnwjud/process';
import { NativeHostProcessBridge, type NativeHostProtocolOptions, type NativeHostSpawner } from './native-host-protocol.js';

export interface LinuxProcessBridgeOptions {
  readonly executablePath: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
  readonly requireIntegrity?: boolean;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly terminator: ProcessTreeTerminator;
  readonly spawnProcess?: NativeHostSpawner;
}

/** Integrity-bound NDJSON bridge for the packaged Linux native host. */
export class LinuxProcessBridge extends NativeHostProcessBridge {
  public constructor(options: LinuxProcessBridgeOptions) {
    const protocol: NativeHostProtocolOptions = { ...options, platform: 'linux' };
    super(protocol);
  }
}

export function unavailableLinuxHost(reason = 'native_host_missing'): Result<never> {
  return err(appError('PROCESS_NOT_FOUND', `Linux native host is unavailable (${reason})`, true));
}

export type LinuxNativeOperationAuthorization = InvocationAuthorization;
