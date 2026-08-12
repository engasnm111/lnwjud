import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';

export interface WorkspaceInfo {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
}

export class WorkspaceInfoService {
  public constructor(private readonly workspaces: WorkspaceRepository) {}

  public async list(actor: FileActor): Promise<Result<readonly WorkspaceInfo[]>> {
    void actor;
    const workspaces = await this.workspaces.list();
    return ok(workspaces.map(toWorkspaceInfo));
  }

  public async info(actor: FileActor, workspaceId: string): Promise<Result<WorkspaceInfo>> {
    void actor;
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null
      ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'))
      : ok(toWorkspaceInfo(workspace));
  }
}

function toWorkspaceInfo(workspace: Workspace): WorkspaceInfo {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    rootPath: workspace.rootPath,
    realRootPath: workspace.realRootPath,
    createdAt: workspace.createdAt,
  };
}
