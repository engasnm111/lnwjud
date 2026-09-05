import path from 'node:path';

export function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (relativePath === '') return true;
  if (path.isAbsolute(relativePath)) return false;
  const [firstSegment] = relativePath.split(path.sep);
  return firstSegment !== '..';
}
