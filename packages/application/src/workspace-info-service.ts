import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import {
  isDriveRoot,
  isEMachineRoot,
  isUnderEDrive,
  type Workspace,
  type WorkspaceRepository,
  type WorkspaceService,
} from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';

export type WorkspaceKind = 'machine_root' | 'project';

export interface WorkspaceInfo {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  readonly kind: WorkspaceKind;
}

export interface RegisterWorkspaceRequest {
  readonly parentWorkspaceId: string;
  readonly path: string;
  readonly displayName?: string;
}

export class WorkspaceInfoService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly workspaceService?: WorkspaceService,
    private readonly unrestricted: boolean = false,
  ) {}

  public async list(actor: FileActor): Promise<Result<readonly WorkspaceInfo[]>> {
    void actor;
    const workspaces = await this.workspaces.list();
    return ok(workspaces.map((workspace) => this.toWorkspaceInfo(workspace)));
  }

  public async info(actor: FileActor, workspaceId: string): Promise<Result<WorkspaceInfo>> {
    void actor;
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null
      ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'))
      : ok(this.toWorkspaceInfo(workspace));
  }

  private toWorkspaceInfo(workspace: Workspace): WorkspaceInfo {
    const isRoot = this.unrestricted
      ? isDriveRoot(workspace.realRootPath) || isDriveRoot(workspace.rootPath)
      : isEMachineRoot(workspace.realRootPath) || isEMachineRoot(workspace.rootPath);
    return {
      id: workspace.id,
      displayName: workspace.displayName,
      rootPath: workspace.rootPath,
      realRootPath: workspace.realRootPath,
      createdAt: workspace.createdAt,
      kind: isRoot ? 'machine_root' : 'project',
    };
  }

  public async register(actor: FileActor, request: RegisterWorkspaceRequest): Promise<Result<WorkspaceInfo>> {
    void actor;
    if (this.workspaceService === undefined) {
      return err(appError('INTERNAL_ERROR', 'Workspace registration is unavailable'));
    }

    const parent = await this.workspaces.get(request.parentWorkspaceId);
    if (parent === null) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Parent workspace was not found'));
    }
    if (this.unrestricted) {
      if (!isDriveRoot(parent.realRootPath) && !isDriveRoot(parent.rootPath)) {
        return err(appError('INVALID_INPUT', 'parentWorkspaceId must be a drive-root machine root'));
      }
    } else if (!isEMachineRoot(parent.realRootPath) && !isEMachineRoot(parent.rootPath)) {
      return err(appError('INVALID_INPUT', 'parentWorkspaceId must be the E:\\ machine root'));
    }

    const absolutePath = path.isAbsolute(request.path)
      ? path.resolve(request.path)
      : path.resolve(parent.rootPath, request.path);

    if (!this.unrestricted && !isUnderEDrive(absolutePath)) {
      return err(appError('INVALID_INPUT', 'Registered path must be under E:\\'));
    }

    const existing = await this.workspaces.list();
    const normalizedTarget = normalizeCompare(absolutePath);
    const duplicate = existing.find((entry) => normalizeCompare(entry.realRootPath) === normalizedTarget
      || normalizeCompare(entry.rootPath) === normalizedTarget);
    if (duplicate !== undefined) {
      return ok(this.toWorkspaceInfo(duplicate));
    }

    const displayName = request.displayName?.trim()
      || path.basename(absolutePath)
      || 'Workspace';
    const added = await this.workspaceService.add(displayName, absolutePath);
    if (!added.ok) return added;
    return ok(this.toWorkspaceInfo(added.value));
  }
}

function normalizeCompare(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const withSep = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  return withSep.toLowerCase();
}
