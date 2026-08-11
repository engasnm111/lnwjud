import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, type ExecutableResolver } from './executable-resolver.js';
import { LogRingBuffer } from './ring-buffer.js';
import type { ProcessTreeTerminator } from './windows-process-tree.js';
import { WindowsProcessTree } from './windows-process-tree.js';
import type { LogQuery, ManagedProcess, ManagedProcessStart, ManagedProcessState, ProcessLogResult } from './process-types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

interface ManagedRecord {
  readonly processId: string;
  readonly child: ChildProcess;
  readonly spec: ManagedProcessStart;
  readonly startedAt: string;
  readonly logs: LogRingBuffer;
  state: ManagedProcessState;
  finishedAt?: string;
  exitCode?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class ProcessManager {
  private readonly records = new Map<string, ManagedRecord>();

  public constructor(
    private readonly terminator: ProcessTreeTerminator = new WindowsProcessTree(),
    private readonly executableResolver: ExecutableResolver = new PathExecutableResolver(),
  ) {}

  public async start(spec: ManagedProcessStart): Promise<Result<ManagedProcess>> {
    const validation = this.validateSpec(spec);
    if (!validation.ok) return validation;
    const resolvedExecutable = await this.executableResolver.resolve(spec.executable);
    if (!resolvedExecutable.ok) return resolvedExecutable;
    const invocation = toSpawnInvocation(resolvedExecutable.value, spec.args);
    if (!invocation.ok) return invocation;
    const processId = randomUUID();
    const child = spawn(invocation.value.executable, [...invocation.value.args], {
      cwd: spec.cwd,
      env: createSafeEnvironment(process.env),
      shell: false,
      windowsHide: true,
      ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
    });
    const record: ManagedRecord = {
      processId,
      child,
      spec,
      startedAt: new Date().toISOString(),
      logs: new LogRingBuffer(),
      state: 'starting',
    };
    this.records.set(processId, record);
    child.stdout?.on('data', (chunk: Buffer) => record.logs.append('stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => record.logs.append('stderr', chunk.toString('utf8')));
    child.once('error', (error: Error & { code?: string }) => this.handleError(record, error));
    child.once('close', (exitCode: number | null) => this.handleClose(record, exitCode));

    return new Promise((resolve) => {
      child.once('spawn', () => {
        if (record.state === 'starting') record.state = 'running';
        record.timer = setTimeout(() => { void this.timeout(record); }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        resolve(ok(this.snapshot(record)));
      });
      child.once('error', (error: Error & { code?: string }) => {
        resolve(err(error.code === 'ENOENT' ? appError('EXECUTABLE_NOT_FOUND', 'Executable was not found') : appError('INTERNAL_ERROR', 'Process could not start')));
      });
    });
  }

  public status(processId: string): Result<ManagedProcess> {
    const record = this.records.get(processId);
    return record === undefined ? err(appError('PROCESS_NOT_FOUND', 'Process was not found')) : ok(this.snapshot(record));
  }

  public list(): readonly ManagedProcess[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  public logs(processId: string, query: LogQuery): Result<ProcessLogResult> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (query.tailLines !== undefined && (!Number.isInteger(query.tailLines) || query.tailLines < 1 || query.tailLines > 10000)) {
      return err(appError('INVALID_INPUT', 'Log tail limit is invalid'));
    }
    if (query.sinceSequence !== undefined && (!Number.isInteger(query.sinceSequence) || query.sinceSequence < 0)) {
      return err(appError('INVALID_INPUT', 'Log sequence cursor is invalid'));
    }
    return ok(record.logs.read(query));
  }

  public async stop(processId: string): Promise<Result<void>> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (isTerminal(record.state)) return ok(undefined);
    const pid = record.child.pid;
    if (pid === undefined) return err(appError('INTERNAL_ERROR', 'Process PID was not available'));
    this.finish(record, 'stopped');
    await this.terminator.stop(record.child, pid);
    return ok(undefined);
  }

  private validateSpec(spec: ManagedProcessStart): Result<void> {
    if (typeof spec.executable !== 'string' || spec.executable.trim().length === 0 || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) {
      return err(appError('INVALID_INPUT', 'Executable and args are required'));
    }
    if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)) {
      return err(appError('INVALID_INPUT', 'Process cwd must be an absolute path'));
    }
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return err(appError('INVALID_INPUT', 'Process timeout is invalid'));
    }
    return ok(undefined);
  }

  private handleError(record: ManagedRecord, error: Error & { code?: string }): void {
    if (!isTerminal(record.state)) this.finish(record, 'failed');
    if (error.code !== 'ENOENT') record.exitCode = -1;
  }

  private handleClose(record: ManagedRecord, exitCode: number | null): void {
    if (!isTerminal(record.state)) this.finish(record, 'exited');
    if (record.exitCode === undefined && exitCode !== null) record.exitCode = exitCode;
  }

  private async timeout(record: ManagedRecord): Promise<void> {
    if (record.state !== 'running') return;
    const pid = record.child.pid;
    this.finish(record, 'timed_out');
    if (pid !== undefined) await this.terminator.stop(record.child, pid);
  }

  private finish(record: ManagedRecord, state: ManagedProcessState): void {
    record.state = state;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
  }

  private snapshot(record: ManagedRecord): ManagedProcess {
    return {
      processId: record.processId,
      executable: record.spec.executable,
      args: [...record.spec.args],
      cwd: record.spec.cwd,
      state: record.state,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    };
  }
}

interface SpawnInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

function toSpawnInvocation(executable: string, args: readonly string[]): Result<SpawnInvocation> {
  if (process.platform !== 'win32' || !['.cmd', '.bat'].includes(path.extname(executable).toLowerCase())) {
    return ok({ executable, args });
  }
  const values = [executable, ...args];
  if (values.some((value) => /[\r\n&|<>^%!"]/.test(value))) {
    return err(appError('INVALID_INPUT', 'Windows command shim arguments contain unsupported shell metacharacters'));
  }
  const commandLine = `"${values.map(quoteWindowsCommandArgument).join(' ')}"`;
  return ok({ executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', commandLine], windowsVerbatimArguments: true });
}

function quoteWindowsCommandArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function isTerminal(state: ManagedProcessState): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out';
}

function createSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'HOME', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  ].map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
    return allowed.has(normalizedKey) && value !== undefined;
  }));
}
