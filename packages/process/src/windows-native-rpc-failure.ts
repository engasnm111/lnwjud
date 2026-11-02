export function serviceEndpointFailure(exitCode: number | null, output: Buffer): string | undefined {
  if (exitCode !== 125) return undefined;
  for (const code of ['SERVICE_ENDPOINT_PACKAGE_MISMATCH', 'SERVICE_ENDPOINT_NOT_INSTALLED'] as const) {
    const line = `{"protocol":3,"ok":false,"error":"${code}"}`;
    if (output.equals(Buffer.from(line + '\r\n')) || output.equals(Buffer.from(line + '\n'))) return code;
  }
  return undefined;
}

export function serviceResponseFailure(reason: unknown): string {
  return typeof reason === 'string' && reason !== 'SERVICE_ENDPOINT_PACKAGE_MISMATCH' && reason !== 'SERVICE_ENDPOINT_NOT_INSTALLED'
    ? reason : 'NATIVE_SERVICE_RPC_FAILED';
}
