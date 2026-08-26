import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { isWithin, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';

export function isAbsoluteFsPath(inputPath: string): boolean {
  return path.win32.isAbsolute(inputPath) || path.posix.isAbsolute(inputPath);
}

export async function resolveWorkspaceForPath(
  workspaces: WorkspaceRepository,
  workspaceId: string | undefined,
  inputPath: string,
): Promise<Result<Workspace>> {
  if (workspaceId !== undefined && workspaceId.trim().length > 0) {
    const workspace = await workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    if (isAbsoluteFsPath(inputPath) && !workspaceContains(workspace, inputPath)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }
    return ok(workspace);
  }

  if (!isAbsoluteFsPath(inputPath)) {
    return err(appError('INVALID_INPUT', 'workspaceId is required unless path is absolute'));
  }

  const listed = await workspaces.list();
  const matches = listed.filter((workspace) => workspaceContains(workspace, inputPath));
  if (matches.length === 0) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is not inside a registered workspace'));
  }
  matches.sort((left, right) => longestRoot(right).length - longestRoot(left).length);
  return ok(matches[0]!);
}

export async function resolveSharedWorkspace(
  workspaces: WorkspaceRepository,
  workspaceId: string | undefined,
  sourcePath: string,
  destinationPath: string,
): Promise<Result<Workspace>> {
  const source = await resolveWorkspaceForPath(workspaces, workspaceId, sourcePath);
  if (!source.ok) return source;
  const destination = await resolveWorkspaceForPath(workspaces, workspaceId, destinationPath);
  if (!destination.ok) return destination;
  if (source.value.id !== destination.value.id) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Source and destination must be in the same workspace'));
  }
  return source;
}

function workspaceContains(workspace: Workspace, inputPath: string): boolean {
  if (process.platform !== 'win32' && /^[A-Za-z]:/i.test(inputPath)) {
    const normalizedInput = inputPath.replaceAll('\\', '/');
    const normalizedRoot = workspace.realRootPath.replaceAll('\\', '/');
    const relative = path.posix.relative(normalizedRoot, normalizedInput);
    return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
  }
  const absolutePath = path.resolve(inputPath);
  return isWithin(workspace.realRootPath, absolutePath) || isWithin(workspace.rootPath, absolutePath);
}

function longestRoot(workspace: Workspace): string {
  return workspace.realRootPath.length >= workspace.rootPath.length ? workspace.realRootPath : workspace.rootPath;
}
