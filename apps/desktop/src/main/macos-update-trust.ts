import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Squirrel.Mac compares an update to the installed app's designated
 * requirement. Ad-hoc signatures pin a CDHash, so another version cannot
 * satisfy that requirement. Offer manual replacement until Developer ID signed.
 */
export function isTrustedMacosUpdateSignature(details: string): boolean {
  return !/^Signature=adhoc\s*$/m.test(details)
    && /^Authority=Developer ID Application: .+$/m.test(details)
    && /^TeamIdentifier=[A-Z0-9]{10}\s*$/m.test(details)
    && /^Timestamp=(?!none\s*$|0\s*$).+$/mi.test(details);
}

export function canInstallMacosUpdates(
  executablePath: string,
  run: (args: readonly string[]) => string = (args) => {
    const result = spawnSync('/usr/bin/codesign', [...args], { encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return `${result.stdout}${result.stderr}`;
  },
): boolean {
  const appPath = path.resolve(executablePath, '../../..');
  if (path.basename(appPath) !== 'lnwjud.app') return false;
  try {
    const details = run(['--display', '--verbose=4', appPath]);
    if (!isTrustedMacosUpdateSignature(details)) return false;
    run(['--verify', '--deep', '--strict', '--all-architectures', appPath]);
    return true;
  } catch {
    return false;
  }
}
