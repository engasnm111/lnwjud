import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveDesktopNativeContainmentDirectory(isPackaged: boolean, resourcesPath: string, mainModuleUrl: string): string {
  return isPackaged
    ? path.join(resourcesPath, 'native-containment')
    : fileURLToPath(new URL('../../build/native-containment', mainModuleUrl));
}
