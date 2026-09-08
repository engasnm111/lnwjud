import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { isAbsoluteHostPath, isForeignAbsolutePath, isHostPathWithin, resolveHostPath, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';

export function isAbsoluteFsPath(inputPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return isAbsoluteHostPath(inputPath, platform);
}

export async function resolveWorkspaceForPath(
  workspaces: WorkspaceRepository,
  workspaceId: string | undefined,
  inputPath: string,
  authorization?: InvocationAuthorization,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<Workspace>> {
  if (workspaceId !== undefined && workspaceId.trim().length > 0) {
    const workspace = await workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    if (isAbsoluteFsPath(inputPath, platform) && !workspaceContains(workspace, inputPath, platform) && !isFullBypassAuthorization(authorization)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }
    return ok(workspace);
  }

  if (isForeignAbsolutePath(inputPath, platform)) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path uses a foreign host syntax and is outside the workspace'));
  }
  if (!isAbsoluteFsPath(inputPath, platform)) {
    return err(appError('INVALID_INPUT', 'workspaceId is required unless path is absolute'));
  }

  const listed = await workspaces.list();
  const matches = listed.filter((workspace) => workspaceContains(workspace, inputPath, platform));
  if (matches.length === 0) {
    if (isFullBypassAuthorization(authorization) && listed[0] !== undefined) return ok(listed[0]);
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
  authorization?: InvocationAuthorization,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<Workspace>> {
  const source = await resolveWorkspaceForPath(workspaces, workspaceId, sourcePath, authorization, platform);
  if (!source.ok) return source;
  const destination = await resolveWorkspaceForPath(workspaces, workspaceId, destinationPath, authorization, platform);
  if (!destination.ok) return destination;
  if (source.value.id !== destination.value.id) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Source and destination must be in the same workspace'));
  }
  return source;
}

function workspaceContains(workspace: Workspace, inputPath: string, platform: NodeJS.Platform): boolean {
  const absolutePath = resolveHostPath(inputPath, platform);
  if (absolutePath === null) return false;
  return isHostPathWithin(workspace.realRootPath, absolutePath, platform) || isHostPathWithin(workspace.rootPath, absolutePath, platform);
}

function longestRoot(workspace: Workspace): string {
  return workspace.realRootPath.length >= workspace.rootPath.length ? workspace.realRootPath : workspace.rootPath;
}
