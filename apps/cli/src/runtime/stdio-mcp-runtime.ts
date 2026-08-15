import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  BrowserCdpBackend,
  HealthCapabilityBackend,
  LocalCapabilityService,
  NodeBrowserCdpProtocol,
  PowerShellWindowsCapabilityBridge,
  ShellCapabilityBackend,
  WindowsNativeCapabilityBackend,
} from '@lnwjud/capabilities';
import type { Result } from '@lnwjud/domain';
import {
  EXTENSIONS_SETTINGS_KEY,
  createLocalExtensionsService,
  type ExtensionsService,
} from '@lnwjud/extensions';
import { ActivityTracker, type ActivitySinkEvent, type McpApplicationServices } from '@lnwjud/mcp-server';
import { permissionProfiles } from '@lnwjud/permissions';
import {
  SqliteAuditRepository,
  SqliteCheckpointRepository,
  SqliteDatabase,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@lnwjud/storage';
import { allFixedDriveRoots, machineRootPath, SecretPolicy, WorkspacePathGuard, WorkspaceService, type Workspace } from '@lnwjud/workspace';

export interface StdioMcpRuntime {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly extensions: ExtensionsService;
  readonly activityTracker: ActivityTracker;
  close(): Promise<void>;
}

/**
 * Builds full-access MCP application services for stdio/CLI launches.
 * Permission profile is always `full`. Capabilities are wired for ChatGPT tunnel use.
 */
export function createStdioMcpRuntime(dataPath: string, workspace: Workspace, unrestricted: boolean = false): StdioMcpRuntime {
  const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const settingsRepository = new SqliteSettingsRepository(database);
  const auditRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const checkpointRepository = new SqliteCheckpointRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepository);
  const fullProfile = permissionProfiles.full;
  settingsRepository.set('permission_profile', 'full');

  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
    unrestricted,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: fullProfile,
  });
  const pathGuard = unrestricted ? new WorkspacePathGuard(new SecretPolicy(), { unrestricted: true }) : undefined;
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
    unrestricted,
  });
  const gitService = new GitService(workspaceRepository);
  const workspaceQuery = new WorkspaceQueryService(workspaceRepository);
  const extensions = createLocalExtensionsService({
    settingsJson: settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    workspaceRootProvider: async (): Promise<string> => workspace.realRootPath,
  });
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
  });
  const capabilityService = createStdioCapabilityService(dataPath, async () => {
    const listed = await workspaceRepository.list();
    const roots = listed.map((entry) => entry.realRootPath);
    if (roots.length === 0) return unrestricted ? [...allFixedDriveRoots()] : [machineRootPath()];
    return roots;
  }, unrestricted);
  const actor: FileActor = { clientId: 'cli-mcp-stdio', clientName: 'lnwjud cli MCP' };
  const activityTracker = new ActivityTracker({
    async record(event: ActivitySinkEvent): Promise<void> {
      await auditService.recordMcpTool({
        actorId: actor.clientId,
        actorName: actor.clientName,
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
        toolName: event.toolName,
        callId: event.callId,
        phase: event.phase,
        ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
        resultCode: event.resultCode,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
      });
    },
  });
  const services: McpApplicationServices = {
    capabilities: capabilityService,
    extensions,
    workspaceInfo: new WorkspaceInfoService(workspaceRepository, workspaceService, unrestricted),
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
    codex: codexService,
  };

  return {
    services,
    actor,
    extensions,
    activityTracker,
    close: async (): Promise<void> => {
      await extensions.close().catch(() => undefined);
      database.close();
    },
  };
}

function createStdioCapabilityService(
  dataPath: string,
  workspaceRootsProvider: () => Promise<readonly string[]>,
  unrestricted: boolean,
): LocalCapabilityService {
  const shellBackend = new ShellCapabilityBackend({
    allowedRoots: [dataPath, ...(unrestricted ? [...allFixedDriveRoots()] : [machineRootPath()])],
    allowedRootsProvider: async (): Promise<readonly string[]> => {
      const workspaceRoots = await workspaceRootsProvider();
      const configuredRoots = readCapabilityRoots(process.env.LNWJUD_CAPABILITY_ROOTS);
      const roots = [...workspaceRoots, ...configuredRoots, ...(unrestricted ? [...allFixedDriveRoots()] : [machineRootPath()])];
      return roots.length === 0 ? [dataPath] : roots;
    },
    unrestricted,
  });
  const browserProtocol = new NodeBrowserCdpProtocol({ profileDir: path.join(dataPath, 'browser-profile') });
  const browserBackend = new BrowserCdpBackend({
    protocol: browserProtocol,
    launcher: (url: string | undefined): Promise<Result<unknown>> => browserProtocol.launch(url),
  });
  const windowsBridge = new PowerShellWindowsCapabilityBridge({ scriptPath: capabilityBridgeScriptPath() });
  const health = new HealthCapabilityBackend({
    domCdp: browserBackend,
    accessibility: new WindowsNativeCapabilityBackend('accessibility', windowsBridge),
  });
  return new LocalCapabilityService({
    shell: shellBackend,
    domCdp: browserBackend,
    accessibility: new WindowsNativeCapabilityBackend('accessibility', windowsBridge),
    inputEvent: new WindowsNativeCapabilityBackend('input_event', windowsBridge),
    vision: new WindowsNativeCapabilityBackend('vision', windowsBridge),
    window: new WindowsNativeCapabilityBackend('window', windowsBridge),
    health,
  });
}

function readCapabilityRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(';').map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
}

function capabilityBridgeScriptPath(): string {
  const configured = process.env.LNWJUD_CAPABILITY_BRIDGE_SCRIPT;
  if (configured !== undefined && configured.trim().length > 0) return path.resolve(configured);

  const scriptDir = resolveScriptDirectory();
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    scriptDir === undefined ? undefined : path.join(scriptDir, 'windows-capability-bridge.ps1'),
    scriptDir === undefined ? undefined : path.join(scriptDir, 'resources', 'windows-capability-bridge.ps1'),
    path.resolve(process.cwd(), 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'),
    path.resolve(process.cwd(), '..', '..', 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'),
    resourcesPath === undefined ? undefined : path.join(resourcesPath, 'windows-capability-bridge.ps1'),
    path.join(path.dirname(process.execPath), 'windows-capability-bridge.ps1'),
    path.join(path.dirname(process.execPath), 'resources', 'windows-capability-bridge.ps1'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function resolveScriptDirectory(): string | undefined {
  const arg1 = process.argv[1];
  if (typeof arg1 === 'string' && arg1.trim().length > 0) {
    try {
      return path.dirname(path.resolve(arg1));
    } catch {
      // ignore
    }
  }
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {
    // Bundled CJS may leave import.meta.url empty.
  }
  return undefined;
}
