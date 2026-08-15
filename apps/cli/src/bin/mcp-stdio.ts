import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncEMachineRoot } from '@lnwjud/application';
import { startMcpStdio } from '@lnwjud/mcp-server';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { isUnderEDrive, machineRootPath, normalizeWorkspaceRoot, WorkspaceService } from '@lnwjud/workspace';
import { createStdioMcpRuntime } from '../runtime/stdio-mcp-runtime.js';

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveDataPath(): string {
  const configured = process.env.LNWJUD_DATA_PATH?.trim();
  if (configured) return configured;
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'lnwjud');
}

async function main(): Promise<void> {
  const eRoot = machineRootPath();
  if (!fs.existsSync(eRoot)) {
    process.stderr.write('lnwjud MCP stdio: E:\\ drive is required but was not found\n');
    process.exit(2);
  }

  const requestedRaw = readArg('--workspace') ?? process.env.LNWJUD_WORKSPACE;
  const requestedPath = path.resolve(requestedRaw && requestedRaw.trim().length > 0 ? requestedRaw : eRoot);
  if (!fs.existsSync(requestedPath)) {
    process.stderr.write(`lnwjud MCP stdio: workspace path does not exist: ${requestedPath}\n`);
    process.exit(2);
  }
  if (!isUnderEDrive(requestedPath)) {
    process.stderr.write(`lnwjud MCP stdio: workspace must be under E:\\ (got ${requestedPath})\n`);
    process.exit(2);
  }

  process.env.LNWJUD_CAPABILITY_ROOTS = process.env.LNWJUD_CAPABILITY_ROOTS?.trim()
    || eRoot.replace(/\\/g, '/');

  const dataPath = resolveDataPath();
  fs.mkdirSync(dataPath, { recursive: true });

  const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepository);

  const reset = hasFlag('--reset-workspaces')
    || process.env.LNWJUD_RESET_WORKSPACES === '1'
    || process.env.LNWJUD_RESET_WORKSPACES === 'true';
  if (reset) {
    for (const existing of await workspaceService.list()) {
      await workspaceService.delete(existing.id);
    }
    process.stderr.write('lnwjud MCP stdio: cleared previous workspaces\n');
  }

  const machineRoot = await syncEMachineRoot(workspaceService);
  if (machineRoot === null) {
    process.stderr.write('lnwjud MCP stdio: could not register E:\\ machine root\n');
    process.exit(1);
  }

  const requestedNorm = normalizeWorkspaceRoot(requestedPath).toLowerCase();
  const workspaces = await workspaceService.list();
  let workspace = workspaces.find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === requestedNorm)
    ?? workspaces.find((entry) => requestedNorm.startsWith(normalizeWorkspaceRoot(entry.realRootPath).toLowerCase()));

  if (workspace === undefined && requestedNorm !== normalizeWorkspaceRoot(eRoot).toLowerCase()) {
    const displayName = path.basename(requestedPath) || 'Workspace';
    const added = await workspaceService.add(displayName, requestedPath);
    if (!added.ok) {
      process.stderr.write(`lnwjud MCP stdio: could not register ${requestedPath} (${added.error.message})\n`);
      process.exit(1);
    }
    workspace = added.value;
  }

  workspace ??= machineRoot;

  for (const entry of await workspaceService.list()) {
    process.stderr.write(`lnwjud workspace id=${entry.id} root=${entry.realRootPath}\n`);
  }
  database.close();

  const primary = workspace;
  const runtime = createStdioMcpRuntime(dataPath, primary);
  process.stderr.write(`lnwjud MCP stdio ready primary=${primary.id} root=${primary.realRootPath}\n`);

  let shuttingDown = false;
  let handle: ReturnType<typeof startMcpStdio> | undefined;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await handle?.close();
    } catch {
      // ignore transport close races during parent teardown
    }
    try {
      await runtime.close();
    } catch {
      // ignore runtime close races during parent teardown
    }
    process.exit(0);
  };

  handle = startMcpStdio({
    services: runtime.services,
    actor: runtime.actor,
    activityTracker: runtime.activityTracker,
    onError: (error): void => {
      if (/EPIPE|ECONNRESET|broken pipe/i.test(error.message)) {
        process.stderr.write(`lnwjud MCP stdio: peer closed (${error.message})\n`);
        void shutdown();
        return;
      }
      process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
    },
  });

  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('close', () => { void shutdown(); });
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
      void shutdown();
    }
  });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  process.stderr.write(`lnwjud MCP stdio failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
