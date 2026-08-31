import type { WorkspaceId } from '@lnwjud/domain';

export interface Workspace {
  readonly id: WorkspaceId;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  /** Present only for archived workspace registrations. Archived workspaces are excluded from the runtime trust boundary. */
  readonly archivedAt?: string | null;
}

export interface ResolvedWorkspacePath {
  readonly workspaceId: WorkspaceId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realPath?: string;
  readonly exists: boolean;
  /** True only when a per-invocation Full Bypass resolved an explicit absolute target outside the workspace. */
  readonly outsideWorkspace?: boolean;
}

export interface CheckpointFile {
  readonly path: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface Checkpoint {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly createdAt: string;
  readonly files: readonly CheckpointFile[];
}

export interface CheckpointRepository {
  insert(checkpoint: Checkpoint): Promise<void>;
  get(id: string): Promise<Checkpoint | null>;
  list(workspaceId: WorkspaceId, limit?: number): Promise<Checkpoint[]>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
