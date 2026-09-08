import { lstat, realpath, stat } from 'node:fs/promises';
import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { hostPathApi, isAbsoluteHostPath, isForeignAbsolutePath, isHostPathWithin, relativeHostPath, resolveHostPath } from './filesystem-root.js';
import { SecretPolicy } from './secret-policy.js';
import type { ResolvedWorkspacePath, Workspace } from './workspace-types.js';

interface ExistingAncestor {
  readonly path: string;
  readonly relativeMissing: readonly string[];
}

export interface WorkspacePathGuardOptions {
  /** When true, secret-file checks are bypassed for every drive (full-access mode). */
  readonly unrestricted?: boolean;
  /** Registered/selected workspaces are an explicit trust boundary for agent access. */
  readonly trustedWorkspaceAccess?: boolean;
  /** Test/fixture override; production uses the actual host platform. */
  readonly platform?: NodeJS.Platform;
}

export class WorkspacePathGuard {
  private readonly platform: NodeJS.Platform;

  public constructor(
    private readonly secretPolicy: SecretPolicy = new SecretPolicy(),
    private readonly options: WorkspacePathGuardOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
  }

  public async resolveForRead(
    workspace: Workspace,
    inputPath: string,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ResolvedWorkspacePath>> {
    const inputValidation = this.validateInput(inputPath);
    if (!inputValidation.ok) return inputValidation;

    const rootResult = await this.resolveRoot(workspace);
    if (!rootResult.ok) return rootResult;
    const explicitAbsolutePath = isAbsoluteHostPath(inputPath, this.platform);
    const absolutePath = explicitAbsolutePath
      ? resolveHostPath(inputPath, this.platform)!
      : resolveHostPath(hostPathApi(this.platform).join(rootResult.value, inputPath), this.platform)!;
    const allowOutside = explicitAbsolutePath && isFullBypassAuthorization(authorization);
    const outsideWorkspace = !isHostPathWithin(rootResult.value, absolutePath, this.platform);
    if (outsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    let realTarget: string;
    try {
      realTarget = await realpath(absolutePath);
    } catch {
      const ancestorResult = await this.findExistingAncestor(absolutePath);
      if (ancestorResult.ok) {
        const ancestorRealPath = await realpath(ancestorResult.value.path);
        if (!isHostPathWithin(rootResult.value, ancestorRealPath, this.platform) && !allowOutside) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
        }
      }
      return err(appError('FILE_NOT_FOUND', 'File was not found'));
    }
    const realTargetOutsideWorkspace = !isHostPathWithin(rootResult.value, realTarget, this.platform);
    if (realTargetOutsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const relativePath = relativeHostPath(rootResult.value, realTarget, this.platform);
    if (relativePath === null) return err(appError('INVALID_INPUT', 'Path uses a foreign host syntax'));
    const secretResult = this.assertSecretReadable(workspace, relativePath, authorization);
    if (!secretResult.ok) return secretResult;

    try {
      await stat(realTarget);
    } catch {
      return err(appError('FILE_NOT_FOUND', 'File was not found'));
    }
    return ok({
      workspaceId: workspace.id,
      relativePath,
      absolutePath,
      realPath: realTarget,
      exists: true,
      ...(!outsideWorkspace && !realTargetOutsideWorkspace ? {} : { outsideWorkspace: true }),
    });
  }

  public async resolveForWrite(
    workspace: Workspace,
    inputPath: string,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ResolvedWorkspacePath>> {
    const inputValidation = this.validateInput(inputPath);
    if (!inputValidation.ok) return inputValidation;

    const rootResult = await this.resolveRoot(workspace);
    if (!rootResult.ok) return rootResult;
    const explicitAbsolutePath = isAbsoluteHostPath(inputPath, this.platform);
    const absolutePath = explicitAbsolutePath
      ? resolveHostPath(inputPath, this.platform)!
      : resolveHostPath(hostPathApi(this.platform).join(rootResult.value, inputPath), this.platform)!;
    const allowOutside = explicitAbsolutePath && isFullBypassAuthorization(authorization);
    const outsideWorkspace = !isHostPathWithin(rootResult.value, absolutePath, this.platform);
    if (outsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const ancestorResult = await this.findExistingAncestor(absolutePath);
    if (!ancestorResult.ok) return ancestorResult;
    const ancestorRealPath = await realpath(ancestorResult.value.path);
    if (!isHostPathWithin(rootResult.value, ancestorRealPath, this.platform) && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    let exists = false;
    let realTarget: string | undefined;
    try {
      realTarget = await realpath(absolutePath);
      exists = true;
    } catch {
      exists = false;
    }
    const realTargetOutsideWorkspace = realTarget !== undefined && !isHostPathWithin(rootResult.value, realTarget, this.platform);
    if (realTargetOutsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const relativePath = realTarget === undefined
      ? relativeHostPath(rootResult.value, absolutePath, this.platform)
      : relativeHostPath(rootResult.value, realTarget, this.platform);
    if (relativePath === null) return err(appError('INVALID_INPUT', 'Path uses a foreign host syntax'));
    const secretResult = this.assertSecretReadable(workspace, relativePath, authorization);
    if (!secretResult.ok) return secretResult;

    return ok({
      workspaceId: workspace.id,
      relativePath,
      absolutePath,
      ...(realTarget === undefined ? {} : { realPath: realTarget }),
      exists,
      ...(!outsideWorkspace && !realTargetOutsideWorkspace ? {} : { outsideWorkspace: true }),
    });
  }

  private assertSecretReadable(workspace: Workspace, relativePath: string, authorization?: InvocationAuthorization): Result<void> {
    void workspace;
    if (isFullBypassAuthorization(authorization) || this.options.unrestricted === true || this.options.trustedWorkspaceAccess === true) {
      return ok(undefined);
    }
    return this.secretPolicy.assertReadable(relativePath);
  }

  private validateInput(inputPath: string): Result<void> {
    if (typeof inputPath !== 'string' || inputPath.includes('\0')) {
      return err(appError('INVALID_INPUT', 'Path must be a valid string'));
    }
    if (isForeignAbsolutePath(inputPath, this.platform)
      || (this.platform !== 'win32' && inputPath.includes('\\'))) {
      return err(appError('INVALID_INPUT', 'Path uses a foreign host syntax'));
    }
    return ok(undefined);
  }

  private async resolveRoot(workspace: Workspace): Promise<Result<string>> {
    const rootPath = resolveHostPath(workspace.rootPath, this.platform);
    if (rootPath === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    try {
      return ok(await realpath(rootPath));
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    }
  }

  private async findExistingAncestor(absolutePath: string): Promise<Result<ExistingAncestor>> {
    const missing: string[] = [];
    let currentPath = absolutePath;
    const api = hostPathApi(this.platform);
    while (true) {
      try {
        await lstat(currentPath);
        return ok({ path: currentPath, relativeMissing: missing });
      } catch {
        const parentPath = api.dirname(currentPath);
        if (parentPath === currentPath) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path has no existing ancestor'));
        }
        missing.unshift(api.basename(currentPath));
        currentPath = parentPath;
      }
    }
  }
}
