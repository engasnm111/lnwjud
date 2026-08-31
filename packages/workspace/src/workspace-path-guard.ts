import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { isWithin } from './path-containment.js';
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
}

export class WorkspacePathGuard {
  public constructor(
    private readonly secretPolicy: SecretPolicy = new SecretPolicy(),
    private readonly options: WorkspacePathGuardOptions = {},
  ) {}

  public async resolveForRead(
    workspace: Workspace,
    inputPath: string,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ResolvedWorkspacePath>> {
    const inputValidation = this.validateInput(inputPath);
    if (!inputValidation.ok) return inputValidation;

    const rootResult = await this.resolveRoot(workspace);
    if (!rootResult.ok) return rootResult;
    const explicitAbsolutePath = isAbsoluteFsPath(inputPath);
    const normalizedInput = process.platform === 'win32' ? inputPath : inputPath.replaceAll('\\', '/');
    const absolutePath = explicitAbsolutePath ? path.resolve(inputPath) : path.resolve(rootResult.value, normalizedInput);
    const allowOutside = explicitAbsolutePath && isFullBypassAuthorization(authorization);
    const outsideWorkspace = !isWithin(rootResult.value, absolutePath);
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
        if (!isWithin(rootResult.value, ancestorRealPath) && !allowOutside) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
        }
      }
      return err(appError('FILE_NOT_FOUND', 'File was not found'));
    }
    const realTargetOutsideWorkspace = !isWithin(rootResult.value, realTarget);
    if (realTargetOutsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const fsRelative = path.relative(rootResult.value, realTarget);
    const secretResult = this.assertSecretReadable(workspace, fsRelative, authorization);
    if (!secretResult.ok) return secretResult;

    try {
      await stat(realTarget);
    } catch {
      return err(appError('FILE_NOT_FOUND', 'File was not found'));
    }
    // Keep checkpoint/log identifiers in the separator style the caller used so
    // persisted records stay stable across host platforms (Windows roots on
    // POSIX hosts still report `a\b` while POSIX hosts report `a/b`).
    const relativePath = this.canonicalRelative(workspace, inputPath, fsRelative);
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
    const explicitAbsolutePath = isAbsoluteFsPath(inputPath);
    const normalizedInput = process.platform === 'win32' ? inputPath : inputPath.replaceAll('\\', '/');
    const absolutePath = explicitAbsolutePath ? path.resolve(inputPath) : path.resolve(rootResult.value, normalizedInput);
    const allowOutside = explicitAbsolutePath && isFullBypassAuthorization(authorization);
    const outsideWorkspace = !isWithin(rootResult.value, absolutePath);
    if (outsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const ancestorResult = await this.findExistingAncestor(absolutePath);
    if (!ancestorResult.ok) return ancestorResult;
    const ancestorRealPath = await realpath(ancestorResult.value.path);
    if (!isWithin(rootResult.value, ancestorRealPath) && !allowOutside) {
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
    const realTargetOutsideWorkspace = realTarget !== undefined && !isWithin(rootResult.value, realTarget);
    if (realTargetOutsideWorkspace && !allowOutside) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const fsRelative = realTarget === undefined
      ? path.relative(rootResult.value, absolutePath)
      : path.relative(rootResult.value, realTarget);
    const secretResult = this.assertSecretReadable(workspace, fsRelative, authorization);
    if (!secretResult.ok) return secretResult;

    const relativePath = this.canonicalRelative(workspace, inputPath, fsRelative);
    return ok({
      workspaceId: workspace.id,
      relativePath,
      absolutePath,
      ...(realTarget === undefined ? {} : { realPath: realTarget }),
      exists,
      ...(!outsideWorkspace && !realTargetOutsideWorkspace ? {} : { outsideWorkspace: true }),
    });
  }

  /** Persisted identifiers always use host-native separators so local FS tools,
   * logs, and adapters receive a consistent form on every platform. */
  private canonicalRelative(_workspace: Workspace, _inputPath: string, fsRelative: string): string {
    return fsRelative;
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
    return ok(undefined);
  }

  private async resolveRoot(workspace: Workspace): Promise<Result<string>> {
    try {
      return ok(await realpath(workspace.rootPath));
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    }
  }

  private async findExistingAncestor(absolutePath: string): Promise<Result<ExistingAncestor>> {
    const missing: string[] = [];
    let currentPath = absolutePath;
    while (true) {
      try {
        await lstat(currentPath);
        return ok({ path: currentPath, relativeMissing: missing });
      } catch {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path has no existing ancestor'));
        }
        missing.unshift(path.basename(currentPath));
        currentPath = parentPath;
      }
    }
  }
}

function isAbsoluteFsPath(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath) || path.posix.isAbsolute(inputPath);
}
