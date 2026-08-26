#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { syncMachineRoots } from '../packages/application/dist/index.js';
import { resolveLnwjudDataPath, isUnrestricted } from '../packages/shared/dist/index.js';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '../packages/storage/dist/index.js';
import { WorkspaceService, machineRootPath, normalizeWorkspaceRoot } from '../packages/workspace/dist/index.js';
import { startMcpStdio } from '../packages/mcp-server/dist/index.js';
import { createStdioMcpRuntime } from '../apps/cli/dist/index.js';

function parseArgs(args) {
  let workspacePath = process.env.LNWJUD_WORKSPACE || process.cwd();
  let profile = process.env.LNWJUD_STDIO_PROFILE || 'full';
  let strictRoots = process.env.LNWJUD_STRICT_ROOTS === '1';
  let dataPath = process.env.LNWJUD_DATA_PATH;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace' || arg === '-w') {
      workspacePath = args[++i];
    } else if (arg === '--profile' || arg === '-p') {
      profile = args[++i];
    } else if (arg === '--strict-roots') {
      strictRoots = true;
    } else if (arg === '--data-path') {
      dataPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    }
  }

  return { workspacePath, profile, strictRoots, dataPath, showHelp };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.showHelp) {
    process.stdout.write(`
lnwjud-mcp-stdio - Linux stdio MCP gateway for lnwjud

Usage:
  lnwjud-mcp-stdio [options]

Options:
  --workspace, -w <path>    Workspace directory path (default: cwd or $LNWJUD_WORKSPACE)
  --profile, -p <name>      Permission profile: safe | balanced | full | custom (default: full)
  --strict-roots            Restrict workspace visibility to explicitly allowed roots
  --data-path <path>        Custom data directory path
  --help, -h                Show this help message
\n`);
    process.exit(0);
  }

  const rawWorkspacePath = path.resolve(options.workspacePath);
  if (!existsSync(rawWorkspacePath)) {
    process.stderr.write(`lnwjud-mcp-stdio error: Workspace path '${rawWorkspacePath}' does not exist\n`);
    process.exit(1);
  }
  const realWorkspacePath = realpathSync(rawWorkspacePath);

  const resolvedDataPath = options.dataPath
    ? path.resolve(options.dataPath)
    : resolveLnwjudDataPath(process.env);
  mkdirSync(resolvedDataPath, { recursive: true });

  const databasePath = path.join(resolvedDataPath, 'lnwjud.sqlite');
  const database = new SqliteDatabase(databasePath, { backupDirectory: path.join(resolvedDataPath, 'backups') });
  const rawWorkspaceRepository = new SqliteWorkspaceRepository(database);
  const settingsRepository = new SqliteSettingsRepository(database);
  const workspaceService = new WorkspaceService(rawWorkspaceRepository);

  const unrestricted = options.strictRoots ? false : isUnrestricted(process.env, settingsRepository.get('unrestricted'));
  const machineRoot = await syncMachineRoots(workspaceService, unrestricted, realWorkspacePath);

  const requestedNorm = normalizeWorkspaceRoot(realWorkspacePath).toLowerCase();
  const workspaces = await workspaceService.list();
  let workspace = workspaces.find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === requestedNorm);

  if (!workspace) {
    const addResult = await workspaceService.add(path.basename(realWorkspacePath) || 'Workspace', realWorkspacePath);
    if (addResult.ok) {
      workspace = addResult.value;
    } else {
      workspace = machineRoot ?? workspaces[0];
    }
  }

  database.close();

  const runtimeOptions = {
    permissionProfile: options.profile,
    ...(options.strictRoots ? { strictAllowedRoots: [realWorkspacePath] } : {}),
  };

  const runtime = createStdioMcpRuntime(resolvedDataPath, workspace, unrestricted, runtimeOptions);

  const stdioHandle = startMcpStdio({
    services: runtime.services,
    actor: runtime.actor,
    activityTracker: runtime.activityTracker,
    profileProvider: runtime.profileProvider,
    allowAiDeleteProvider: runtime.allowAiDeleteProvider,
    destructivePolicyProvider: runtime.destructivePolicyProvider,
    activeWorkspaceScopeProvider: runtime.activeWorkspaceScopeProvider,
    codexToolsEnabled: runtime.codexToolsEnabled,
  });

  const cleanup = async () => {
    try {
      await runtime.close();
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`lnwjud-mcp-stdio error: ${error.stack || error.message}\n`);
  process.exit(1);
});
