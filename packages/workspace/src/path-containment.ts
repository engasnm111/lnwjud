import { isHostPathWithin } from './filesystem-root.js';

export function isWithin(rootPath: string, candidatePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return isHostPathWithin(rootPath, candidatePath, platform);
}
