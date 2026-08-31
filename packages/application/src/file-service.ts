import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile as readFsFile, readdir, rename, rm, rmdir, unlink, writeFile as writeFsFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  MAX_MULTI_FILE_BYTES,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import {
  AtomicFileWriter,
  MAX_FILE_WRITE_BYTES,
  PatchApplier,
  TextFileReader,
  UnboundedFileReader,
  ensureParentDirectory,
  mapNodeFsError,
  nodeErrorCode,
  type FilePatch,
  type LineRange,
} from '@lnwjud/filesystem';
import { DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import { isProtectedCriticalPath } from '@lnwjud/shared';
import { isWithin, WorkspacePathGuard, type ResolvedWorkspacePath, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { CheckpointServicePort } from './checkpoint-service.js';
import { resolveSharedWorkspace, resolveWorkspaceForPath } from './workspace-locator.js';

export interface FileActor {
  readonly clientId: string;
  readonly clientName: string;
  /** Stable MCP transport session identity when execution is session-scoped. */
  readonly sessionId?: string;
}

export interface ReadFileRequest extends LineRange {
  readonly path: string;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly encoding?: 'utf8' | 'base64';
  readonly mimeType?: string;
  readonly byteLength?: number;
}

export interface ReadFilesRequest {
  readonly files: readonly ReadFileRequest[];
}

export interface ReadFilesResult {
  readonly files: readonly ReadFileResult[];
}

export interface FileServiceDependencies {
  readonly writer?: AtomicFileWriter;
  readonly patchApplier?: PatchApplier;
  readonly checkpointService?: CheckpointServicePort;
  readonly permissionEngine?: PermissionEngine;
  readonly profile?: PermissionProfile;
  readonly profileProvider?: () => PermissionProfile;
  readonly unboundedReader?: UnboundedFileReader;
  /** When true, every workspace uses the trusted read path (binary/base64, no size cap). */
  readonly unrestricted?: boolean;
  /** Registered/selected workspaces are trusted even when global unrestricted mode is off. */
  readonly trustedWorkspaceAccess?: boolean;
  /** When true, filesystem deletion may proceed without per-call userConfirmed. Hard workspace-root blocks remain. */
  readonly allowDeleteWithoutConfirmation?: () => boolean;
  /** Protected critical paths still require explicit human confirmation. */
  readonly protectCriticalFiles?: () => boolean;
  /** Move deleted targets to recovery trash instead of permanently unlinking them. */
  readonly recoverableDelete?: () => boolean;
  readonly recoveryTrashRoot?: string;
}

export interface WriteFileRequest {
  readonly path: string;
  readonly content: string;
  /** Existing targets are create-only unless this is explicitly true. */
  readonly overwriteExisting?: boolean;
  /** Required together with overwriteExisting after human approval. */
  readonly userConfirmed?: boolean;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly checkpointId?: string;
}

export interface ApplyPatchRequest {
  readonly files: readonly FilePatch[];
  /** Required when any patch entry replaces an existing file. */
  readonly userConfirmed?: boolean;
}

export interface ApplyPatchResult {
  readonly paths: readonly string[];
  readonly checkpointId?: string;
}

export interface EditFileRequest {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  /** Exact precondition; defaults to one matching occurrence. */
  readonly expectedOccurrences?: number;
  /** Required when the target is a protected critical file. */
  readonly userConfirmed?: boolean;
}

export interface EditFileResult {
  readonly path: string;
  readonly replacements: number;
  readonly bytesWritten: number;
  readonly checkpointId?: string;
}

export interface MoveFileRequest {
  readonly sourcePath: string;
  readonly destinationPath: string;
  /** Moving removes the source path and always requires human confirmation. */
  readonly userConfirmed?: boolean;
}

export interface CopyFileRequest {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface CopyFileResult {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface DeleteFileRequest {
  readonly path: string;
  /** After the human confirms in chat, callers must set this true. */
  readonly userConfirmed?: boolean;
}

export interface DeleteFileResult {
  readonly path: string;
  readonly recoverable: boolean;
  readonly checkpointId?: string;
  readonly recoveryId?: string;
  readonly recoveryPath?: string;
}

export interface RestoreDeletedFileRequest {
  readonly recoveryId: string;
  /** Required after a human explicitly chooses to restore the item. */
  readonly userConfirmed?: boolean;
}

export interface RestoreDeletedFileResult {
  readonly recoveryId: string;
  readonly path: string;
  /** Recovery item containing the live replacement that was preserved before undoing a replacement backup. */
  readonly rollbackRecoveryId?: string;
}

export type RecoveryItemKind = 'deleted' | 'replacement_backup';

export interface RecoveryItem {
  readonly recoveryId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly deletedAt: string;
  readonly isDirectory: boolean;
  readonly payloadAvailable: boolean;
  readonly kind: RecoveryItemKind;
}

export interface RecoveryItemList {
  readonly recoveryTrashRoot: string | null;
  readonly items: readonly RecoveryItem[];
}

export interface PrepareExternalFileMutationRequest {
  /** Existing read-only inputs consumed by the external mutation provider. */
  readonly sourcePaths?: readonly string[];
  /** File that the external provider may create or replace. */
  readonly targetPath: string;
  readonly userConfirmed?: boolean;
}

export interface PreparedExternalFileMutation {
  readonly sourcePaths: readonly string[];
  readonly targetPath: string;
  readonly targetRelativePath: string;
  readonly replacementBackup?: {
    readonly recoveryId: string;
    readonly recoveryPath: string;
  };
}

export class FileService {
  private readonly writer: AtomicFileWriter;
  private readonly patchApplier: PatchApplier;
  private readonly checkpointService: CheckpointServicePort | undefined;
  private readonly permissionEngine: PermissionEngine;
  private readonly profileProvider: () => PermissionProfile;
  private readonly unboundedReader: UnboundedFileReader;
  private readonly unrestricted: boolean;
  private readonly trustedWorkspaceAccess: boolean;
  private readonly allowDeleteWithoutConfirmation: () => boolean;
  private readonly protectCriticalFiles: () => boolean;
  private readonly recoverableDelete: () => boolean;
  private readonly recoveryTrashRoot: string | undefined;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly reader: TextFileReader = new TextFileReader(),
    dependencies: FileServiceDependencies = {},
  ) {
    this.writer = dependencies.writer ?? new AtomicFileWriter();
    this.patchApplier = dependencies.patchApplier ?? new PatchApplier();
    this.checkpointService = dependencies.checkpointService;
    this.permissionEngine = dependencies.permissionEngine ?? new DefaultPermissionEngine();
    this.profileProvider = dependencies.profileProvider ?? ((): PermissionProfile => dependencies.profile ?? permissionProfiles.balanced);
    this.unboundedReader = dependencies.unboundedReader ?? new UnboundedFileReader();
    this.unrestricted = dependencies.unrestricted === true;
    this.trustedWorkspaceAccess = dependencies.trustedWorkspaceAccess === true;
    this.allowDeleteWithoutConfirmation = dependencies.allowDeleteWithoutConfirmation ?? ((): boolean => false);
    this.protectCriticalFiles = dependencies.protectCriticalFiles ?? ((): boolean => true);
    this.recoverableDelete = dependencies.recoverableDelete ?? ((): boolean => true);
    this.recoveryTrashRoot = dependencies.recoveryTrashRoot;
  }

  private isTrustedWorkspace(workspace: Workspace): boolean {
    void workspace;
    return this.unrestricted || this.trustedWorkspaceAccess;
  }

  public async readFile(
    actor: FileActor,
    workspaceId: string | undefined,
    request: ReadFileRequest,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ReadFileResult>> {
    void actor;
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path, authorization);
    if (!workspaceResult.ok) return workspaceResult;
    const workspace = workspaceResult.value;
    const resolved = await this.guard.resolveForRead(workspace, request.path, authorization);
    if (!resolved.ok) return resolved;

    const absolute = resolved.value.realPath ?? resolved.value.absolutePath;
    if (this.isTrustedWorkspace(workspace)) {
      if (request.startLine !== undefined || request.endLine !== undefined) {
        const textResult = await this.reader.read(absolute, request);
        if (textResult.ok) {
          return ok({ path: resultPath(resolved.value), ...textResult.value, encoding: 'utf8', mimeType: 'text/plain' });
        }
      }
      const unbounded = await this.unboundedReader.read(absolute);
      if (!unbounded.ok) return unbounded;
      return ok({
        path: resultPath(resolved.value),
        content: unbounded.value.content,
        startLine: unbounded.value.startLine,
        endLine: unbounded.value.endLine,
        encoding: unbounded.value.encoding,
        mimeType: unbounded.value.mimeType,
        byteLength: unbounded.value.byteLength,
      });
    }

    const readResult = await this.reader.read(absolute, request);
    if (!readResult.ok) return readResult;
    return ok({ path: resultPath(resolved.value), ...readResult.value, encoding: 'utf8' });
  }

  public async readFiles(
    actor: FileActor,
    workspaceId: string | undefined,
    request: ReadFilesRequest,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ReadFilesResult>> {
    void actor;
    if (!Array.isArray(request.files) || request.files.length > 20) {
      return err(appError('INVALID_INPUT', 'At most 20 files may be read'));
    }
    const firstPath = request.files[0]?.path;
    if (typeof firstPath !== 'string') return err(appError('INVALID_INPUT', 'At least one file is required'));
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, firstPath, authorization);
    if (!workspaceResult.ok) return workspaceResult;
    const trustedWorkspace = this.isTrustedWorkspace(workspaceResult.value);

    const files: ReadFileResult[] = [];
    let totalBytes = 0;
    for (const fileRequest of request.files) {
      const fileWorkspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, fileRequest.path, authorization);
      if (!fileWorkspace.ok) return fileWorkspace;
      if (fileWorkspace.value.id !== workspaceResult.value.id) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'All files must be in the same workspace'));
      }
      const result = await this.readFile(actor, fileWorkspace.value.id, fileRequest, authorization);
      if (!result.ok) return result;
      totalBytes += result.value.byteLength
        ?? Buffer.byteLength(result.value.content, result.value.encoding === 'base64' ? 'base64' : 'utf8');
      if (!trustedWorkspace && totalBytes > MAX_MULTI_FILE_BYTES) {
        return err(appError('FILE_TOO_LARGE', 'Total file content exceeds the maximum read size'));
      }
      files.push(result.value);
    }
    return ok({ files });
  }

  public async writeFile(actor: FileActor, workspaceId: string | undefined, request: WriteFileRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<WriteFileResult>> {
    if (typeof request?.path !== 'string' || typeof request.content !== 'string') {
      return err(appError('INVALID_INPUT', 'Write request is invalid'));
    }
    if (Buffer.byteLength(request.content, 'utf8') > MAX_FILE_WRITE_BYTES) {
      return err(appError('FILE_TOO_LARGE', 'File exceeds the maximum write size'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!workspaceResult.ok) return workspaceResult;
    const workspace = workspaceResult.value;
    const resolved = await this.guard.resolveForWrite(workspace, request.path, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!resolved.ok) return resolved;
    const existing = await this.inspectExistingFile(resolved.value.absolutePath);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!existing.ok) return existing;
    if (existing.value === 'directory') return err(appError('INVALID_INPUT', 'Directories cannot be written as files'));
    const fullProfile = this.profileProvider().name === 'full';
    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true) || fullProfile;
    if (existing.value && request.overwriteExisting !== true && !fullProfile) {
      return err(appError('INVALID_INPUT', 'Target already exists; use edit_file for a narrow repair or set overwriteExisting after reviewing the full replacement'));
    }
    if (existing.value && !applicationApproved) {
      return err(appError('PERMISSION_REQUIRED', 'Replacing an existing file requires explicit user confirmation'));
    }
    const permission = this.decide(workspace.id, 'write_file', 'WRITE', resolved.value.relativePath, false, applicationApproved, authorization);
    if (!permission.ok) return permission;

    let checkpointId: string | undefined;
    if (existing.value && resolved.value.outsideWorkspace !== true) {
      const checkpoint = await this.createCheckpoint(actor, workspace.id, [resolved.value.relativePath]);
      if (isAborted(signal)) return cancelledFileMutation();
      if (!checkpoint.ok) return checkpoint;
      checkpointId = checkpoint.value.id;
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const writeResult = await this.writer.write(resolved.value.realPath ?? resolved.value.absolutePath, request.content);
    if (!writeResult.ok) return writeResult;
    return ok({
      path: resultPath(resolved.value),
      bytesWritten: Buffer.byteLength(request.content, 'utf8'),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  }

  public async applyPatch(actor: FileActor, workspaceId: string | undefined, request: ApplyPatchRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<ApplyPatchResult>> {
    const validation = this.patchApplier.validate(request?.files ?? []);
    if (!validation.ok) return validation;
    const firstPath = request.files[0]?.path;
    if (typeof firstPath !== 'string') return err(appError('INVALID_INPUT', 'At least one file is required'));
    if (isAborted(signal)) return cancelledFileMutation();
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, firstPath, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!workspaceResult.ok) return workspaceResult;
    const workspace = workspaceResult.value;

    const resolvedFiles: { readonly patch: FilePatch; readonly absolutePath: string; readonly path: string }[] = [];
    const checkpointPaths: string[] = [];
    let existingTargets = 0;
    for (const patch of request.files) {
      if (isAborted(signal)) return cancelledFileMutation();
      const fileWorkspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, patch.path, authorization);
      if (isAborted(signal)) return cancelledFileMutation();
      if (!fileWorkspace.ok) return fileWorkspace;
      if (fileWorkspace.value.id !== workspace.id) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'All files must be in the same workspace'));
      }
      const resolved = await this.guard.resolveForWrite(workspace, patch.path, authorization);
      if (isAborted(signal)) return cancelledFileMutation();
      if (!resolved.ok) return resolved;
      const existing = await this.inspectExistingFile(resolved.value.absolutePath);
      if (isAborted(signal)) return cancelledFileMutation();
      if (!existing.ok) return existing;
      if (existing.value === 'directory') return err(appError('INVALID_INPUT', 'Directories cannot be patched as files'));
      if (existing.value) {
        existingTargets += 1;
        if (resolved.value.outsideWorkspace !== true) checkpointPaths.push(resolved.value.relativePath);
      }
      resolvedFiles.push({
        patch,
        absolutePath: resolved.value.realPath ?? resolved.value.absolutePath,
        path: resultPath(resolved.value),
      });
    }

    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true);
    const permission = this.decide(workspace.id, 'apply_patch', 'WRITE', undefined, false, applicationApproved, authorization);
    if (!permission.ok) return permission;
    if (existingTargets > 0 && !applicationApproved) {
      return err(appError('PERMISSION_REQUIRED', 'Replacing existing file content with apply_patch requires explicit user confirmation; prefer edit_file for narrow repairs'));
    }
    let checkpointId: string | undefined;
    if (checkpointPaths.length > 0) {
      const checkpoint = await this.createCheckpoint(actor, workspace.id, checkpointPaths);
      if (isAborted(signal)) return cancelledFileMutation();
      if (!checkpoint.ok) return checkpoint;
      checkpointId = checkpoint.value.id;
    }
    for (const resolved of resolvedFiles) {
      if (isAborted(signal)) return cancelledFileMutation();
      const writeResult = await this.writer.write(resolved.absolutePath, resolved.patch.content);
      if (!writeResult.ok) return writeResult;
    }
    return ok({
      paths: resolvedFiles.map((resolved) => resolved.path),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  }

  public async editFile(actor: FileActor, workspaceId: string | undefined, request: EditFileRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<EditFileResult>> {
    const expectedOccurrences = request?.expectedOccurrences ?? 1;
    if (typeof request?.path !== 'string' || typeof request.oldText !== 'string' || request.oldText.length === 0
      || typeof request.newText !== 'string' || !Number.isInteger(expectedOccurrences) || expectedOccurrences < 1 || expectedOccurrences > 100) {
      return err(appError('INVALID_INPUT', 'Exact edit request is invalid'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path, authorization);
    if (!workspaceResult.ok) return workspaceResult;
    const workspace = workspaceResult.value;
    const resolved = await this.guard.resolveForRead(workspace, request.path, authorization);
    if (!resolved.ok) return resolved;
    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true);
    if (!isFullBypassAuthorization(authorization) && !applicationApproved && this.protectCriticalFiles() && isProtectedCriticalPath(resolved.value.relativePath)) {
      return err(appError('PERMISSION_REQUIRED', 'Editing a protected critical file requires explicit user confirmation'));
    }
    const absolutePath = resolved.value.realPath ?? resolved.value.absolutePath;
    let content: string;
    try {
      const data = await readFsFile(absolutePath);
      if (data.byteLength > MAX_FILE_WRITE_BYTES) return err(appError('FILE_TOO_LARGE', 'File exceeds the maximum edit size'));
      if (data.subarray(0, 8192).includes(0)) return err(appError('BINARY_FILE', 'Binary files cannot be edited as text'));
      content = data.toString('utf8');
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'File could not be read for editing'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const occurrences = countOccurrences(content, request.oldText);
    if (occurrences !== expectedOccurrences) {
      return err(appError('INVALID_INPUT', `Exact edit conflict: expected ${expectedOccurrences} occurrence(s), found ${occurrences}`));
    }
    const nextContent = content.split(request.oldText).join(request.newText);
    if (Buffer.byteLength(nextContent, 'utf8') > MAX_FILE_WRITE_BYTES) return err(appError('FILE_TOO_LARGE', 'Edited file exceeds the maximum write size'));
    const permission = this.decide(workspace.id, 'edit_file', 'WRITE', resolved.value.relativePath, false, applicationApproved, authorization);
    if (!permission.ok) return permission;
    let checkpointId: string | undefined;
    if (resolved.value.outsideWorkspace !== true) {
      const checkpoint = await this.createCheckpoint(actor, workspace.id, [resolved.value.relativePath]);
      if (!checkpoint.ok) return checkpoint;
      checkpointId = checkpoint.value.id;
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const writeResult = await this.writer.write(absolutePath, nextContent);
    if (!writeResult.ok) return writeResult;
    return ok({
      path: resultPath(resolved.value),
      replacements: occurrences,
      bytesWritten: Buffer.byteLength(nextContent, 'utf8'),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  }

  public async moveFile(actor: FileActor, workspaceId: string | undefined, request: MoveFileRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<void>> {
    const prepared = await this.prepareTransfer(actor, workspaceId, request, 'move_file', signal, authorization);
    if (!prepared.ok) return prepared;
    if (isAborted(signal)) return cancelledFileMutation();
    const { sourceAbs, destinationAbs, isDirectory } = prepared.value;
    const parent = await ensureParentDirectory(destinationAbs);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!parent.ok) return parent;
    try {
      await rename(sourceAbs, destinationAbs);
    } catch (error: unknown) {
      if (nodeErrorCode(error) !== 'EXDEV') return err(mapNodeFsError(error, 'File move failed'));
      try {
        if (isAborted(signal)) return cancelledFileMutation();
        if (isDirectory) await cp(sourceAbs, destinationAbs, { recursive: true, errorOnExist: true, force: false });
        else await copyFile(sourceAbs, destinationAbs, fsConstants.COPYFILE_EXCL);
        if (isAborted(signal)) return cancelledFileMutation();
        await rm(sourceAbs, { recursive: isDirectory, force: false });
      } catch (copyError: unknown) {
        return err(mapNodeFsError(copyError, 'File move failed'));
      }
    }
    return ok(undefined);
  }

  public async copyFile(actor: FileActor, workspaceId: string | undefined, request: CopyFileRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<CopyFileResult>> {
    const prepared = await this.prepareTransfer(actor, workspaceId, request, 'copy_file', signal, authorization);
    if (!prepared.ok) return prepared;
    if (isAborted(signal)) return cancelledFileMutation();
    const { sourceAbs, destinationAbs, isDirectory, sourceRelative, destinationRelative } = prepared.value;
    const parent = await ensureParentDirectory(destinationAbs);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!parent.ok) return parent;
    try {
      if (isDirectory) await cp(sourceAbs, destinationAbs, { recursive: true, errorOnExist: true, force: false });
      else await copyFile(sourceAbs, destinationAbs, fsConstants.COPYFILE_EXCL);
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'File copy failed'));
    }
    return ok({ sourcePath: sourceRelative, destinationPath: destinationRelative });
  }

  /**
   * Resolves every path against one workspace and snapshots an existing binary
   * or text target into Recovery Trash before an external provider can replace it.
   */
  public async prepareExternalFileMutation(
    actor: FileActor,
    workspaceId: string,
    request: PrepareExternalFileMutationRequest,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<PreparedExternalFileMutation>> {
    if (typeof request?.targetPath !== 'string' || !Array.isArray(request.sourcePaths ?? [])) {
      return err(appError('INVALID_INPUT', 'External file mutation request is invalid'));
    }
    const sourcePaths = request.sourcePaths ?? [];
    if (sourcePaths.length > 32 || sourcePaths.some((source) => typeof source !== 'string')) {
      return err(appError('INVALID_INPUT', 'External file mutation has too many source files'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));

    const resolvedSources: string[] = [];
    for (const sourcePath of sourcePaths) {
      if (isAborted(signal)) return cancelledFileMutation();
      const source = await this.guard.resolveForRead(workspace, sourcePath, authorization);
      if (!source.ok) return source;
      const sourceType = await this.inspectExistingFile(source.value.realPath ?? source.value.absolutePath);
      if (!sourceType.ok) return sourceType;
      if (sourceType.value !== true) return err(appError('INVALID_INPUT', 'External mutation sources must be existing files'));
      resolvedSources.push(source.value.realPath ?? source.value.absolutePath);
    }

    const target = await this.guard.resolveForWrite(workspace, request.targetPath, authorization);
    if (!target.ok) return target;
    if (target.value.outsideWorkspace !== true && target.value.relativePath.length === 0) return err(appError('PERMISSION_DENIED', 'Workspace root cannot be an external mutation target'));
    const targetType = await this.inspectExistingFile(target.value.realPath ?? target.value.absolutePath);
    if (!targetType.ok) return targetType;
    if (targetType.value === 'directory') return err(appError('INVALID_INPUT', 'External mutation target must be a file'));
    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true);
    if (!applicationApproved) {
      return err(appError('PERMISSION_REQUIRED', 'External file replacement requires explicit user confirmation'));
    }
    if (!isFullBypassAuthorization(authorization) && this.protectCriticalFiles() && isProtectedCriticalPath(target.value.relativePath) && !applicationApproved) {
      return err(appError('PERMISSION_REQUIRED', 'Replacing a protected critical file requires explicit user confirmation'));
    }
    const permission = this.decide(
      workspaceId,
      'external_file_mutation',
      'DANGEROUS',
      target.value.relativePath,
      true,
      applicationApproved,
      authorization,
    );
    if (!permission.ok) return permission;

    let replacementBackup: PreparedExternalFileMutation['replacementBackup'];
    if (targetType.value === true && target.value.outsideWorkspace !== true) {
      if (this.recoveryTrashRoot === undefined) {
        return err(appError('INTERNAL_ERROR', 'Recovery Trash is unavailable; refusing external file replacement', true));
      }
      const backup = await this.copyToRecoveryTrash(
        workspaceId,
        target.value.relativePath,
        target.value.realPath ?? target.value.absolutePath,
        'replacement_backup',
      );
      if (!backup.ok) return backup;
      replacementBackup = { recoveryId: backup.value.id, recoveryPath: backup.value.path };
    }
    if (isAborted(signal)) return cancelledFileMutation();
    return ok({
      sourcePaths: resolvedSources,
      targetPath: target.value.realPath ?? target.value.absolutePath,
      targetRelativePath: resultPath(target.value),
      ...(replacementBackup === undefined ? {} : { replacementBackup }),
    });
  }

  public async deleteFile(actor: FileActor, workspaceId: string | undefined, request: DeleteFileRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<DeleteFileResult>> {
    if (typeof request?.path !== 'string') return err(appError('INVALID_INPUT', 'Delete request is invalid'));
    const fullBypass = isFullBypassAuthorization(authorization);
    const policyAllowsDelete = this.allowDeleteWithoutConfirmation() || fullBypass;
    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true) || policyAllowsDelete;
    const protectedTargetApproved = fullBypass
      || request.userConfirmed === true
      || (authorization?.applicationApproved === true && authorization.source !== 'scoped_policy');
    if (!applicationApproved) {
      return err(appError(
        'PERMISSION_REQUIRED',
        'Deletion requires the user to confirm in chat first, then retry delete_file with userConfirmed: true',
      ));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspaceResult = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!workspaceResult.ok) return workspaceResult;
    const resolved = await this.guard.resolveForRead(workspaceResult.value, request.path, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!resolved.ok) return resolved;
    if ((resolved.value.outsideWorkspace !== true && resolved.value.relativePath.length === 0)
      || isFilesystemRoot(resolved.value.realPath ?? resolved.value.absolutePath)) {
      return err(appError('PERMISSION_DENIED', 'Filesystem or workspace root cannot be deleted'));
    }
    if (!protectedTargetApproved && this.protectCriticalFiles() && isProtectedCriticalPath(resolved.value.relativePath)) {
      return err(appError('PERMISSION_REQUIRED', 'Protected critical files require explicit user confirmation'));
    }
    const permission = this.decide(
      workspaceResult.value.id,
      'delete_file',
      policyAllowsDelete ? 'WRITE' : 'DANGEROUS',
      resolved.value.relativePath,
      !policyAllowsDelete,
      applicationApproved,
      authorization,
    );
    if (!permission.ok) return permission;
    const targetPath = resolved.value.realPath ?? resolved.value.absolutePath;
    try {
      const target = await lstat(targetPath);
      if (isAborted(signal)) return cancelledFileMutation();
      if (target.isDirectory()) {
        const entries = await readdir(targetPath);
        if (isAborted(signal)) return cancelledFileMutation();
        if (entries.length > 0) return err(appError('INVALID_INPUT', 'Non-empty directories cannot be deleted'));
      }

      let checkpointId: string | undefined;
      if (resolved.value.outsideWorkspace !== true && !target.isDirectory() && this.checkpointService !== undefined) {
        const checkpoint = await this.checkpointService.createForFiles(actor, workspaceResult.value.id, [resolved.value.relativePath]);
        if (checkpoint.ok) checkpointId = checkpoint.value.id;
      }

      if (resolved.value.outsideWorkspace !== true && this.recoverableDelete() && this.recoveryTrashRoot !== undefined) {
        const recovery = await this.moveToRecoveryTrash(workspaceResult.value.id, resolved.value.relativePath, targetPath, target.isDirectory());
        if (!recovery.ok) return recovery;
        return ok({
          path: resultPath(resolved.value),
          recoverable: true,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          recoveryId: recovery.value.id,
          recoveryPath: recovery.value.path,
        });
      }

      if (target.isDirectory()) await rmdir(targetPath);
      else await unlink(targetPath);
      return ok({ path: resultPath(resolved.value), recoverable: checkpointId !== undefined, ...(checkpointId === undefined ? {} : { checkpointId }) });
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'File deletion failed'));
    }
  }

  private async moveToRecoveryTrash(
    workspaceId: string,
    relativePath: string,
    targetPath: string,
    isDirectory: boolean,
  ): Promise<Result<{ readonly id: string; readonly path: string }>> {
    const recoveryId = randomUUID();
    const recoveryBase = path.join(this.recoveryTrashRoot!, workspaceId, recoveryId);
    const recoveryPath = path.join(recoveryBase, 'payload');
    try {
      await mkdir(recoveryBase, { recursive: true });
      await writeFsFile(path.join(recoveryBase, 'metadata.json'), JSON.stringify({
        version: 2, kind: 'deleted', recoveryId, workspaceId, relativePath, deletedAt: new Date().toISOString(), isDirectory,
      }, null, 2), 'utf8');
      try {
        await rename(targetPath, recoveryPath);
      } catch (error: unknown) {
        if (nodeErrorCode(error) !== 'EXDEV') throw error;
        if (isDirectory) await cp(targetPath, recoveryPath, { recursive: true, errorOnExist: true, force: false });
        else await copyFile(targetPath, recoveryPath, fsConstants.COPYFILE_EXCL);
        await rm(targetPath, { recursive: isDirectory, force: false });
      }
      return ok({ id: recoveryId, path: recoveryPath });
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'Recoverable deletion failed'));
    }
  }

  private async copyToRecoveryTrash(
    workspaceId: string,
    relativePath: string,
    targetPath: string,
    kind: 'replacement_backup',
  ): Promise<Result<{ readonly id: string; readonly path: string }>> {
    const recoveryId = randomUUID();
    const recoveryBase = path.join(this.recoveryTrashRoot!, workspaceId, recoveryId);
    const recoveryPath = path.join(recoveryBase, 'payload');
    try {
      await mkdir(recoveryBase, { recursive: true });
      await writeFsFile(path.join(recoveryBase, 'metadata.json'), JSON.stringify({
        version: 2, kind, recoveryId, workspaceId, relativePath, deletedAt: new Date().toISOString(), isDirectory: false,
      }, null, 2), 'utf8');
      await copyFile(targetPath, recoveryPath, fsConstants.COPYFILE_EXCL);
      return ok({ id: recoveryId, path: recoveryPath });
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'Replacement backup failed'));
    }
  }

  public async restoreDeletedFile(
    actor: FileActor,
    workspaceId: string,
    request: RestoreDeletedFileRequest,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<RestoreDeletedFileResult>> {
    void actor;
    if (this.recoveryTrashRoot === undefined) return err(appError('INVALID_INPUT', 'Recovery Trash is not configured'));
    const applicationApproved = isApplicationAuthorized(authorization, request?.userConfirmed === true);
    if (!applicationApproved) return err(appError('PERMISSION_REQUIRED', 'Restoring a Recovery Trash item requires explicit user confirmation'));
    if (typeof request?.recoveryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.recoveryId)) {
      return err(appError('INVALID_INPUT', 'Recovery ID is invalid'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    const recoveryBase = path.join(this.recoveryTrashRoot, workspaceId, request.recoveryId);
    const metadataPath = path.join(recoveryBase, 'metadata.json');
    const payloadPath = path.join(recoveryBase, 'payload');
    let metadata: RecoveryMetadata;
    try {
      const parsed: unknown = JSON.parse(await readFsFile(metadataPath, 'utf8'));
      if (!isRecoveryMetadata(parsed)
        || parsed.recoveryId !== request.recoveryId
        || parsed.workspaceId !== workspaceId) {
        return err(appError('INVALID_INPUT', 'Recovery metadata is invalid'));
      }
      metadata = parsed;
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') return err(appError('FILE_NOT_FOUND', 'Recovery item was not found'));
      return err(mapNodeFsError(error, 'Recovery metadata could not be read'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const destination = await this.guard.resolveForWrite(workspace, metadata.relativePath, authorization);
    if (!destination.ok) return destination;
    const kind = recoveryKind(metadata);
    if (destination.value.exists && kind === 'deleted') return err(appError('INVALID_INPUT', 'Restore target already exists; refusing to overwrite it'));
    const permission = this.decide(workspaceId, 'restore_deleted_file', 'WRITE', destination.value.relativePath, false, applicationApproved, authorization);
    if (!permission.ok) return permission;
    const parent = await ensureParentDirectory(destination.value.absolutePath);
    if (!parent.ok) return parent;
    if (isAborted(signal)) return cancelledFileMutation();
    try {
      const payload = await lstat(payloadPath);
      if (payload.isDirectory() !== metadata.isDirectory) return err(appError('INVALID_INPUT', 'Recovery payload type does not match metadata'));
      if (destination.value.exists && kind === 'replacement_backup') {
        if (payload.isDirectory()) return err(appError('INVALID_INPUT', 'Replacement backups must contain a file'));
        const destinationPath = destination.value.realPath ?? destination.value.absolutePath;
        const destinationType = await this.inspectExistingFile(destinationPath);
        if (!destinationType.ok) return destinationType;
        if (destinationType.value !== true) return err(appError('INVALID_INPUT', 'Replacement restore target must be a file'));
        const rollback = await this.copyToRecoveryTrash(workspaceId, destination.value.relativePath, destinationPath, 'replacement_backup');
        if (!rollback.ok) return rollback;
        await copyFile(payloadPath, destinationPath);
        await rm(recoveryBase, { recursive: true, force: true });
        return ok({
          recoveryId: request.recoveryId,
          path: destination.value.relativePath,
          rollbackRecoveryId: rollback.value.id,
        });
      }
      try {
        await rename(payloadPath, destination.value.absolutePath);
      } catch (error: unknown) {
        if (nodeErrorCode(error) !== 'EXDEV') throw error;
        if (payload.isDirectory()) await cp(payloadPath, destination.value.absolutePath, { recursive: true, errorOnExist: true, force: false });
        else await copyFile(payloadPath, destination.value.absolutePath, fsConstants.COPYFILE_EXCL);
        await rm(payloadPath, { recursive: payload.isDirectory(), force: false });
      }
      await rm(recoveryBase, { recursive: true, force: true });
      return ok({ recoveryId: request.recoveryId, path: destination.value.relativePath });
    } catch (error: unknown) {
      return err(mapNodeFsError(error, 'Recovery restore failed'));
    }
  }

  public async purgeRecoveryItemsOlderThan(cutoffIso: string): Promise<number> {
    if (this.recoveryTrashRoot === undefined) return 0;
    const cutoffMs = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoffMs)) throw new Error('Recovery retention cutoff is invalid');
    let workspaceEntries;
    try {
      workspaceEntries = await readdir(this.recoveryTrashRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) continue;
      const workspaceRoot = path.join(this.recoveryTrashRoot, workspaceEntry.name);
      let recoveryEntries;
      try { recoveryEntries = await readdir(workspaceRoot, { withFileTypes: true }); } catch { continue; }
      for (const recoveryEntry of recoveryEntries) {
        if (!recoveryEntry.isDirectory()) continue;
        const recoveryBase = path.join(workspaceRoot, recoveryEntry.name);
        try {
          const parsed: unknown = JSON.parse(await readFsFile(path.join(recoveryBase, 'metadata.json'), 'utf8'));
          if (!isRecoveryMetadata(parsed)) continue;
          const deletedAtMs = Date.parse(parsed.deletedAt);
          if (!Number.isFinite(deletedAtMs) || deletedAtMs >= cutoffMs) continue;
          await rm(recoveryBase, { recursive: true, force: true });
          removed += 1;
        } catch {
          // Corrupt or concurrently restored items are intentionally left alone.
        }
      }
      await rmdir(workspaceRoot).catch(() => undefined);
    }
    return removed;
  }

  public async listRecoveryItems(workspaceId: string): Promise<Result<RecoveryItemList>> {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    if (this.recoveryTrashRoot === undefined) return ok({ recoveryTrashRoot: null, items: [] });
    const workspaceRecoveryRoot = path.join(this.recoveryTrashRoot, workspace.id);
    let entries;
    try {
      entries = await readdir(workspaceRecoveryRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') return ok({ recoveryTrashRoot: this.recoveryTrashRoot, items: [] });
      return err(mapNodeFsError(error, 'Recovery Trash could not be listed'));
    }
    const items: RecoveryItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recoveryBase = path.join(workspaceRecoveryRoot, entry.name);
      try {
        const parsed: unknown = JSON.parse(await readFsFile(path.join(recoveryBase, 'metadata.json'), 'utf8'));
        if (!isRecoveryMetadata(parsed) || parsed.workspaceId !== workspace.id || parsed.recoveryId !== entry.name) continue;
        let payloadAvailable = false;
        try {
          const payload = await lstat(path.join(recoveryBase, 'payload'));
          payloadAvailable = payload.isDirectory() === parsed.isDirectory;
        } catch {
          payloadAvailable = false;
        }
        items.push({
          recoveryId: parsed.recoveryId,
          workspaceId: parsed.workspaceId,
          relativePath: parsed.relativePath,
          deletedAt: parsed.deletedAt,
          isDirectory: parsed.isDirectory,
          payloadAvailable,
          kind: recoveryKind(parsed),
        });
      } catch {
        // Corrupt entries are not trusted or exposed as restorable items.
      }
    }
    items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
    return ok({ recoveryTrashRoot: this.recoveryTrashRoot, items });
  }

  private async prepareTransfer(
    actor: FileActor,
    workspaceId: string | undefined,
    request: MoveFileRequest,
    action: 'move_file' | 'copy_file',
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<{
    readonly sourceAbs: string;
    readonly destinationAbs: string;
    readonly isDirectory: boolean;
    readonly sourceRelative: string;
    readonly destinationRelative: string;
  }>> {
    void actor;
    if (typeof request?.sourcePath !== 'string' || typeof request.destinationPath !== 'string') {
      return err(appError('INVALID_INPUT', 'Transfer request is invalid'));
    }
    if (isAborted(signal)) return cancelledFileMutation();
    const workspaceResult = await resolveSharedWorkspace(this.workspaces, workspaceId, request.sourcePath, request.destinationPath, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!workspaceResult.ok) return workspaceResult;
    const workspace = workspaceResult.value;
    const source = await this.guard.resolveForRead(workspace, request.sourcePath, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!source.ok) return source;
    const destination = await this.guard.resolveForWrite(workspace, request.destinationPath, authorization);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!destination.ok) return destination;
    const sourceAbs = source.value.realPath ?? source.value.absolutePath;
    const destinationAbs = destination.value.absolutePath;
    const sourceType = await this.inspectExistingFile(sourceAbs);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!sourceType.ok) return sourceType;
    if (!sourceType.value) return err(appError('FILE_NOT_FOUND', 'Source file was not found'));
    const destinationType = await this.inspectExistingFile(destinationAbs);
    if (isAborted(signal)) return cancelledFileMutation();
    if (!destinationType.ok) return destinationType;
    if (destinationType.value) return err(appError('INVALID_INPUT', 'Destination already exists'));
    if (sourceType.value === 'directory' && isWithin(sourceAbs, destinationAbs) && path.resolve(sourceAbs) !== path.resolve(destinationAbs)) {
      return err(appError('INVALID_INPUT', 'Destination cannot be inside the source directory'));
    }
    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true);
    if (action === 'move_file' && !applicationApproved) {
      return err(appError('PERMISSION_REQUIRED', 'Moving a file or directory removes the source path and requires explicit user confirmation'));
    }
    const permission = this.decide(workspace.id, action, 'WRITE', source.value.relativePath, false, action === 'copy_file' || applicationApproved, authorization);
    if (!permission.ok) return permission;
    return ok({
      sourceAbs,
      destinationAbs,
      isDirectory: sourceType.value === 'directory',
      sourceRelative: resultPath(source.value),
      destinationRelative: resultPath(destination.value),
    });
  }

  private decide(
    workspaceId: string,
    action: string,
    level: 'WRITE' | 'DANGEROUS',
    target: string | undefined,
    destructive: boolean,
    userConfirmed = false,
    authorization?: InvocationAuthorization,
  ): Result<void> {
    if (authorization?.applicationApproved === true) return ok(undefined);
    const operation = { action, level, workspaceId, destructive, ...(target === undefined ? {} : { target }) };
    const decision = this.permissionEngine.decide(this.profileProvider(), operation);
    if (decision === 'DENY') return err(appError('PERMISSION_DENIED', `${action} is denied`));
    if (decision === 'ASK' && !userConfirmed) return err(appError('PERMISSION_REQUIRED', `${action} requires permission`));
    return ok(undefined);
  }

  private async createCheckpoint(actor: FileActor, workspaceId: string, paths: readonly string[]): Promise<Result<{ readonly id: string }>> {
    if (this.checkpointService === undefined) return err(appError('INTERNAL_ERROR', 'Checkpoint service is unavailable', true));
    const checkpoint = await this.checkpointService.createForFiles(actor, workspaceId, paths);
    if (!checkpoint.ok) return checkpoint;
    return ok({ id: checkpoint.value.id });
  }

  private async inspectExistingFile(filePath: string): Promise<Result<boolean | 'directory'>> {
    try {
      const target = await lstat(filePath);
      return ok(target.isDirectory() ? 'directory' : true);
    } catch (error: unknown) {
      if (nodeErrorCode(error) !== 'ENOENT') return err(mapNodeFsError(error, 'Unable to inspect file target'));
      return ok(false);
    }
  }
}

function resultPath(resolved: ResolvedWorkspacePath): string {
  return resolved.outsideWorkspace === true
    ? resolved.realPath ?? resolved.absolutePath
    : resolved.relativePath;
}

function isFilesystemRoot(targetPath: string): boolean {
  const normalized = path.resolve(targetPath);
  return normalized === path.parse(normalized).root;
}

interface RecoveryMetadata {
  readonly version: 1 | 2;
  readonly kind?: RecoveryItemKind;
  readonly recoveryId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly deletedAt: string;
  readonly isDirectory: boolean;
}

function isRecoveryMetadata(value: unknown): value is RecoveryMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.version === 1 || record.version === 2)
    && typeof record.recoveryId === 'string'
    && typeof record.workspaceId === 'string'
    && typeof record.relativePath === 'string'
    && typeof record.deletedAt === 'string'
    && typeof record.isDirectory === 'boolean'
    && (record.version === 1 || record.kind === 'deleted' || record.kind === 'replacement_backup');
}

function recoveryKind(metadata: RecoveryMetadata): RecoveryItemKind {
  return metadata.version === 1 ? 'deleted' : metadata.kind ?? 'deleted';
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const match = content.indexOf(needle, cursor);
    if (match < 0) break;
    count += 1;
    cursor = match + needle.length;
  }
  return count;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledFileMutation(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'File mutation was cancelled before the next side effect', true));
}
