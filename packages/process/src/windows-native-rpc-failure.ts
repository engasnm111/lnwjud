export function isServicePackageMismatch(exitCode: number | null, output: Buffer): boolean {
  if (exitCode !== 125) return false;
  const line = '{"protocol":3,"ok":false,"error":"SERVICE_ENDPOINT_PACKAGE_MISMATCH"}';
  return output.equals(Buffer.from(line + '\r\n')) || output.equals(Buffer.from(line + '\n'));
}
