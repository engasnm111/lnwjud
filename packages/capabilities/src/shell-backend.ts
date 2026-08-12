import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, WindowsProcessTree, type ExecutableResolver, type ProcessTreeTerminator } from '@lnwjud/process';
import type { CapabilityBackend } from './local-capability-service.js';

type ShellOperation = 'run' | 'status' | 'wait' | 'logs' | 'result' | 'cancel' | 'resume' | 'approve' | 'deny';
type ShellExecution = 'foreground' | 'background' | 'auto';
type ShellPrivilege = 'user' | 'admin';
type TaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

interface ShellRequest {
  readonly operation: ShellOperation;
  readonly executable?: string;
  readonly arguments: readonly string[];
  readonly privilege: ShellPrivilege;
  readonly cwd?: string;
  readonly execution: ShellExecution;
  readonly taskId?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly tailLines?: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly dryRun: boolean;
}

export interface ShellCapabilityOptions {
  readonly allowedRoots: readonly string[];
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly executableResolver?: ExecutableResolver;
  readonly terminator?: ProcessTreeTerminator;
  readonly defaultTimeoutSeconds?: number;
  readonly autoWaitSeconds?: number;
  readonly maxOutputBytes?: number;
}

interface ShellTaskRecord {
  readonly taskId: string;
  readonly child: ChildProcess;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly maxOutputBytes: number;
  readonly stdout: OutputCapture;
  readonly stderr: OutputCapture;
  readonly startedAt: string;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  state: TaskState;
  exitCode?: number;
  errorMessage?: string;
  finishedAt?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const SHELL_OPERATIONS: readonly ShellOperation[] = ['run', 'status', 'wait', 'logs', 'result', 'cancel', 'resume', 'approve', 'deny'];
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_AUTO_WAIT_SECONDS = 1;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class ShellCapabilityBackend implements CapabilityBackend {
  private readonly tasks = new Map<string, ShellTaskRecord>();
  private readonly executableResolver: ExecutableResolver;
  private readonly terminator: ProcessTreeTerminator;
  private readonly allowedRoots: readonly string[];
  private readonly allowedRootsProvider: (() => Promise<readonly string[]>) | undefined;
  private readonly defaultTimeoutSeconds: number;
  private readonly autoWaitSeconds: number;
  private readonly maxOutputBytes: number;

  public constructor(options: ShellCapabilityOptions) {
    if (options.allowedRoots.length === 0) throw new Error('At least one local capability root is required');
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.allowedRootsProvider = options.allowedRootsProvider;
    this.executableResolver = options.executableResolver ?? new PathExecutableResolver();
    this.terminator = options.terminator ?? new WindowsProcessTree();
    this.defaultTimeoutSeconds = clampNumber(options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.autoWaitSeconds = clampNumber(options.autoWaitSeconds ?? DEFAULT_AUTO_WAIT_SECONDS, 0, DEFAULT_TIMEOUT_SECONDS);
    this.maxOutputBytes = Math.floor(clampNumber(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES));
  }

  public async execute(input: unknown): Promise<Result<unknown>> {
    const parsed = parseShellRequest(input, this.defaultTimeoutSeconds, this.maxOutputBytes);
    if (!parsed.ok) return parsed;

    switch (parsed.value.operation) {
      case 'run': return this.run(parsed.value);
      case 'status': return this.taskSnapshot(parsed.value.taskId);
      case 'wait': return this.wait(parsed.value);
      case 'logs': return this.taskSnapshot(parsed.value.taskId, parsed.value.tailLines);
      case 'result': return this.taskSnapshot(parsed.value.taskId);
      case 'cancel': return this.cancel(parsed.value.taskId);
      case 'resume':
      case 'approve':
      case 'deny':
        return err(appError('INVALID_INPUT', `${parsed.value.operation} is not required by the local task runner`));
    }
  }

  private async run(request: ShellRequest): Promise<Result<unknown>> {
    if (request.executable === undefined) return err(appError('INVALID_INPUT', 'Executable is required'));
    if (request.privilege === 'admin') return err(appError('PERMISSION_DENIED', 'Administrator access is not available to the local runner'));
    if (isDeleteLikeShellCommand(request.executable, request.arguments)) {
      return err(appError(
        'PERMISSION_REQUIRED',
        'Delete/remove commands are blocked. Ask the user to confirm, then use delete_file with userConfirmed: true',
      ));
    }

    const cwd = await this.resolveCwd(request.cwd);
    if (!cwd.ok) return cwd;
    const executable = await this.executableResolver.resolve(request.executable);
    if (!executable.ok) return executable;
    const invocation = toSpawnInvocation(executable.value, request.arguments);
    if (!invocation.ok) return invocation;

    if (request.dryRun) {
      return ok({ dry_run: true, executable: invocation.value.executable, arguments: [...invocation.value.args], cwd: cwd.value });
    }

    let child: ChildProcess;
    try {
      child = spawn(invocation.value.executable, [...invocation.value.args], {
        cwd: cwd.value,
        env: createSafeEnvironment(process.env),
        shell: false,
        windowsHide: false,
        ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Local task could not start', true));
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const record: ShellTaskRecord = {
      taskId: randomUUID(),
      child,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      maxOutputBytes: request.maxOutputBytes,
      stdout: new OutputCapture(request.maxOutputBytes),
      stderr: new OutputCapture(request.maxOutputBytes),
      startedAt: new Date().toISOString(),
      completion,
      resolveCompletion,
      state: 'running',
    };
    this.tasks.set(record.taskId, record);

    child.stdout?.on('data', (chunk: Buffer | string) => record.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => record.stderr.append(chunk));
    child.once('error', () => {
      if (record.state === 'running') this.finish(record, 'failed', -1, 'Local task failed to start');
    });
    child.once('close', (exitCode: number | null) => {
      if (record.state !== 'running') return;
      this.finish(record, exitCode === 0 ? 'completed' : 'failed', exitCode ?? -1);
    });
    record.timer = setTimeout(() => { void this.timeout(record); }, request.timeoutSeconds * 1000);

    if (request.execution === 'background') return ok(this.snapshot(record));
    await this.waitFor(record, request.execution === 'auto' ? this.autoWaitSeconds : request.timeoutSeconds);
    return ok(this.snapshot(record));
  }

  private async wait(request: ShellRequest): Promise<Result<unknown>> {
    const record = this.getTask(request.taskId);
    if (!record.ok) return record;
    await this.waitFor(record.value, request.timeoutSeconds);
    return ok(this.snapshot(record.value, request.tailLines));
  }

  private async waitFor(record: ShellTaskRecord, seconds: number): Promise<void> {
    if (record.state !== 'running' || seconds <= 0) return;
    await Promise.race([record.completion, delay(seconds * 1000)]);
  }

  private async timeout(record: ShellTaskRecord): Promise<void> {
    if (record.state !== 'running') return;
    this.finish(record, 'timed_out', -1, 'Local task timed out');
    const pid = record.child.pid;
    if (pid !== undefined) await this.terminator.stop(record.child, pid);
  }

  private async cancel(taskId: string | undefined): Promise<Result<unknown>> {
    const record = this.getTask(taskId);
    if (!record.ok) return record;
    if (record.value.state === 'running') {
      this.finish(record.value, 'cancelled', -1);
      const pid = record.value.child.pid;
      if (pid !== undefined) await this.terminator.stop(record.value.child, pid);
    }
    return ok(this.snapshot(record.value));
  }

  private taskSnapshot(taskId: string | undefined, tailLines?: number): Result<unknown> {
    const record = this.getTask(taskId);
    return record.ok ? ok(this.snapshot(record.value, tailLines)) : record;
  }

  private getTask(taskId: string | undefined): Result<ShellTaskRecord> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const task = this.tasks.get(taskId);
    return task === undefined ? err(appError('PROCESS_NOT_FOUND', 'Task was not found')) : ok(task);
  }

  private async resolveCwd(requestedCwd: string | undefined): Promise<Result<string>> {
    const configuredRoots = this.allowedRootsProvider === undefined ? this.allowedRoots : await this.allowedRootsProvider();
    const canonicalRoots: string[] = [];
    for (const root of configuredRoots) {
      try {
        if ((await stat(root)).isDirectory()) canonicalRoots.push(await realpath(root));
      } catch {
        continue;
      }
    }
    if (canonicalRoots.length === 0) return err(appError('FILE_NOT_FOUND', 'No local capability root is available'));

    const candidate = path.resolve(requestedCwd ?? canonicalRoots[0]!);
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(candidate);
      if (!(await stat(canonicalCandidate)).isDirectory()) return err(appError('INVALID_INPUT', 'Working directory must be a directory'));
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Working directory was not found'));
    }
    if (!canonicalRoots.some((root) => isWithin(root, canonicalCandidate))) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Working directory is outside configured local roots'));
    }
    return ok(canonicalCandidate);
  }

  private finish(record: ShellTaskRecord, state: TaskState, exitCode?: number, errorMessage?: string): void {
    if (record.state !== 'running') return;
    record.state = state;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (errorMessage !== undefined) record.errorMessage = errorMessage;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.resolveCompletion();
  }

  private snapshot(record: ShellTaskRecord, tailLines?: number): Record<string, unknown> {
    const stdout = record.includeStdout ? record.stdout.text(tailLines) : undefined;
    const stderr = record.includeStderr ? record.stderr.text(tailLines) : undefined;
    return {
      task_id: record.taskId,
      state: record.state,
      ...(record.exitCode === undefined ? {} : { exit_code: record.exitCode }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
      started_at: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finished_at: record.finishedAt }),
      truncated: record.stdout.truncated || record.stderr.truncated,
    };
  }
}

class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  public constructor(private readonly maxBytes: number) {}

  public append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const remaining = this.maxBytes - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.bytes += Math.min(chunk.byteLength, remaining);
    if (chunk.byteLength > remaining) this.truncated = true;
  }

  public text(tailLines?: number): string {
    const value = redactText(Buffer.concat(this.chunks).toString('utf8'));
    if (tailLines === undefined || tailLines < 1) return tailLines === 0 ? '' : value;
    const lines = value.split(/\r?\n/);
    return lines.slice(-tailLines).join('\n');
  }
}

function parseShellRequest(value: unknown, defaultTimeoutSeconds: number, maxOutputBytes: number): Result<ShellRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Shell input must be an object'));
  const operation = value.operation === undefined ? 'run' : value.operation;
  if (!isShellOperation(operation)) return err(appError('INVALID_INPUT', 'Shell operation is invalid'));
  const executable = value.executable === undefined ? undefined : value.executable;
  if (executable !== undefined && (typeof executable !== 'string' || executable.trim().length === 0)) return err(appError('INVALID_INPUT', 'Executable is invalid'));
  const rawArguments = value.arguments === undefined ? [] : value.arguments;
  if (!Array.isArray(rawArguments) || !rawArguments.every((item) => typeof item === 'string')) return err(appError('INVALID_INPUT', 'Arguments must be strings'));
  const privilege = value.privilege === undefined ? 'user' : value.privilege;
  if (privilege !== 'user' && privilege !== 'admin') return err(appError('INVALID_INPUT', 'Privilege is invalid'));
  const execution = value.execution === undefined ? 'auto' : value.execution;
  if (execution !== 'foreground' && execution !== 'background' && execution !== 'auto') return err(appError('INVALID_INPUT', 'Execution mode is invalid'));
  const cwd = value.cwd === undefined ? undefined : value.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) return err(appError('INVALID_INPUT', 'Working directory is invalid'));
  const taskId = value.task_id === undefined ? undefined : value.task_id;
  if (taskId !== undefined && (typeof taskId !== 'string' || taskId.trim().length === 0)) return err(appError('INVALID_INPUT', 'Task ID is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined ? defaultTimeoutSeconds : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'Timeout is invalid'));
  const requestedMaxBytes = value.max_output_bytes === undefined ? maxOutputBytes : value.max_output_bytes;
  if (typeof requestedMaxBytes !== 'number' || !Number.isInteger(requestedMaxBytes) || requestedMaxBytes < 1 || requestedMaxBytes > MAX_OUTPUT_BYTES) return err(appError('INVALID_INPUT', 'Output limit is invalid'));
  const tailLines = value.tail_lines === undefined ? undefined : value.tail_lines;
  if (tailLines !== undefined && (typeof tailLines !== 'number' || !Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000)) return err(appError('INVALID_INPUT', 'Tail limit is invalid'));
  const includeStdout = value.include_stdout === undefined ? true : value.include_stdout;
  const includeStderr = value.include_stderr === undefined ? true : value.include_stderr;
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof includeStdout !== 'boolean' || typeof includeStderr !== 'boolean' || typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Shell flags are invalid'));
  return ok({ operation, ...(executable === undefined ? {} : { executable: executable.trim() }), arguments: rawArguments, privilege, ...(cwd === undefined ? {} : { cwd }), execution, ...(taskId === undefined ? {} : { taskId }), timeoutSeconds, maxOutputBytes: requestedMaxBytes, ...(tailLines === undefined ? {} : { tailLines }), includeStdout, includeStderr, dryRun });
}

function isShellOperation(value: unknown): value is ShellOperation {
  return typeof value === 'string' && SHELL_OPERATIONS.some((operation) => operation === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toSpawnInvocation(executable: string, args: readonly string[]): Result<{ readonly executable: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean }> {
  if (process.platform !== 'win32' || !['.cmd', '.bat'].includes(path.extname(executable).toLowerCase())) return ok({ executable, args });
  const values = [executable, ...args];
  if (values.some((value) => /[\r\n&|<>^%!]/.test(value) || value.includes('"'))) return err(appError('INVALID_INPUT', 'Windows command shim arguments contain unsupported shell metacharacters'));
  const commandLine = values.map((value) => /\s/.test(value) ? `"${value}"` : value).join(' ');
  return ok({ executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', commandLine], windowsVerbatimArguments: true });
}

function createSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec'].map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, entry]) => {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
    return entry !== undefined && allowed.has(normalizedKey);
  }));
}

function redactText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isDeleteLikeShellCommand(executable: string, args: readonly string[]): boolean {
  const basename = path.win32.basename(executable).toLowerCase();
  const deleteNames = new Set(['del', 'del.exe', 'erase', 'erase.exe', 'rm', 'rm.exe', 'rmdir', 'rmdir.exe', 'rd', 'rd.exe', 'unlink', 'unlink.exe']);
  if (deleteNames.has(basename)) return true;
  const joined = args.map((entry) => entry.toLowerCase()).join(' ');
  if (basename === 'powershell.exe' || basename === 'powershell' || basename === 'pwsh.exe' || basename === 'pwsh') {
    return /\bremove-item\b/.test(joined) || /\brm\b/.test(joined) || /\bdel\b/.test(joined);
  }
  if (basename === 'cmd.exe' || basename === 'cmd') {
    return /(^|[\s&|])(del|erase|rd|rmdir)\b/.test(joined);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
