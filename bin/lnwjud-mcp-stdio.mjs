#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLnwjudDataPath } from '../packages/shared/dist/index.js';
import { SqliteDatabase, SqliteWorkspaceRepository } from '../packages/storage/dist/index.js';
import { WorkspaceService } from '../packages/workspace/dist/index.js';
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
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepository);

  let workspace = await workspaceRepository.findByPath(realWorkspacePath);
  if (!workspace) {
    const addResult = await workspaceService.add(path.basename(realWorkspacePath) || 'workspace', realWorkspacePath);
    if (addResult.ok) {
      workspace = addResult.value;
    } else {
      const existingWorkspaces = await workspaceRepository.list();
      if (existingWorkspaces.length > 0) {
        workspace = existingWorkspaces[0];
      } else {
        process.stderr.write(`lnwjud-mcp-stdio error: Failed to register workspace: ${addResult.error.message}\n`);
        database.close();
        process.exit(1);
      }
    }
  }

  const runtimeOptions = {
    permissionProfile: options.profile,
    ...(options.strictRoots ? { strictAllowedRoots: [realWorkspacePath] } : {}),
  };

  const runtime = createStdioMcpRuntime(resolvedDataPath, workspace, !options.strictRoots, runtimeOptions);

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
