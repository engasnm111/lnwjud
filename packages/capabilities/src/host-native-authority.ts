import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsNativeAuthority } from '@lnwjud/process';
import { CONTAINMENT_HELPER_SHA256, CONTAINMENT_PIN_SHA256, CONTAINMENT_RUNTIME_SHA256 } from './containment-integrity.generated.js';

export function createHostWindowsNativeAuthority(dataPath: string, trustedRuntimeDirectory?: string): WindowsNativeAuthority | undefined {
  if (process.platform !== 'win32') return undefined;
  const runtimeDirectory = resolveRuntimeDirectory(trustedRuntimeDirectory);
  return new WindowsNativeAuthority({
    helper: {
      executable: path.join(runtimeDirectory, 'lnwjud-containment.exe'),
      sha256: CONTAINMENT_HELPER_SHA256,
      buildId: 'lnwjud-containment-v2',
    },
    pin: { modulePath: path.join(runtimeDirectory, 'lnwjud-containment-pin.node'), sha256: CONTAINMENT_PIN_SHA256 },
    profileDirectory: path.join(dataPath, 'native-authority'),
    workerModulePath: path.join(runtimeDirectory, 'process-runtime.mjs'),
    workerModuleSha256: CONTAINMENT_RUNTIME_SHA256,
  });
}

export function createHostPosixProcessRuntime(trustedRuntimeDirectory?: string): { readonly modulePath: string; readonly sha256: string } {
  return { modulePath: path.join(resolveRuntimeDirectory(trustedRuntimeDirectory), 'process-runtime.mjs'), sha256: CONTAINMENT_RUNTIME_SHA256 };
}

function resolveRuntimeDirectory(trustedRuntimeDirectory?: string): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return trustedRuntimeDirectory ?? (resourcesPath === undefined
    ? fileURLToPath(new URL('../../../apps/desktop/build/native-containment/', import.meta.url))
    : path.join(resourcesPath, 'native-containment'));
}
