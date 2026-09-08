import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result, type WorkspaceId } from '@lnwjud/domain';
import type { Workspace } from './workspace-types.js';
import { isPosixMountRoot, resolveHostPath } from './filesystem-root.js';

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  get(id: WorkspaceId): Promise<Workspace | null>;
  insert(workspace: Workspace): Promise<void>;
  delete(id: WorkspaceId): Promise<void>;
}

export interface WorkspaceServiceOptions {
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
}

export class WorkspaceService {
  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly options: WorkspaceServiceOptions = {},
  ) {}

  public async add(displayName: string, rootPath: string): Promise<Result<Workspace>> {
    if (displayName.trim().length === 0 || rootPath.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Workspace name and root path are required'));
    }

    const platform = this.options.platform ?? process.platform;
    const absoluteRootPath = resolveHostPath(rootPath, platform);
    if (absoluteRootPath === null) {
      return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    }
    if (isPosixMountRoot(absoluteRootPath, platform)) {
      return err(appError('INVALID_INPUT', 'A POSIX filesystem mount root cannot be registered as a project'));
    }
    let rootStats;
    try {
      rootStats = await stat(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    }
    if (!rootStats.isDirectory()) {
      return err(appError('INVALID_INPUT', 'Workspace root must be a directory'));
    }

    let canonicalRootPath: string;
    try {
      canonicalRootPath = await realpath(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be canonicalized'));
    }

    const workspace: Workspace = {
      id: randomUUID(),
      displayName: displayName.trim(),
      rootPath: absoluteRootPath,
      realRootPath: canonicalRootPath,
      createdAt: new Date().toISOString(),
    };
    await this.repository.insert(workspace);
    return ok(workspace);
  }

  public list(): Promise<Workspace[]> {
    return this.repository.list();
  }

  public get(id: WorkspaceId): Promise<Workspace | null> {
    return this.repository.get(id);
  }

  public delete(id: WorkspaceId): Promise<void> {
    return this.repository.delete(id);
  }
}
