import path from 'node:path';

function isWindowsStylePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/i.test(p);
}

function getPathApi(rootPath: string, candidatePath?: string): typeof path.win32 | typeof path.posix {
  if (isWindowsStylePath(rootPath) || (candidatePath !== undefined && isWindowsStylePath(candidatePath))) {
    return path.win32;
  }
  return process.platform === 'win32' ? path.win32 : path.posix;
}

export function isWithin(rootPath: string, candidatePath: string): boolean {
  const p = getPathApi(rootPath, candidatePath);
  const resolvedRoot = p === path.win32 ? p.resolve(rootPath) : path.resolve(rootPath);
  const resolvedCandidate = p === path.win32 ? p.resolve(candidatePath) : path.resolve(candidatePath);
  const relativePath = p.relative(resolvedRoot, resolvedCandidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${p.sep}`) && relativePath !== '..' && !p.isAbsolute(relativePath));
}
