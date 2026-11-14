import path from 'node:path';

export function resolveInstalledResourcesPath(resourcesPath: string): string {
  const slot = path.dirname(resourcesPath);
  const slots = path.dirname(slot);
  if (path.basename(resourcesPath).toLowerCase() === 'resources'
    && /^[AB]$/i.test(path.basename(slot)) && path.basename(slots).toLowerCase() === 'slots') {
    return path.join(path.dirname(slots), 'resources');
  }
  return resourcesPath;
}
