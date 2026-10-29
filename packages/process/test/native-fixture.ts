import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsNativeAuthority, type NativeAttemptBinding } from '../src/windows-native-authority.js';

export async function nativeFixture(directory: string): Promise<{ authority: WindowsNativeAuthority; binding: NativeAttemptBinding }> {
  const helperDirectory = fileURLToPath(new URL('../../../native/windows-containment-helper/artifacts/win-x64/', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(helperDirectory, 'manifest.json'), 'utf8'));
  const taskId = randomUUID();
  return {
    authority: new WindowsNativeAuthority({ helper: { executable: path.join(helperDirectory, manifest.filename), sha256: manifest.sha256, buildId: manifest.buildId }, profileDirectory: path.join(directory, 'profile'), pin: { modulePath: path.join(helperDirectory, 'lnwjud-containment-pin.node'), sha256: createHash('sha256').update(await readFile(path.join(helperDirectory, 'lnwjud-containment-pin.node'))).digest('hex') } }),
    binding: { taskId, reservationId: taskId, attemptId: randomUUID(), generation: 1, requestDigest: createHash('sha256').update(taskId).digest('hex'), ownerClientId: 'native-test-client', ownerSessionId: 'native-test-session', workspaceId: 'native-test-workspace' },
  };
}
