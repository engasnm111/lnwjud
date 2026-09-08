import { appError, err, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { ProcessTreeTerminator } from '@lnwjud/process';
import { NativeHostProcessBridge, type NativeHostProtocolOptions, type NativeHostSpawner } from './native-host-protocol.js';

export interface MacosProcessBridgeOptions {
  readonly executablePath: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
  readonly requireIntegrity?: boolean;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly terminator: ProcessTreeTerminator;
  readonly spawnProcess?: NativeHostSpawner;
}

/** Integrity-bound NDJSON bridge for the packaged macOS native host. */
export class MacosProcessBridge extends NativeHostProcessBridge {
  public constructor(options: MacosProcessBridgeOptions) {
    const protocol: NativeHostProtocolOptions = { ...options, platform: 'darwin' };
    super(protocol);
  }
}

export function unavailableMacosHost(reason = 'native_host_missing'): Result<never> {
  return err(appError('PROCESS_NOT_FOUND', `macOS native host is unavailable (${reason})`, true));
}

export type MacOSProcessBridge = MacosProcessBridge;

export type MacosNativeOperationAuthorization = InvocationAuthorization;
