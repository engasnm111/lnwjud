import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { isUnderEDrive } from './machine-root.js';
import { isWithin } from './path-containment.js';
import { SecretPolicy } from './secret-policy.js';
import type { ResolvedWorkspacePath, Workspace } from './workspace-types.js';

interface ExistingAncestor {
  readonly path: string;
  readonly relativeMissing: readonly string[];
}

export class WorkspacePathGuard {
  public constructor(private readonly secretPolicy: SecretPolicy = new SecretPolicy()) {}

  public async resolveForRead(workspace: Workspace, inputPath: string): Promise<Result<ResolvedWorkspacePath>> {
    const inputValidation = this.validateInput(inputPath);
    if (!inputValidation.ok) return inputValidation;

    const rootResult = await this.resolveRoot(workspace);
    if (!rootResult.ok) return rootResult;
    const absolutePath = path.resolve(workspace.rootPath, inputPath);
    if (!isWithin(workspace.rootPath, absolutePath)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    let realTarget: string;
    try {
      realTarget = await realpath(absolutePath);
    } catch {
      const ancestorResult = await this.findExistingAncestor(absolutePath);
      if (ancestorResult.ok) {
        const ancestorRealPath = await realpath(ancestorResult.value.path);
        if (!isWithin(rootResult.value, ancestorRealPath)) {
          return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
        }
      }
      return err(appError('FILE_NOT_FOUND', 'File was not found'));
    }
    if (!isWithin(rootResult.value, realTarget)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const relativePath = path.relative(rootResult.value, realTarget);
    const secretResult = this.assertSecretReadable(workspace, relativePath);
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
    });
  }

  public async resolveForWrite(workspace: Workspace, inputPath: string): Promise<Result<ResolvedWorkspacePath>> {
    const inputValidation = this.validateInput(inputPath);
    if (!inputValidation.ok) return inputValidation;

    const rootResult = await this.resolveRoot(workspace);
    if (!rootResult.ok) return rootResult;
    const absolutePath = path.resolve(workspace.rootPath, inputPath);
    if (!isWithin(workspace.rootPath, absolutePath)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const ancestorResult = await this.findExistingAncestor(absolutePath);
    if (!ancestorResult.ok) return ancestorResult;
    const ancestorRealPath = await realpath(ancestorResult.value.path);
    if (!isWithin(rootResult.value, ancestorRealPath)) {
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
    if (realTarget !== undefined && !isWithin(rootResult.value, realTarget)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the workspace'));
    }

    const relativePath = realTarget === undefined
      ? path.relative(rootResult.value, absolutePath)
      : path.relative(rootResult.value, realTarget);
    const secretResult = this.assertSecretReadable(workspace, relativePath);
    if (!secretResult.ok) return secretResult;

    return ok({
      workspaceId: workspace.id,
      relativePath,
      absolutePath,
      ...(realTarget === undefined ? {} : { realPath: realTarget }),
      exists,
    });
  }

  private assertSecretReadable(workspace: Workspace, relativePath: string): Result<void> {
    // Trusted E: agent surface: secrets and hidden files are intentionally readable.
    if (isUnderEDrive(workspace.realRootPath) || isUnderEDrive(workspace.rootPath)) {
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
