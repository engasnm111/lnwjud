import { describe, expect, it } from 'vitest';
import { serviceEndpointFailure, serviceResponseFailure } from './windows-native-rpc-failure.js';

const line = '{"protocol":3,"ok":false,"error":"SERVICE_ENDPOINT_PACKAGE_MISMATCH"}';

describe('native service RPC diagnostics', () => {
  it('accepts only the fixed failure line and exit status', () => {
    expect(serviceEndpointFailure(125, Buffer.from(line + '\r\n'))).toBe('SERVICE_ENDPOINT_PACKAGE_MISMATCH');
    expect(serviceEndpointFailure(125, Buffer.from(line + '\n'))).toBe('SERVICE_ENDPOINT_PACKAGE_MISMATCH');
    const missing = line.replace('PACKAGE_MISMATCH', 'NOT_INSTALLED');
    expect(serviceEndpointFailure(125, Buffer.from(missing + '\r\n'))).toBe('SERVICE_ENDPOINT_NOT_INSTALLED');
    for (const [exit, output] of [
      [0, line + '\r\n'], [1, line + '\r\n'], [null, line + '\r\n'], [125, ''],
      [125, line.replace('false', 'true') + '\r\n'],
      [125, line.replace('PACKAGE_MISMATCH', 'OTHER') + '\r\n'],
      [125, line.replace('}', ',"path":"private"}') + '\r\n'],
      [125, line.replace('}', ',"ok":false}') + '\r\n'],
      [125, line + '\r\n' + line + '\r\n'],
    ] as const) expect(serviceEndpointFailure(exit, Buffer.from(output))).toBeUndefined();
  });

  it('does not treat an ordinary service reply as a local endpoint diagnostic', () => {
    expect(serviceResponseFailure('SERVICE_ENDPOINT_NOT_INSTALLED')).toBe('NATIVE_SERVICE_RPC_FAILED');
    expect(serviceResponseFailure('SERVICE_ENDPOINT_PACKAGE_MISMATCH')).toBe('NATIVE_SERVICE_RPC_FAILED');
    expect(serviceResponseFailure('SERVICE_OTHER_FAILURE')).toBe('SERVICE_OTHER_FAILURE');
    expect(serviceResponseFailure(null)).toBe('NATIVE_SERVICE_RPC_FAILED');
  });
});
