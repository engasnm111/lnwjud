import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { appError, err, MAX_MULTI_FILE_BYTES, ok, type Result } from '@lnwjud/domain';
import {
  AtomicFileWriter,
  MAX_FILE_WRITE_BYTES,
  PatchApplier,
  TextFileReader,
  type FilePatch,
  type LineRange,
} from '@lnwjud/filesystem';
import { DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { CheckpointServicePort } from './checkpoint-service.js';

export interface FileActor {
  readonly clientId: string;
  readonly clientName: string;
}

export interface ReadFileRequest extends LineRange {
  readonly path: string;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
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
}

export interface WriteFileRequest {
  readonly path: string;
  readonly content: string;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly checkpointId?: string;
}

export interface ApplyPatchRequest {
  readonly files: readonly FilePatch[];
}

export interface ApplyPatchResult {
  readonly paths: readonly string[];
  readonly checkpointId?: string;
}

export interface MoveFileRequest {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface DeleteFileRequest {
  readonly path: string;
}

export class FileService {
  private readonly writer: AtomicFileWriter;
  private readonly patchApplier: PatchApplier;
  private readonly checkpointService: CheckpointServicePort | undefined;
  private readonly permissionEngine: PermissionEngine;
  private readonly profile: PermissionProfile;

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
    this.profile = dependencies.profile ?? permissionProfiles.balanced;
  }

  public async readFile(actor: FileActor, workspaceId: string, request: ReadFileRequest): Promise<Result<ReadFileResult>> {
    void actor;
    const workspaceResult = await this.getWorkspace(workspaceId);
    if (!workspaceResult.ok) return workspaceResult;
    const resolved = await this.guard.resolveForRead(workspaceResult.value, request.path);
    if (!resolved.ok) return resolved;
    const readResult = await this.reader.read(resolved.value.realPath ?? resolved.value.absolutePath, request);
    if (!readResult.ok) return readResult;
    return ok({ path: resolved.value.relativePath, ...readResult.value });
  }

  public async readFiles(actor: FileActor, workspaceId: string, request: ReadFilesRequest): Promise<Result<ReadFilesResult>> {
    void actor;
    if (!Array.isArray(request.files) || request.files.length > 20) {
      return err(appError('INVALID_INPUT', 'At most 20 files may be read'));
    }
    const files: ReadFileResult[] = [];
    let totalBytes = 0;
    for (const fileRequest of request.files) {
      const result = await this.readFile(actor, workspaceId, fileRequest);
      if (!result.ok) return result;
      totalBytes += Buffer.byteLength(result.value.content, 'utf8');
      if (totalBytes > MAX_MULTI_FILE_BYTES) return err(appError('FILE_TOO_LARGE', 'Combined file response exceeds the maximum size'));
      files.push(result.value);
    }
    return ok({ files });
  }

  public async writeFile(actor: FileActor, workspaceId: string, request: WriteFileRequest): Promise<Result<WriteFileResult>> {
    if (typeof request?.path !== 'string' || typeof request.content !== 'string') {
      return err(appError('INVALID_INPUT', 'Write request is invalid'));
    }
    if (Buffer.byteLength(request.content, 'utf8') > MAX_FILE_WRITE_BYTES) {
      return err(appError('FILE_TOO_LARGE', 'File exceeds the maximum write size'));
    }
    const workspaceResult = await this.getWorkspace(workspaceId);
    if (!workspaceResult.ok) return workspaceResult;
    const resolved = await this.guard.resolveForWrite(workspaceResult.value, request.path);
    if (!resolved.ok) return resolved;
    const existing = await this.inspectExistingFile(resolved.value.absolutePath);
    if (!existing.ok) return existing;
    if (existing.value === 'directory') return err(appError('INVALID_INPUT', 'Directories cannot be written as files'));
    const permission = this.decide(workspaceId, 'write_file', 'WRITE', resolved.value.relativePath, false);
    if (!permission.ok) return permission;

    let checkpointId: string | undefined;
    if (existing.value) {
      const checkpoint = await this.createCheckpoint(actor, workspaceId, [resolved.value.relativePath]);
      if (!checkpoint.ok) return checkpoint;
      checkpointId = checkpoint.value.id;
    }
    const writeResult = await this.writer.write(resolved.value.realPath ?? resolved.value.absolutePath, request.content);
    if (!writeResult.ok) return writeResult;
    return ok({
      path: resolved.value.relativePath,
      bytesWritten: Buffer.byteLength(request.content, 'utf8'),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  }

  public async applyPatch(actor: FileActor, workspaceId: string, request: ApplyPatchRequest): Promise<Result<ApplyPatchResult>> {
    const validation = this.patchApplier.validate(request?.files ?? []);
    if (!validation.ok) return validation;
    const workspaceResult = await this.getWorkspace(workspaceId);
    if (!workspaceResult.ok) return workspaceResult;

    const resolvedFiles: { readonly patch: FilePatch; readonly absolutePath: string; readonly relativePath: string }[] = [];
    const existingPaths: string[] = [];
    for (const patch of request.files) {
      const resolved = await this.guard.resolveForWrite(workspaceResult.value, patch.path);
      if (!resolved.ok) return resolved;
      const existing = await this.inspectExistingFile(resolved.value.absolutePath);
      if (!existing.ok) return existing;
      if (existing.value === 'directory') return err(appError('INVALID_INPUT', 'Directories cannot be patched as files'));
      if (existing.value) existingPaths.push(resolved.value.relativePath);
      resolvedFiles.push({
        patch,
        absolutePath: resolved.value.realPath ?? resolved.value.absolutePath,
        relativePath: resolved.value.relativePath,
      });
    }

    const permission = this.decide(workspaceId, 'apply_patch', 'WRITE', undefined, false);
    if (!permission.ok) return permission;
    let checkpointId: string | undefined;
    if (existingPaths.length > 0) {
      const checkpoint = await this.createCheckpoint(actor, workspaceId, existingPaths);
      if (!checkpoint.ok) return checkpoint;
      checkpointId = checkpoint.value.id;
    }
    for (const resolved of resolvedFiles) {
      const writeResult = await this.writer.write(resolved.absolutePath, resolved.patch.content);
      if (!writeResult.ok) return writeResult;
    }
    return ok({
      paths: resolvedFiles.map((resolved) => resolved.relativePath),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });
  }

  public async moveFile(actor: FileActor, workspaceId: string, request: MoveFileRequest): Promise<Result<void>> {
    void actor;
    if (typeof request?.sourcePath !== 'string' || typeof request.destinationPath !== 'string') {
      return err(appError('INVALID_INPUT', 'Move request is invalid'));
    }
    const workspaceResult = await this.getWorkspace(workspaceId);
    if (!workspaceResult.ok) return workspaceResult;
    const source = await this.guard.resolveForRead(workspaceResult.value, request.sourcePath);
    if (!source.ok) return source;
    const destination = await this.guard.resolveForWrite(workspaceResult.value, request.destinationPath);
    if (!destination.ok) return destination;
    const sourceType = await this.inspectExistingFile(source.value.realPath ?? source.value.absolutePath);
    if (!sourceType.ok) return sourceType;
    if (!sourceType.value) return err(appError('FILE_NOT_FOUND', 'Source file was not found'));
    const destinationType = await this.inspectExistingFile(destination.value.absolutePath);
    if (!destinationType.ok) return destinationType;
    if (destinationType.value) return err(appError('INVALID_INPUT', 'Destination already exists'));
    if (sourceType.value === 'directory') return err(appError('INVALID_INPUT', 'Directories cannot be moved by this operation'));
    const permission = this.decide(workspaceId, 'move_file', 'WRITE', source.value.relativePath, false);
    if (!permission.ok) return permission;
    try {
      await rename(source.value.realPath ?? source.value.absolutePath, destination.value.absolutePath);
    } catch {
      return err(appError('INTERNAL_ERROR', 'File move failed', true));
    }
    return ok(undefined);
  }

  public async deleteFile(actor: FileActor, workspaceId: string, request: DeleteFileRequest): Promise<Result<void>> {
    void actor;
    if (typeof request?.path !== 'string') return err(appError('INVALID_INPUT', 'Delete request is invalid'));
    const workspaceResult = await this.getWorkspace(workspaceId);
    if (!workspaceResult.ok) return workspaceResult;
    const resolved = await this.guard.resolveForRead(workspaceResult.value, request.path);
    if (!resolved.ok) return resolved;
    if (resolved.value.relativePath.length === 0) return err(appError('PERMISSION_DENIED', 'Workspace root cannot be deleted'));
    const permission = this.decide(workspaceId, 'delete_file', 'DANGEROUS', resolved.value.relativePath, true);
    if (!permission.ok) return permission;
    const targetPath = resolved.value.realPath ?? resolved.value.absolutePath;
    try {
      const target = await lstat(targetPath);
      if (target.isDirectory()) {
        const entries = await readdir(targetPath);
        if (entries.length > 0) return err(appError('INVALID_INPUT', 'Non-empty directories cannot be deleted'));
        await rmdir(targetPath);
      } else {
        await unlink(targetPath);
      }
    } catch {
      return err(appError('INTERNAL_ERROR', 'File deletion failed', true));
    }
    return ok(undefined);
  }

  private decide(
    workspaceId: string,
    action: string,
    level: 'WRITE' | 'DANGEROUS',
    target: string | undefined,
    destructive: boolean,
  ): Result<void> {
    const operation = { action, level, workspaceId, destructive, ...(target === undefined ? {} : { target }) };
    const decision = this.permissionEngine.decide(this.profile, operation);
    if (decision === 'DENY') return err(appError('PERMISSION_DENIED', `${action} is denied`));
    if (decision === 'ASK') return err(appError('PERMISSION_REQUIRED', `${action} requires permission`));
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
      if (!isFileNotFoundError(error)) return err(appError('INTERNAL_ERROR', 'Unable to inspect file target', true));
      return ok(false);
    }
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT';
}
