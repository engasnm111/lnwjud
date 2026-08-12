import path from 'node:path';
import {
  CheckpointService,
  CodexService,
  FileService,
  GitService,
  ProcessService,
  ProjectService,
  ProjectSnapshotService,
  SearchService,
  WorkspaceInfoService,
  WorkspaceQueryService,
  type FileActor,
} from '@lnwjud/application';
import { AuditService } from '@lnwjud/audit';
import {
  EXTENSIONS_SETTINGS_KEY,
  createLocalExtensionsService,
  type ExtensionsService,
} from '@lnwjud/extensions';
import type { McpApplicationServices } from '@lnwjud/mcp-server';
import { permissionProfiles } from '@lnwjud/permissions';
import {
  SqliteAuditRepository,
  SqliteCheckpointRepository,
  SqliteDatabase,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@lnwjud/storage';
import type { Workspace } from '@lnwjud/workspace';

export interface StdioMcpRuntime {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly extensions: ExtensionsService;
  close(): Promise<void>;
}

/**
 * Builds full-access MCP application services for stdio/CLI launches.
 * Permission profile is always `full`.
 */
export function createStdioMcpRuntime(dataPath: string, workspace: Workspace): StdioMcpRuntime {
  const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const settingsRepository = new SqliteSettingsRepository(database);
  const auditRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const checkpointRepository = new SqliteCheckpointRepository(database);
  const fullProfile = permissionProfiles.full;
  settingsRepository.set('permission_profile', 'full');

  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: fullProfile,
  });
  const fileService = new FileService(workspaceRepository, undefined, undefined, {
    checkpointService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
  });
  const gitService = new GitService(workspaceRepository);
  const workspaceQuery = new WorkspaceQueryService(workspaceRepository);
  const extensions = createLocalExtensionsService({
    settingsJson: settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    workspaceRootProvider: async (): Promise<string> => workspace.realRootPath,
  });
  const services: McpApplicationServices = {
    extensions,
    workspaceInfo: new WorkspaceInfoService(workspaceRepository),
    workspaceQuery,
    projectSnapshot: new ProjectSnapshotService(workspaceRepository, {
      projectService,
      gitService,
      workspaceQuery,
      processService,
    }),
    project: projectService,
    file: fileService,
    search: new SearchService(workspaceRepository),
    git: gitService,
    process: processService,
    codex: new CodexService(workspaceRepository, {
      auditService,
      profileProvider: (): typeof permissionProfiles.full => fullProfile,
    }),
  };

  return {
    services,
    actor: { clientId: 'cli-mcp-stdio', clientName: 'lnwjud cli MCP' },
    extensions,
    close: async (): Promise<void> => {
      await extensions.close().catch(() => undefined);
      database.close();
    },
  };
}
