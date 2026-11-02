import { describe, expect, it } from 'vitest';
import { isServicePackageMismatch } from './windows-native-rpc-failure.js';

const line = '{"protocol":3,"ok":false,"error":"SERVICE_ENDPOINT_PACKAGE_MISMATCH"}';

describe('native service RPC diagnostics', () => {
  it('accepts only the fixed failure line and exit status', () => {
    expect(isServicePackageMismatch(125, Buffer.from(line + '\r\n'))).toBe(true);
    expect(isServicePackageMismatch(125, Buffer.from(line + '\n'))).toBe(true);
    for (const [exit, output] of [
      [0, line + '\r\n'], [1, line + '\r\n'], [null, line + '\r\n'], [125, ''],
      [125, line.replace('false', 'true') + '\r\n'],
      [125, line.replace('PACKAGE_MISMATCH', 'OTHER') + '\r\n'],
      [125, line.replace('}', ',"path":"private"}') + '\r\n'],
      [125, line.replace('}', ',"ok":false}') + '\r\n'],
      [125, line + '\r\n' + line + '\r\n'],
    ] as const) expect(isServicePackageMismatch(exit, Buffer.from(output))).toBe(false);
  });
});
