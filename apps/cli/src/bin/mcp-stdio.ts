import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '@lnwjud/workspace';
import { startMcpStdio } from '@lnwjud/mcp-server';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@lnwjud/storage';
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

function normalizeRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/** Fixed local drive letters that currently exist as directories. */
export function listFixedDrives(): readonly string[] {
  const drives: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) drives.push(root);
    } catch {
      // Skip inaccessible letters.
    }
  }
  return drives;
}

async function ensureWorkspace(
  workspaceService: WorkspaceService,
  displayName: string,
  rootPath: string,
): Promise<void> {
  if (!fs.existsSync(rootPath)) return;
  const existing = await workspaceService.list();
  const target = normalizeRoot(rootPath).toLowerCase();
  if (existing.some((entry) => normalizeRoot(entry.realRootPath).toLowerCase() === target)) return;
  const added = await workspaceService.add(displayName, rootPath);
  if (!added.ok) {
    process.stderr.write(`lnwjud MCP stdio: could not register ${rootPath} (${added.error.message})\n`);
  }
}

async function main(): Promise<void> {
  const fixedDrives = listFixedDrives();
  if (fixedDrives.length === 0) {
    process.stderr.write('lnwjud MCP stdio: no fixed drives found\n');
    process.exit(2);
  }

  const requestedRaw = readArg('--workspace') ?? process.env.LNWJUD_WORKSPACE;
  const requestedPath = path.resolve(requestedRaw && requestedRaw.trim().length > 0 ? requestedRaw : fixedDrives[0]!);
  if (!fs.existsSync(requestedPath)) {
    process.stderr.write(`lnwjud MCP stdio: workspace path does not exist: ${requestedPath}\n`);
    process.exit(2);
  }

  process.env.LNWJUD_CAPABILITY_ROOTS = process.env.LNWJUD_CAPABILITY_ROOTS?.trim()
    || fixedDrives.map((drive) => drive.replace(/\\/g, '/')).join(';');

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

  for (const drive of fixedDrives) {
    const letter = drive.slice(0, 2);
    await ensureWorkspace(workspaceService, `Local Disk ${letter}`, drive);
  }

  const workspaces = await workspaceService.list();
  const requestedNorm = normalizeRoot(requestedPath).toLowerCase();
  const workspace = workspaces.find((entry) => normalizeRoot(entry.realRootPath).toLowerCase() === requestedNorm)
    ?? workspaces.find((entry) => requestedNorm.startsWith(normalizeRoot(entry.realRootPath).toLowerCase()))
    ?? workspaces[0];

  if (workspace === undefined) {
    process.stderr.write('lnwjud MCP stdio: no workspace available\n');
    process.exit(1);
  }

  for (const entry of workspaces) {
    process.stderr.write(`lnwjud workspace id=${entry.id} root=${entry.realRootPath}\n`);
  }
  database.close();

  const runtime = createStdioMcpRuntime(dataPath, workspace);
  process.stderr.write(`lnwjud MCP stdio ready primary=${workspace.id} root=${workspace.realRootPath}\n`);
  startMcpStdio({
    services: runtime.services,
    actor: runtime.actor,
    onError: (error): void => {
      process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
    },
  });

  const shutdown = async (): Promise<void> => {
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  process.stderr.write(`lnwjud MCP stdio failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
