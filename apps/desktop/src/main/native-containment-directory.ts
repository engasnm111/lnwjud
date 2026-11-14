import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstalledResourcesPath } from '@lnwjud/shared';

export function resolveDesktopNativeContainmentDirectory(isPackaged: boolean, resourcesPath: string, mainModuleUrl: string): string {
  return isPackaged
    ? path.join(resolveInstalledResourcesPath(resourcesPath), 'native-containment')
    : fileURLToPath(new URL('../../build/native-containment', mainModuleUrl));
}
