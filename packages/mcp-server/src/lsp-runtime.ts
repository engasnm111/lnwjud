import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * Wave 6 minimal stdio LSP client behind `lsp_diagnostics` and `lsp_rename`.
 * Language servers are configured per language through environment variables
 * (LNWJUD_LSP_<LANGUAGE>_COMMAND, JSON argv preferred). Workspace files are
 * canonicalized before they are opened so LSP cannot bypass workspace roots.
 */

const MAX_OPEN_FILES = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_QUIET_MS = 2_000;
const DIAGNOSTICS_MAX_WAIT_MS = 10_000;
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
};

export interface LspRuntimeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Injectable for tests: creates the server process. */
  readonly spawner?: (command: readonly string[]) => Result<ChildProcess>;
}

/** One JSON-RPC demultiplexer per server process. */
class LspConnection {
  private buffer = Buffer.alloc(0);
  private readonly responseWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined;

  public constructor(private readonly server: ChildProcess) {
    server.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
    server.stdin?.on('error', () => undefined);
    server.stdout?.on('error', () => undefined);
    server.on('error', () => undefined);
  }

  public onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  public request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseWaiters.delete(id);
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.responseWaiters.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  public notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  public close(): void {
    try {
      this.write({ jsonrpc: '2.0', id: randomUUID(), method: 'shutdown', params: {} });
      this.notify('exit', {});
    } catch {
      // The server may already be gone.
    }
    this.server.kill();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
      if (typeof message.method === 'string') {
        this.notificationHandler?.(message.method, (message.params ?? {}) as Record<string, unknown>);
      } else if (message.id !== undefined) {
        const waiter = this.responseWaiters.get(String(message.id));
        if (waiter === undefined) continue;
        this.responseWaiters.delete(String(message.id));
        if (message.error !== undefined) waiter.reject(new Error(String((message.error as { message?: unknown }).message ?? 'LSP request failed')));
        else waiter.resolve(message.result);
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.server.stdin?.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8');
  }
}

export class LspRuntimeService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly spawner: (command: readonly string[]) => Result<ChildProcess>;
  private readonly published = new Map<string, unknown[]>();

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    options: LspRuntimeOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawner = options.spawner ?? defaultSpawner;
  }

  public async diagnostics(input: Record<string, unknown>): Promise<Result<unknown>> {
    this.published.clear();
    const session = await this.startSession(input, (connection) => {
      connection.onNotification((method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        const uri = typeof params.uri === 'string' ? params.uri : undefined;
        if (uri !== undefined) this.published.set(uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
      });
    });
    if (!session.ok) return session;
    try {
      await this.openFiles(session.value.connection, session.value.files, session.value.language);
      await quietPeriod(DIAGNOSTICS_QUIET_MS, DIAGNOSTICS_MAX_WAIT_MS);
      return ok({
        tool: 'lsp_diagnostics', status: 'ready', available: true,
        language: session.value.language, server: session.value.command[0],
        filesChecked: this.published.size,
        diagnostics: [...this.published.entries()].map(([uri, entries]) => ({ file: uriToPath(uri), count: entries.length, entries })),
      });
    } finally {
      session.value.connection.close();
    }
  }

  public async renamePlan(input: Record<string, unknown>): Promise<Result<unknown>> {
    const requestedFile = firstFile(input);
    const newName = readString(input.newName ?? input.new_name);
    if (requestedFile === undefined || newName === undefined) return err(appError('INVALID_INPUT', 'lsp_rename requires file and newName'));
    const session = await this.startSession(input, () => undefined);
    if (!session.ok) return session;
    try {
      await this.openFiles(session.value.connection, session.value.files, session.value.language);
      const targetFile = session.value.files[0]!;
      const edit = await session.value.connection.request('textDocument/rename', {
        textDocument: { uri: pathToUri(targetFile) },
        position: { line: typeof input.line === 'number' ? input.line : 0, character: typeof input.character === 'number' ? input.character : 0 },
        newName,
      }, this.timeoutMs);
      return ok({
        tool: 'lsp_rename', status: 'ready', available: true, applied: false, requiresApproval: true,
        language: session.value.language, file: requestedFile, newName, edit,
        applyHint: 'Review the workspace edit, then apply it through apply_patch/write_file after explicit user confirmation',
      });
    } finally {
      session.value.connection.close();
    }
  }

  private async startSession(
    input: Record<string, unknown>,
    attach: (connection: LspConnection) => void,
  ): Promise<Result<{ root: string; language: string; command: readonly string[]; files: readonly string[]; connection: LspConnection }>> {
    const workspaceId = readString(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'LSP tools require workspaceId'));
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;

    const requestedFiles = (Array.isArray(input.files) ? input.files : [input.file].filter((value): value is string => typeof value === 'string'))
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0)
      .slice(0, MAX_OPEN_FILES);
    if (requestedFiles.length === 0) return err(appError('INVALID_INPUT', 'LSP tools require file or files'));
    const language = readString(input.language) ?? LANGUAGE_BY_EXTENSION[path.extname(requestedFiles[0]!).toLowerCase()] ?? '';
    if (language === '') return err(appError('INVALID_INPUT', 'Could not infer a language; pass language explicitly'));
    const command = this.serverCommand(language);
    if (command === undefined) {
      return err(appError('PERMISSION_DENIED', `No language server configured for ${language}. Set LNWJUD_LSP_${language.toUpperCase()}_COMMAND (JSON argv preferred)`));
    }
    const resolvedFiles = await this.resolveWorkspaceFiles(root.value, requestedFiles);
    if (!resolvedFiles.ok) return resolvedFiles;

    const spawned = this.spawner(command);
    if (!spawned.ok) return spawned;
    const connection = new LspConnection(spawned.value);
    attach(connection);
    try {
      await connection.request('initialize', {
        processId: process.pid,
        rootUri: pathToUri(root.value),
        capabilities: { textDocument: { synchronization: { dynamicRegistration: false } } },
      }, this.timeoutMs);
    } catch (error) {
      connection.close();
      return err(appError('INTERNAL_ERROR', `Language server initialization failed: ${error instanceof Error ? error.message : String(error)}`, true));
    }
    connection.notify('initialized', {});
    return ok({ root: root.value, language, command, files: resolvedFiles.value, connection });
  }

  private async resolveWorkspaceFiles(root: string, files: readonly string[]): Promise<Result<readonly string[]>> {
    let canonicalRoot: string;
    try {
      canonicalRoot = path.win32.normalize(await realpath(root));
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be resolved'));
    }
    const resolved: string[] = [];
    for (const file of files) {
      const candidate = path.win32.isAbsolute(file) ? path.win32.normalize(file) : path.win32.join(canonicalRoot, file);
      if (!isWithin(canonicalRoot, candidate)) return err(appError('PATH_OUTSIDE_WORKSPACE', `LSP file is outside the registered workspace: ${file}`));
      if (!existsSync(candidate)) return err(appError('FILE_NOT_FOUND', `LSP file was not found: ${file}`));
      let canonicalFile: string;
      try {
        canonicalFile = path.win32.normalize(await realpath(candidate));
      } catch {
        return err(appError('FILE_NOT_FOUND', `LSP file could not be resolved: ${file}`));
      }
      if (!isWithin(canonicalRoot, canonicalFile)) return err(appError('PATH_OUTSIDE_WORKSPACE', `LSP file resolves outside the registered workspace: ${file}`));
      resolved.push(canonicalFile);
    }
    return ok(resolved);
  }

  private async openFiles(connection: LspConnection, files: readonly string[], language: string): Promise<void> {
    for (const absolute of files) {
      const content = await readFile(absolute, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue;
      connection.notify('textDocument/didOpen', {
        textDocument: { uri: pathToUri(absolute), languageId: languageIdForFile(absolute, language), version: 1, text: content },
      });
    }
  }

  private serverCommand(language: string): readonly string[] | undefined {
    const settingsCommand = this.services.localProviders?.().lspCommands?.[language.toLowerCase()];
    const configured = readString(settingsCommand) ?? this.environment[`LNWJUD_LSP_${language.toUpperCase()}_COMMAND`];
    if (typeof configured !== 'string' || configured.trim().length === 0) return undefined;
    const trimmed = configured.trim();
    let command: string[];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        command = Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') ? parsed.map(String) : [];
      } catch {
        command = [];
      }
    } else {
      command = trimmed.split(/\s+/);
    }
    return command[0] === undefined ? undefined : command;
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace service is not configured'));
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    return rootPath === undefined
      ? err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved', true))
      : ok(path.win32.normalize(rootPath));
  }
}

function defaultSpawner(command: readonly string[]): Result<ChildProcess> {
  try {
    return ok(spawn(command[0]!, [...command.slice(1)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch {
    return err(appError('EXECUTABLE_NOT_FOUND', `Language server could not start: ${command[0]}`));
  }
}

function quietPeriod(quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(quietMs, maxMs)));
}

function firstFile(input: Record<string, unknown>): string | undefined {
  if (typeof input.file === 'string' && input.file.trim().length > 0) return input.file.trim();
  const files = Array.isArray(input.files) ? input.files : [];
  const first = files.find((value) => typeof value === 'string' && value.trim().length > 0);
  return typeof first === 'string' ? first.trim() : undefined;
}

function languageIdForFile(file: string, fallback: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.tsx': return 'typescriptreact';
    case '.ts':
    case '.mts':
    case '.cts': return 'typescript';
    case '.jsx': return 'javascriptreact';
    case '.js':
    case '.mjs': return 'javascript';
    case '.py': return 'python';
    case '.rs': return 'rust';
    case '.go': return 'go';
    case '.java': return 'java';
    case '.cs': return 'csharp';
    default: return fallback;
  }
}

function pathToUri(file: string): string {
  const normalized = path.win32.normalize(file).replaceAll('\\', '/').replace(/^\/+/, '');
  return `file:///${encodeURI(normalized).replaceAll('#', '%23').replaceAll('?', '%3F')}`;
}

function uriToPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\/\//, '')).replaceAll('/', '\\');
  } catch {
    return uri.replace(/^file:\/\/\//, '').replaceAll('/', '\\');
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root.toLowerCase(), candidate.toLowerCase());
  if (relative === '') return true;
  if (path.win32.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.win32.sep);
  return firstSegment !== '..';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
