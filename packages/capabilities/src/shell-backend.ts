import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, WindowsProcessTree, toWindowsSpawnInvocation, type ExecutableResolver, type ProcessTreeTerminator } from '@lnwjud/process';
import type { CapabilityBackend } from './local-capability-service.js';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { capabilityTaskOwnerMatches, legacyCapabilityTaskOwner, readCapabilityActiveWorkspaceRoot, readCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

type ShellOperation = 'run' | 'list' | 'status' | 'wait' | 'logs' | 'result' | 'cancel' | 'resume' | 'approve' | 'deny';
type ShellExecution = 'foreground' | 'background' | 'auto';
type ShellPrivilege = 'user' | 'admin';
type TaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified';

interface ShellRequest {
  readonly operation: ShellOperation;
  readonly executable?: string;
  readonly arguments: readonly string[];
  readonly privilege: ShellPrivilege;
  readonly cwd?: string;
  readonly activeWorkspaceRoot?: string;
  readonly execution: ShellExecution;
  readonly taskId?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly tailLines?: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
  readonly owner: CapabilityTaskOwner;
}

export interface ShellCapabilityOptions {
  readonly allowedRoots: readonly string[];
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly executableResolver?: ExecutableResolver;
  readonly terminator?: ProcessTreeTerminator;
  readonly defaultTimeoutSeconds?: number;
  readonly defaultBackgroundTimeoutSeconds?: number;
  readonly taskStateDirectory?: string;
  readonly autoWaitSeconds?: number;
  readonly maxSynchronousWaitSeconds?: number;
  readonly maxSynchronousWaitSecondsProvider?: () => number;
  readonly maxOutputBytes?: number;
  readonly unrestricted?: boolean;
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
  readonly owner: CapabilityTaskOwner;
  state: TaskState;
  exitCode?: number;
  errorMessage?: string;
  finishedAt?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopRequested?: 'timed_out' | 'cancelled';
  terminationTarget?: 'timed_out' | 'cancelled';
  terminationAttempt?: Promise<boolean>;
}

const SHELL_OPERATIONS: readonly ShellOperation[] = ['run', 'list', 'status', 'wait', 'logs', 'result', 'cancel', 'resume', 'approve', 'deny'];
const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_BACKGROUND_TIMEOUT_SECONDS = 86_400;
const DEFAULT_AUTO_WAIT_SECONDS = 1;
const DEFAULT_MAX_SYNCHRONOUS_WAIT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 604_800;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FOREGROUND_CANCELLATION_RETRY_MS = 250;

export class ShellCapabilityBackend implements CapabilityBackend {
  private readonly tasks = new Map<string, ShellTaskRecord>();
  private readonly executableResolver: ExecutableResolver;
  private readonly terminator: ProcessTreeTerminator;
  private readonly allowedRoots: readonly string[];
  private readonly allowedRootsProvider: (() => Promise<readonly string[]>) | undefined;
  private readonly defaultTimeoutSeconds: number;
  private readonly defaultBackgroundTimeoutSeconds: number;
  private readonly durableStore: DurableShellTaskStore | undefined;
  private readonly autoWaitSeconds: number;
  private readonly maxSynchronousWaitSeconds: number;
  private readonly maxSynchronousWaitSecondsProvider: (() => number) | undefined;
  private readonly maxOutputBytes: number;
  private readonly unrestricted: boolean;

  public constructor(options: ShellCapabilityOptions) {
    if (options.allowedRoots.length === 0) throw new Error('At least one local capability root is required');
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.allowedRootsProvider = options.allowedRootsProvider;
    this.executableResolver = options.executableResolver ?? new PathExecutableResolver();
    this.terminator = options.terminator ?? new WindowsProcessTree();
    this.defaultTimeoutSeconds = clampNumber(options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.defaultBackgroundTimeoutSeconds = clampNumber(options.defaultBackgroundTimeoutSeconds ?? DEFAULT_BACKGROUND_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.durableStore = options.taskStateDirectory === undefined ? undefined : new DurableShellTaskStore(path.resolve(options.taskStateDirectory));
    this.autoWaitSeconds = clampNumber(options.autoWaitSeconds ?? DEFAULT_AUTO_WAIT_SECONDS, 0, DEFAULT_TIMEOUT_SECONDS);
    this.maxSynchronousWaitSeconds = clampNumber(options.maxSynchronousWaitSeconds ?? DEFAULT_MAX_SYNCHRONOUS_WAIT_SECONDS, 0.01, 90);
    this.maxSynchronousWaitSecondsProvider = options.maxSynchronousWaitSecondsProvider;
    this.maxOutputBytes = Math.floor(clampNumber(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES));
    this.unrestricted = options.unrestricted === true;
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const parsed = parseShellRequest(input, this.defaultTimeoutSeconds, this.defaultBackgroundTimeoutSeconds, this.maxOutputBytes);
    if (!parsed.ok) return parsed;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled', true));

    switch (parsed.value.operation) {
      case 'run': return this.run(parsed.value, signal);
      case 'list': return this.listTasks(parsed.value.owner);
      case 'status': return this.taskSnapshot(parsed.value.taskId, undefined, parsed.value.owner);
      case 'wait': return this.wait(parsed.value);
      case 'logs': return this.taskSnapshot(parsed.value.taskId, parsed.value.tailLines, parsed.value.owner);
      case 'result': return this.taskSnapshot(parsed.value.taskId, undefined, parsed.value.owner);
      case 'cancel':
        if (!parsed.value.userConfirmed) return err(appError('PERMISSION_REQUIRED', 'Cancelling a task requires explicit user confirmation'));
        return this.cancel(parsed.value.taskId, false, parsed.value.owner);
      case 'resume':
      case 'approve':
      case 'deny':
        return err(appError('INVALID_INPUT', `${parsed.value.operation} is not required by the local task runner`));
    }
  }

  private async run(request: ShellRequest, signal?: AbortSignal): Promise<Result<unknown>> {
    if (request.executable === undefined) return err(appError('INVALID_INPUT', 'Executable is required'));
    if (request.privilege === 'admin') return err(appError('PERMISSION_DENIED', 'Administrator access is not available to the local runner'));

    const cwd = await this.resolveCwd(request.cwd, request.activeWorkspaceRoot);
    if (!cwd.ok) return cwd;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));
    if (request.dryRun) {
      return ok({ dry_run: true, executable: request.executable, arguments: [...request.arguments], cwd: cwd.value });
    }
    const prohibitedReason = prohibitedAgentCommandReason(request.executable, request.arguments);
    if (prohibitedReason !== undefined) return err(appError('PERMISSION_DENIED', prohibitedReason));
    const riskyReason = riskyAgentCommandReason(request.executable, request.arguments);
    if (riskyReason !== undefined && !request.userConfirmed) return err(appError('PERMISSION_REQUIRED', riskyReason));
    const executable = await this.executableResolver.resolve(request.executable);
    if (!executable.ok) return executable;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));
    const invocation = toWindowsSpawnInvocation(executable.value, request.arguments, { allowMetacharacters: this.unrestricted });
    if (!invocation.ok) return invocation;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));

    if (this.durableStore !== undefined && request.execution !== 'foreground') {
      return this.runDurable(request, cwd.value, invocation.value);
    }

    let child: ChildProcess;
    try {
      child = spawn(invocation.value.executable, [...invocation.value.args], {
        cwd: cwd.value,
        env: createSafeEnvironment(process.env, this.unrestricted),
        shell: false,
        windowsHide: true,
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
      owner: request.owner,
      state: 'running',
    };
    this.tasks.set(record.taskId, record);

    child.stdout?.on('data', (chunk: Buffer | string) => record.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => record.stderr.append(chunk));
    child.once('error', () => {
      if (record.child.pid === undefined && record.terminationTarget !== undefined) {
        this.finish(
          record,
          record.terminationTarget,
          -1,
          record.terminationTarget === 'timed_out' ? 'Local task timed out' : undefined,
        );
      } else if (record.state === 'running' && record.stopRequested === undefined) {
        this.finish(record, 'failed', -1, 'Local task failed to start');
      }
    });
    child.once('close', (exitCode: number | null) => {
      if (record.state !== 'running') return;
      if (record.stopRequested !== undefined) return;
      this.finish(record, exitCode === 0 ? 'completed' : 'failed', exitCode ?? -1);
    });
    record.timer = setTimeout(() => { void this.timeout(record); }, request.timeoutSeconds * 1000);

    if (request.execution === 'background') return ok(this.snapshot(record));
    const synchronousWait = request.execution === 'auto'
      ? Math.min(this.autoWaitSeconds, this.currentMaxSynchronousWaitSeconds())
      : Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds());
    await this.waitForForeground(record, synchronousWait, signal);
    return ok(this.snapshot(record));
  }

  private async wait(request: ShellRequest): Promise<Result<unknown>> {
    if (request.taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const record = this.tasks.get(request.taskId);
    if (record !== undefined) {
      const ownership = this.authorizeTaskOwner(record.owner, request.owner);
      if (!ownership.ok) return ownership;
      await this.waitFor(record, Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds()));
      return ok(this.snapshot(record, request.tailLines));
    }
    if (this.durableStore !== undefined) {
      return this.durableStore.wait(request.taskId, Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds()), request.tailLines, request.owner);
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private currentMaxSynchronousWaitSeconds(): number {
    const configured = this.maxSynchronousWaitSecondsProvider?.();
    if (configured === undefined || !Number.isFinite(configured)) return this.maxSynchronousWaitSeconds;
    return clampNumber(configured, 0.01, 90);
  }

  private async waitFor(record: ShellTaskRecord, seconds: number): Promise<void> {
    if ((record.state !== 'running' && record.state !== 'termination_unverified') || seconds <= 0) return;
    await Promise.race([record.completion, delay(seconds * 1000)]);
  }

  private async waitForForeground(record: ShellTaskRecord, seconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await this.waitFor(record, seconds);
      return;
    }
    let cancellation: Promise<Result<unknown>> | undefined;
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
    const onAbort = (): void => {
      cancellation ??= this.cancel(record.taskId, true, record.owner);
      resolveAbort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([this.waitFor(record, seconds), aborted]);
      if (cancellation !== undefined) await cancellation;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async timeout(record: ShellTaskRecord): Promise<void> {
    if (record.state !== 'running' || record.stopRequested !== undefined) return;
    await this.tryTerminate(record, 'timed_out');
  }

  private async cancel(taskId: string | undefined, autoRetry = false, owner: CapabilityTaskOwner = legacyCapabilityTaskOwner()): Promise<Result<unknown>> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const existing = this.tasks.get(taskId);
    if (existing === undefined) {
      if (this.durableStore !== undefined) return this.durableStore.cancel(taskId, owner);
      return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
    }
    const record = existing;
    const ownership = this.authorizeTaskOwner(record.owner, owner);
    if (!ownership.ok) return ownership;
    if (record.state === 'running' || record.state === 'termination_unverified') {
      const targetState = record.terminationTarget ?? 'cancelled';
      let verified = await this.tryTerminate(record, targetState);
      while (!verified && autoRetry) {
        if (record.child.exitCode !== null || record.child.signalCode !== null) {
          await record.completion;
        }
        await delay(FOREGROUND_CANCELLATION_RETRY_MS);
        verified = await this.tryTerminate(record, targetState);
      }
      if (!verified) await record.completion;
    }
    return ok(this.snapshot(record));
  }

  private async tryTerminate(record: ShellTaskRecord, targetState: 'timed_out' | 'cancelled'): Promise<boolean> {
    if (isVerifiedTerminal(record.state)) return true;
    if (record.terminationAttempt !== undefined) return record.terminationAttempt;
    const attempt = this.performTermination(record, targetState);
    record.terminationAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (record.terminationAttempt === attempt) delete record.terminationAttempt;
    }
  }

  private async performTermination(record: ShellTaskRecord, targetState: 'timed_out' | 'cancelled'): Promise<boolean> {
    record.terminationTarget = targetState;
    record.stopRequested = targetState;
    if (record.timer !== undefined) clearTimeout(record.timer);
    const pid = record.child.pid;
    if (pid === undefined) {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Local task timed out, but process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
    try {
      await this.terminator.stop(record.child, pid);
      this.finish(record, targetState, -1, targetState === 'timed_out' ? 'Local task timed out' : undefined);
      return true;
    } catch {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Local task timed out, but process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
  }

  private async taskSnapshot(taskId: string | undefined, tailLines?: number, owner: CapabilityTaskOwner = legacyCapabilityTaskOwner()): Promise<Result<unknown>> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      const ownership = this.authorizeTaskOwner(record.owner, owner);
      return ownership.ok ? ok(this.snapshot(record, tailLines)) : ownership;
    }
    if (this.durableStore !== undefined) return this.durableStore.snapshot(taskId, tailLines, owner);
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private async runDurable(
    request: ShellRequest,
    cwd: string,
    invocation: { readonly executable: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean },
  ): Promise<Result<unknown>> {
    if (this.durableStore === undefined) return err(appError('INTERNAL_ERROR', 'Durable task store is unavailable', true));
    const taskId = randomUUID();
    const launched = await this.durableStore.launch({
      taskId,
      executable: invocation.executable,
      arguments: invocation.args,
      cwd,
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
      timeoutSeconds: request.timeoutSeconds,
      maxOutputBytes: request.maxOutputBytes,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      owner: request.owner,
    });
    if (!launched.ok || request.execution === 'background') return launched;
    return this.durableStore.wait(taskId, Math.min(this.autoWaitSeconds, this.currentMaxSynchronousWaitSeconds()), undefined, request.owner);
  }

  private async listTasks(owner: CapabilityTaskOwner): Promise<Result<unknown>> {
    const inMemory = [...this.tasks.values()]
      .filter((record) => capabilityTaskOwnerMatches(record.owner, owner))
      .map((record) => this.snapshot(record));
    if (this.durableStore === undefined) return ok({ tasks: inMemory });
    const durable = await this.durableStore.list(owner);
    const durableIds = new Set(durable.map((task) => task.task_id).filter((value): value is string => typeof value === 'string'));
    return ok({ tasks: [...durable, ...inMemory.filter((task) => !durableIds.has(String(task.task_id ?? '')))] });
  }

  private authorizeTaskOwner(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): Result<void> {
    return capabilityTaskOwnerMatches(stored, requester)
      ? ok(undefined)
      : err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
  }

  private async resolveCwd(requestedCwd: string | undefined, activeWorkspaceRoot: string | undefined): Promise<Result<string>> {
    if (this.unrestricted && activeWorkspaceRoot === undefined && requestedCwd !== undefined && (path.win32.isAbsolute(requestedCwd) || path.posix.isAbsolute(requestedCwd))) {
      try {
        const canonical = await realpath(requestedCwd);
        if (!(await stat(canonical)).isDirectory()) return err(appError('INVALID_INPUT', 'Working directory must be a directory'));
        return ok(canonical);
      } catch {
        return err(appError('FILE_NOT_FOUND', 'Working directory was not found'));
      }
    }
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

    let canonicalActiveRoot: string | undefined;
    if (activeWorkspaceRoot !== undefined) {
      if (!path.win32.isAbsolute(activeWorkspaceRoot) && !path.posix.isAbsolute(activeWorkspaceRoot)) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is invalid'));
      }
      try {
        canonicalActiveRoot = await realpath(activeWorkspaceRoot);
        if (!(await stat(canonicalActiveRoot)).isDirectory()) return err(appError('FILE_NOT_FOUND', 'Host active workspace root was not found'));
      } catch {
        return err(appError('FILE_NOT_FOUND', 'Host active workspace root was not found'));
      }
      if (!canonicalRoots.some((root) => isWithin(root, canonicalActiveRoot!))) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is outside configured local roots'));
      }
    }

    const baseRoot = canonicalActiveRoot ?? canonicalRoots[0]!;
    const candidate = requestedCwd === undefined ? baseRoot : path.resolve(baseRoot, requestedCwd);
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
    if (canonicalActiveRoot !== undefined && !isWithin(canonicalActiveRoot, canonicalCandidate)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Working directory is outside the host active workspace'));
    }
    return ok(canonicalCandidate);
  }

  private finish(record: ShellTaskRecord, state: TaskState, exitCode?: number, errorMessage?: string): void {
    if (record.state !== 'running' && record.state !== 'termination_unverified') return;
    record.state = state;
    delete record.stopRequested;
    delete record.terminationTarget;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (errorMessage !== undefined) record.errorMessage = errorMessage;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.resolveCompletion();
  }

  private markTerminationUnverified(record: ShellTaskRecord, errorMessage: string): void {
    record.state = 'termination_unverified';
    record.errorMessage = errorMessage;
    delete record.finishedAt;
    if (record.timer !== undefined) clearTimeout(record.timer);
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

function parseShellRequest(value: unknown, defaultTimeoutSeconds: number, defaultBackgroundTimeoutSeconds: number, maxOutputBytes: number): Result<ShellRequest> {
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
  const timeoutSeconds = value.timeout_seconds === undefined
    ? (execution === 'background' || execution === 'auto' ? defaultBackgroundTimeoutSeconds : defaultTimeoutSeconds)
    : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'Timeout is invalid'));
  const requestedMaxBytes = value.max_output_bytes === undefined ? maxOutputBytes : value.max_output_bytes;
  if (typeof requestedMaxBytes !== 'number' || !Number.isInteger(requestedMaxBytes) || requestedMaxBytes < 1 || requestedMaxBytes > MAX_OUTPUT_BYTES) return err(appError('INVALID_INPUT', 'Output limit is invalid'));
  const tailLines = value.tail_lines === undefined ? undefined : value.tail_lines;
  if (tailLines !== undefined && (typeof tailLines !== 'number' || !Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000)) return err(appError('INVALID_INPUT', 'Tail limit is invalid'));
  const includeStdout = value.include_stdout === undefined ? true : value.include_stdout;
  const includeStderr = value.include_stderr === undefined ? true : value.include_stderr;
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  const userConfirmed = value.userConfirmed === true;
  const owner = readCapabilityTaskOwner(value);
  const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(value);
  if (typeof includeStdout !== 'boolean' || typeof includeStderr !== 'boolean' || typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Shell flags are invalid'));
  return ok({ operation, ...(executable === undefined ? {} : { executable: executable.trim() }), arguments: rawArguments, privilege, ...(cwd === undefined ? {} : { cwd }), ...(activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot }), execution, ...(taskId === undefined ? {} : { taskId }), timeoutSeconds, maxOutputBytes: requestedMaxBytes, ...(tailLines === undefined ? {} : { tailLines }), includeStdout, includeStderr, dryRun, userConfirmed, owner });
}

function isShellOperation(value: unknown): value is ShellOperation {
  return typeof value === 'string' && SHELL_OPERATIONS.some((operation) => operation === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}

function createSafeEnvironment(source: NodeJS.ProcessEnv, unrestricted: boolean): NodeJS.ProcessEnv {
  if (unrestricted) return { ...source };
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

function isVerifiedTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
