import { spawn, type ChildProcess } from 'node:child_process';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, type ExecutableResolver } from './executable-resolver.js';
import { LogRingBuffer } from './ring-buffer.js';
import { createProcessTreeTerminator, type ProcessTreeTerminator } from './process-tree.js';
import { classifyPosixGroupCompletion, inspectPosixProcessGroup, type PosixProcessGroupInspector } from './posix-process-tree.js';
import { createSpawnInvocationFactory, type SpawnInvocationFactory } from './spawn-invocation.js';
import type { NativeAttemptBinding, NativeAttemptHandle, NativeOutputCursor, NativeOutputRead, NativeProcessObservation, WindowsNativeAuthority } from './windows-native-authority.js';
import type { LogQuery, ManagedProcess, ManagedProcessStart, ManagedProcessState, ProcessLogResult } from './process-types.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const START_CANCELLATION_RETRY_MS = 250;

export const DEFAULT_MAX_ACTIVE_MANAGED_PROCESSES = 24;
export const DEFAULT_MAX_RETAINED_TERMINAL_PROCESSES = 32;
export const MAX_RETAINED_TERMINAL_PROCESS_LOG_BYTES = 256 * 1024;

interface ManagedRecordBase {
  readonly processId: string;
  readonly spec: ManagedProcessStart;
  readonly startedAt: string;
  readonly logs: LogRingBuffer;
  readonly onVerifiedNativeTermination?: () => void | Promise<void>;
  nativeAcceptance?: Promise<void>;
  nativeRecoveryTimer?: ReturnType<typeof setTimeout>;
  nativeRecoveryDelay?: number;
  nativeTerminationNotified?: boolean;
  posixExitState?: 'exited' | 'failed';
  posixPipesClosed?: boolean;
  state: ManagedProcessState;
  finishedAt?: string;
  exitCode?: number;
  errorMessage?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopRequested?: 'stopped' | 'timed_out';
  terminationAttempt?: Promise<boolean>;
  terminationTarget?: 'stopped' | 'timed_out';
  terminationVerified?: Promise<void>;
  resolveTerminationVerified?: () => void;
}

interface ChildManagedRecord extends ManagedRecordBase {
  readonly kind: 'child';
  readonly child: ChildProcess;
}

interface ServiceManagedRecord extends ManagedRecordBase {
  readonly kind: 'service';
  readonly handle: NativeAttemptHandle;
  readonly stdoutDecoder: StringDecoder;
  readonly stderrDecoder: StringDecoder;
  cursor: NativeOutputCursor;
  outputComplete: boolean;
  outputWarning?: string;
  outputRead?: Promise<boolean>;
  outputFlushed?: boolean;
  refresh?: Promise<void>;
  targetPid?: number;
}

type ManagedRecord = ChildManagedRecord | ServiceManagedRecord;

export class ProcessManager {
  private readonly records = new Map<string, ManagedRecord>();

  public constructor(
    private readonly terminator: ProcessTreeTerminator = createProcessTreeTerminator(),
    private readonly executableResolver: ExecutableResolver = new PathExecutableResolver(),
    private readonly maxActiveProcesses: number = DEFAULT_MAX_ACTIVE_MANAGED_PROCESSES,
    private readonly invocationFactory: SpawnInvocationFactory = createSpawnInvocationFactory(),
    private readonly nativeContainmentRoot?: string,
    private readonly nativeAuthority?: WindowsNativeAuthority,
    private readonly posixGroupInspector: PosixProcessGroupInspector | undefined = process.platform === 'win32' ? undefined : inspectPosixProcessGroup,
  ) {}

  public async start(
    spec: ManagedProcessStart,
    signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
    onVerifiedNativeTermination?: () => void | Promise<void>,
  ): Promise<Result<ManagedProcess>> {
    if (process.platform === 'win32' && this.nativeContainmentRoot !== undefined) {
      return this.startService(spec, signal, onCreated, onVerifiedNativeTermination);
    }
    // macOS has no kernel owner-loss boundary for escaped process descendants.
    if (process.platform === 'darwin' && onVerifiedNativeTermination !== undefined) {
      try { await onVerifiedNativeTermination(); }
      catch { return err(appError('INTERNAL_ERROR', 'macOS managed writer prelaunch admission release failed')); }
      return err(appError('CONFLICT', 'macOS process writer containment unavailable: escaped descendants cannot be verified; no process launched'));
    }
    // A writer reservation is safe to release only before any child is spawned,
    // or after a launched child has verified native zero-active termination.
    const rejectBeforeSpawn = async (failure: Result<never>): Promise<Result<never>> => {
      try { await onVerifiedNativeTermination?.(); } catch { return err(appError('INTERNAL_ERROR', 'Prelaunch abort is verified but admission release failed')); }
      return failure;
    };
    const activeProcesses = this.activeProcessCount();
    if (activeProcesses >= this.maxActiveProcesses) {
      return rejectBeforeSpawn(err(appError('CONFLICT', `Too many managed processes are already active (${activeProcesses}/${this.maxActiveProcesses}); wait for existing work or stop a process before starting another.`, true)));
    }
    const validation = this.validateSpec(spec);
    if (!validation.ok) return rejectBeforeSpawn(validation);
    if (isAborted(signal)) return rejectBeforeSpawn(cancelledStart());
    const resolvedExecutable = await this.executableResolver.resolve(spec.executable);
    if (isAborted(signal)) return rejectBeforeSpawn(cancelledStart());
    if (!resolvedExecutable.ok) return rejectBeforeSpawn(resolvedExecutable);
    const invocation = this.invocationFactory.create(resolvedExecutable.value, spec.args);
    if (!invocation.ok) return rejectBeforeSpawn(invocation);
    if (isAborted(signal)) return rejectBeforeSpawn(cancelledStart());
    const processId = spec.containmentId ?? spec.nativeBinding?.taskId ?? randomUUID();
    if (spec.containmentId !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(spec.containmentId)) {
      return rejectBeforeSpawn(err(appError('INVALID_INPUT', 'Native containment identifier is invalid')));
    }
    const child = spawn(invocation.value.executable, [...invocation.value.args], {
      cwd: spec.cwd,
      env: createSafeEnvironment(process.env),
      shell: false,
      ...(spec.stdinMode === 'ignore' ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : {}),
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
    });
    const record: ChildManagedRecord = {
      kind: 'child',
      processId,
      child,
      spec,
      startedAt: new Date().toISOString(),
      logs: new LogRingBuffer(),
      ...(onVerifiedNativeTermination === undefined ? {} : { onVerifiedNativeTermination }),
      state: 'starting',
    };
    this.records.set(processId, record);
    onCreated?.(this.snapshot(record));
    child.stdout?.on('data', (chunk: Buffer) => record.logs.append('stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => record.logs.append('stderr', chunk.toString('utf8')));
    child.once('error', (error: Error & { code?: string }) => this.handleError(record, error));
    child.once('exit', (exitCode: number | null) => {
      if (this.posixGroupInspector !== undefined) {
        record.posixExitState = 'exited';
        if (exitCode !== null) record.exitCode = exitCode;
        void this.acceptPosixCompletion(record);
      }
    });
    child.once('close', (exitCode: number | null) => {
      record.posixPipesClosed = true;
      this.handleClose(record, exitCode);
    });

    return new Promise((resolve) => {
      let settled = false;
      let cancellationRequested = false;
      let cancellationInProgress = false;
      const settle = (result: Result<ManagedProcess>): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        if (settled) return;
        cancellationRequested = true;
        if (cancellationInProgress) return;
        const pid = record.child.pid;
        if (pid === undefined) return;
        cancellationInProgress = true;
        void (async (): Promise<void> => {
          let verified = false;
          while (!verified) {
            verified = await this.tryTerminate(record, 'stopped');
            if (!verified) {
              if (!isChildLive(record.child)) await this.waitForVerifiedTermination(record);
              await delay(START_CANCELLATION_RETRY_MS);
            }
          }
          settle(cancelledStart());
        })();
      };
      child.once('spawn', () => {
        void (async (): Promise<void> => {
        if (cancellationRequested || isAborted(signal)) {
          onAbort();
          return;
        }
        if (record.state === 'starting') record.state = 'running';
        if (!isVerifiedTerminal(record.state)) record.timer = setTimeout(() => { void this.timeout(record); }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        settle(ok(this.snapshot(record)));
        })().catch(() => {
          this.markTerminationUnverified(record, 'Native start could not be verified');
          settle(err(appError('INTERNAL_ERROR', 'Native process start could not be verified')));
        });
      });
      child.once('error', (error: Error & { code?: string }) => {
        if (cancellationRequested) {
          settle(cancelledStart());
          return;
        }
        settle(err(error.code === 'ENOENT' ? appError('EXECUTABLE_NOT_FOUND', 'Executable was not found') : appError('INTERNAL_ERROR', 'Process could not start')));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (isAborted(signal)) onAbort();
    });
  }

  public async attach(
    spec: ManagedProcessStart,
    onCreated?: (process: ManagedProcess) => void,
    onVerifiedNativeTermination?: () => void | Promise<void>,
  ): Promise<Result<ManagedProcess>> {
    const attached = this.serviceRecord(spec, onCreated, onVerifiedNativeTermination);
    if (!attached.ok) return attached;
    await this.refreshService(attached.value);
    return ok(this.snapshot(attached.value));
  }

  private serviceRecord(
    spec: ManagedProcessStart,
    onCreated?: (process: ManagedProcess) => void,
    onVerifiedNativeTermination?: () => void | Promise<void>,
  ): Result<ServiceManagedRecord> {
    if (process.platform !== 'win32' || this.nativeContainmentRoot === undefined || this.nativeAuthority === undefined || spec.nativeBinding === undefined) {
      return err(appError('INTERNAL_ERROR', 'Native process authority and attempt identity are required'));
    }
    const processId = spec.containmentId ?? spec.nativeBinding.taskId;
    const existing = this.records.get(processId);
    if (existing !== undefined) {
      return existing.kind === 'service' && sameNativeBinding(existing.handle.binding, spec.nativeBinding)
        ? ok(existing) : err(appError('CONFLICT', 'Process identity is already owned by another attempt'));
    }
    try {
      const record: ServiceManagedRecord = {
        kind: 'service', processId, spec, handle: this.nativeAuthority.attachProcess(spec.nativeBinding),
        startedAt: new Date().toISOString(), logs: new LogRingBuffer(), state: 'starting',
        cursor: { stdoutOffset: 0, stderrOffset: 0 }, outputComplete: false,
        stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'),
        ...(onVerifiedNativeTermination === undefined ? {} : { onVerifiedNativeTermination }),
      };
      this.records.set(processId, record);
      onCreated?.(this.snapshot(record));
      return ok(record);
    } catch {
      return err(appError('INVALID_INPUT', 'Native process attempt identity is invalid'));
    }
  }

  private async startService(
    spec: ManagedProcessStart,
    signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
    onVerifiedNativeTermination?: () => void | Promise<void>,
  ): Promise<Result<ManagedProcess>> {
    const processId = spec.containmentId ?? spec.nativeBinding?.taskId;
    const existing = processId === undefined ? undefined : this.records.get(processId);
    const activeProcesses = this.activeProcessCount();
    const attached = this.serviceRecord(spec, onCreated, onVerifiedNativeTermination);
    if (!attached.ok) return attached;
    const record = attached.value;
    if (existing !== undefined) {
      if (!isVerifiedTerminal(record.state)) await this.refreshService(record);
      return ok(this.snapshot(record));
    }
    const rejectBeforeDispatch = async (failure: Result<never>): Promise<Result<never>> => {
      try { await this.acceptServiceObservation(record, await record.handle.abortBeforeDispatch()); }
      catch { this.markTerminationUnverified(record, 'Native prelaunch abort is unverified; reservation retained'); }
      return failure;
    };
    if (activeProcesses >= this.maxActiveProcesses) {
      return rejectBeforeDispatch(err(appError('CONFLICT', `Too many managed processes are already active (${activeProcesses}/${this.maxActiveProcesses})`, true)));
    }
    const validation = this.validateSpec(spec);
    if (!validation.ok) return rejectBeforeDispatch(validation);
    if (spec.containmentId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(spec.containmentId)) {
      return rejectBeforeDispatch(err(appError('INVALID_INPUT', 'Native containment identifier is invalid')));
    }
    if (isAborted(signal)) return rejectBeforeDispatch(cancelledStart());
    const executable = await this.executableResolver.resolve(spec.executable);
    if (isAborted(signal)) return rejectBeforeDispatch(cancelledStart());
    if (!executable.ok) return rejectBeforeDispatch(executable);
    const invocation = this.invocationFactory.create(executable.value, spec.args);
    if (!invocation.ok) return rejectBeforeDispatch(invocation);
    if (isAborted(signal)) return rejectBeforeDispatch(cancelledStart());
    let cancellation: Promise<boolean> | undefined;
    const onAbort = (): void => { cancellation ??= this.tryTerminate(record, 'stopped'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const submission = await this.nativeAuthority!.submitProcess({
        binding: record.handle.binding, executable: invocation.value.executable, args: invocation.value.args,
        cwd: spec.cwd, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        environment: createSafeEnvironment(process.env), maximumOutputBytes: MAX_RETAINED_TERMINAL_PROCESS_LOG_BYTES,
        ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!sameNativeBinding(submission.handle.binding, record.handle.binding)) {
        this.markTerminationUnverified(record, 'Native submission identity does not match the owned attempt');
        return err(appError('INTERNAL_ERROR', 'Native submission identity is unverified; do not retry the command'));
      }
      await this.acceptServiceObservation(record, submission.observation);
      if (isAborted(signal)) {
        onAbort();
        await cancellation;
        return cancelledStart();
      }
      if (record.state === 'termination_unverified') {
        return err(appError('INTERNAL_ERROR', 'Native launch outcome is unknown; do not retry the command'));
      }
      if (submission.observation.state === 'launch_not_started') return cancelledStart();
      return ok(this.snapshot(record));
    } catch {
      this.markTerminationUnverified(record, 'Native submission outcome is unknown; reservation retained');
      return err(appError('INTERNAL_ERROR', 'Native process submission could not be verified; do not retry the command'));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async refreshService(record: ServiceManagedRecord): Promise<void> {
    if (isVerifiedTerminal(record.state)) return;
    if (record.refresh !== undefined) return record.refresh;
    const refresh = (async (): Promise<void> => {
      try {
        await this.readServiceOutput(record);
        await this.acceptServiceObservation(record, await record.handle.observe());
      } catch {
        this.markTerminationUnverified(record, 'Native service observation is unavailable; reservation retained');
      }
    })();
    record.refresh = refresh;
    try { await refresh; }
    finally { if (record.refresh === refresh) delete record.refresh; }
  }

  private async acceptServiceObservation(record: ServiceManagedRecord, observation: NativeProcessObservation): Promise<void> {
    if (isVerifiedTerminal(record.state)) return;
    if (!sameNativeBinding(observation.binding, record.handle.binding)) {
      this.markTerminationUnverified(record, 'Native observation identity does not match the owned attempt');
      return;
    }
    switch (observation.state) {
      case 'running':
        record.targetPid = observation.targetPid;
        record.state = 'running';
        delete record.errorMessage;
        record.nativeRecoveryDelay = 250;
        this.scheduleServiceObservation(record);
        return;
      case 'termination_unknown':
        this.markTerminationUnverified(record, 'Native process termination is unverified; reservation retained');
        return;
      case 'launch_not_started':
      case 'terminal_verified':
        await this.acceptNativeReceipt(record, observation);
        return;
    }
  }

  private scheduleServiceObservation(record: ServiceManagedRecord): void {
    if (isVerifiedTerminal(record.state) || record.nativeRecoveryTimer !== undefined) return;
    record.nativeRecoveryTimer = setTimeout(() => {
      delete record.nativeRecoveryTimer;
      void this.refreshService(record);
    }, record.nativeRecoveryDelay ?? 250);
    record.nativeRecoveryTimer.unref();
  }

  private async readServiceOutput(record: ServiceManagedRecord, timeoutMs = 1000): Promise<boolean> {
    if (record.outputFlushed) return record.outputComplete;
    if (record.outputRead !== undefined) return record.outputRead;
    const reading = (async (): Promise<boolean> => {
      const output = await boundedOutputRead(record.handle, record.cursor, timeoutMs);
      if (output === undefined || !sameNativeBinding(output.binding, record.handle.binding) || output.state === 'unavailable') return false;
      record.logs.append('stdout', record.stdoutDecoder.write(output.stdout));
      record.logs.append('stderr', record.stderrDecoder.write(output.stderr));
      record.cursor = output.nextCursor;
      record.outputComplete = output.complete;
      if (output.stdoutTruncated || output.stderrTruncated) record.outputWarning = 'Native process output was truncated by the service retention limit';
      if (output.persistence.state === 'unavailable') record.outputWarning = 'Native process output persistence is unavailable';
      return true;
    })();
    record.outputRead = reading;
    try { return await reading; }
    finally { if (record.outputRead === reading) delete record.outputRead; }
  }

  private async drainServiceOutput(record: ServiceManagedRecord): Promise<void> {
    if (record.outputFlushed) return;
    const deadline = Date.now() + 1000;
    do {
      const available = await this.readServiceOutput(record, Math.max(1, deadline - Date.now()));
      if (!available) { record.outputWarning = 'Native process output is unavailable or could not be read within the final drain deadline'; break; }
      if (record.outputComplete) break;
      if (Date.now() < deadline) await delay(50);
    } while (Date.now() < deadline);
    if (!record.outputComplete) record.outputWarning ??= 'Native process output is incomplete after the final drain deadline';
    record.logs.append('stdout', record.stdoutDecoder.end());
    record.logs.append('stderr', record.stderrDecoder.end());
    record.outputFlushed = true;
    if (record.outputWarning !== undefined) record.logs.append('stderr', `[lnwjud] ${record.outputWarning}\n`);
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
    const logs = record.logs.read(query);
    return ok(record.kind === 'service' && record.outputWarning !== undefined ? { ...logs, truncated: true } : logs);
  }

  public async stop(processId: string, autoRetry = false): Promise<Result<void>> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (record.state !== 'termination_unverified' && isTerminal(record.state)) return ok(undefined);
    const targetState = record.terminationTarget ?? 'stopped';
    let verified = await this.tryTerminate(record, targetState);
    while (!verified && autoRetry && record.kind === 'child' && isChildLive(record.child)) {
      await delay(START_CANCELLATION_RETRY_MS);
      verified = await this.tryTerminate(record, targetState);
    }
    if (!verified) await this.waitForVerifiedTermination(record);
    return ok(undefined);
  }

  private activeProcessCount(): number {
    return [...this.records.values()].filter((record) => (
      record.state === 'starting' || record.state === 'running' || record.state === 'termination_unverified'
    )).length;
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

  private handleError(record: ChildManagedRecord, error: Error & { code?: string }): void {
    if (this.posixGroupInspector !== undefined) {
      record.posixExitState = 'failed';
      void this.acceptPosixCompletion(record);
    } else if (record.stopRequested === undefined && !isTerminal(record.state)) this.finish(record, 'failed');
    if (error.code !== 'ENOENT') record.exitCode = -1;
  }

  private handleClose(record: ChildManagedRecord, exitCode: number | null): void {
    if (this.posixGroupInspector !== undefined) {
      record.posixExitState ??= 'exited';
      if (record.exitCode === undefined && exitCode !== null) record.exitCode = exitCode;
      void this.acceptPosixCompletion(record);
      return;
    }
    if (record.stopRequested === undefined && !isTerminal(record.state)) this.finish(record, 'exited');
    if (record.exitCode === undefined && exitCode !== null) record.exitCode = exitCode;
  }

  private async acceptPosixCompletion(record: ChildManagedRecord): Promise<void> {
    if (isVerifiedTerminal(record.state) || record.nativeAcceptance !== undefined) return record.nativeAcceptance;
    const acceptance = (async (): Promise<void> => {
      const pid = record.child.pid;
      const observation = pid === undefined && record.posixExitState === 'failed'
        ? { state: 'empty' as const }
        : pid === undefined ? { state: 'unknown' as const, reason: 'process_pid_unavailable' } : await this.posixGroupInspector!(pid);
      // An ordinary unreserved observation is not a writer-termination receipt.
      const writerObservation = record.onVerifiedNativeTermination === undefined
        ? observation : classifyPosixGroupCompletion(observation, process.platform);
      if (writerObservation.state !== 'empty') {
        this.markTerminationUnverified(record, 'POSIX process group has live or escaped descendants, or unavailable termination proof');
        return;
      }
      if (pid !== undefined && !record.posixPipesClosed) {
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); record.child.removeListener('close', done); resolve(); };
          const timer = setTimeout(done, 1000);
          record.child.once('close', done);
        });
        if (!record.posixPipesClosed) {
          this.markTerminationUnverified(record, 'POSIX group is empty but inherited output pipes remain open');
          return;
        }
      }
      if (!record.nativeTerminationNotified) {
        try { await record.onVerifiedNativeTermination?.(); record.nativeTerminationNotified = true; }
        catch { this.markTerminationUnverified(record, 'POSIX group is empty but admission release failed'); return; }
      }
      this.finish(record, record.terminationTarget ?? record.posixExitState ?? 'exited');
    })();
    record.nativeAcceptance = acceptance;
    try { await acceptance; }
    catch { this.markTerminationUnverified(record, 'POSIX process group observation failed'); }
    finally { if (record.nativeAcceptance === acceptance) delete record.nativeAcceptance; }
  }

  private async acceptNativeReceipt(record: ServiceManagedRecord, receipt: Extract<NativeProcessObservation, { state: 'terminal_verified' | 'launch_not_started' }>): Promise<void> {
    if (record.nativeAcceptance !== undefined) return record.nativeAcceptance;
    const acceptance = (async (): Promise<void> => {
      if (receipt.state === 'terminal_verified') await this.drainServiceOutput(record);
      if (!record.nativeTerminationNotified) {
        try { await record.onVerifiedNativeTermination?.(); record.nativeTerminationNotified = true; }
        catch { this.markTerminationUnverified(record, 'Native proof is valid but durable terminal readback or admission release failed'); return; }
      }
      if (receipt.state === 'launch_not_started') {
        this.finish(record, 'stopped');
        return;
      }
      record.exitCode = receipt.exitCode;
      if (!isVerifiedTerminal(record.state)) {
        const state = receipt.outcome === 'timed_out'
          ? 'timed_out'
          : receipt.outcome === 'cancelled'
            ? 'stopped' : receipt.exitCode === 0 ? 'exited' : 'failed';
        this.finish(record, state);
      }
    })();
    record.nativeAcceptance = acceptance;
    try { await acceptance; } finally { if (record.nativeAcceptance === acceptance) delete record.nativeAcceptance; }
  }

  private async timeout(record: ChildManagedRecord): Promise<void> {
    if ((record.state !== 'running' && !(this.posixGroupInspector !== undefined && record.state === 'termination_unverified')) || record.stopRequested !== undefined) return;
    await this.tryTerminate(record, 'timed_out');
  }

  private async tryTerminate(record: ManagedRecord, targetState: 'stopped' | 'timed_out'): Promise<boolean> {
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

  private async performTermination(record: ManagedRecord, targetState: 'stopped' | 'timed_out'): Promise<boolean> {
    record.terminationTarget = targetState;
    record.stopRequested = targetState;
    if (record.kind === 'service') {
      try {
        const aborted = await record.handle.abortBeforeDispatch();
        if (sameNativeBinding(aborted.binding, record.handle.binding) && (aborted.state === 'launch_not_started' || aborted.state === 'terminal_verified')) {
          await this.acceptServiceObservation(record, aborted);
        } else {
          await this.acceptServiceObservation(record, await record.handle.cancel());
        }
        return isVerifiedTerminal(record.state);
      } catch {
        this.markTerminationUnverified(record, 'Native Job Object cancellation could not be verified');
      }
      return false;
    }
    if (record.timer !== undefined) clearTimeout(record.timer);
    const pid = record.child.pid;
    if (pid === undefined) {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Timed-out process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
    try {
      await this.terminator.stop(record.child, pid);
      if (this.posixGroupInspector !== undefined) {
        await this.acceptPosixCompletion(record);
        return isVerifiedTerminal(record.state);
      }
      this.finish(record, targetState);
      return true;
    } catch {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Timed-out process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
  }

  private finish(record: ManagedRecord, state: ManagedProcessState): void {
    record.state = state;
    delete record.stopRequested;
    delete record.errorMessage;
    if (record.kind === 'service' && record.outputWarning !== undefined) record.errorMessage = record.outputWarning;
    delete record.terminationTarget;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
    if (record.nativeRecoveryTimer !== undefined) { clearTimeout(record.nativeRecoveryTimer); delete record.nativeRecoveryTimer; }
    record.resolveTerminationVerified?.();
    delete record.resolveTerminationVerified;
    delete record.terminationVerified;
    record.logs.compact(MAX_RETAINED_TERMINAL_PROCESS_LOG_BYTES);
    this.records.delete(record.processId);
    this.records.set(record.processId, record);
    this.pruneTerminalRecords();
  }

  private pruneTerminalRecords(): void {
    let terminalCount = [...this.records.values()].filter((record) => isVerifiedTerminal(record.state)).length;
    if (terminalCount <= DEFAULT_MAX_RETAINED_TERMINAL_PROCESSES) return;
    for (const [processId, record] of this.records) {
      if (!isVerifiedTerminal(record.state)) continue;
      this.records.delete(processId);
      terminalCount -= 1;
      if (terminalCount <= DEFAULT_MAX_RETAINED_TERMINAL_PROCESSES) return;
    }
  }

  private markTerminationUnverified(record: ManagedRecord, errorMessage: string): void {
    if (isVerifiedTerminal(record.state)) return;
    record.state = 'termination_unverified';
    record.errorMessage = errorMessage;
    delete record.finishedAt;
    if (record.timer !== undefined && this.posixGroupInspector === undefined) clearTimeout(record.timer);
    if (record.terminationVerified === undefined) {
      record.terminationVerified = new Promise<void>((resolve) => { record.resolveTerminationVerified = resolve; });
    }
    if ((record.kind === 'service' || this.posixGroupInspector !== undefined) && record.nativeRecoveryTimer === undefined) {
      const recoveryDelay = record.nativeRecoveryDelay ?? 250;
      record.nativeRecoveryDelay = Math.min(recoveryDelay * 2, 5000);
      record.nativeRecoveryTimer = setTimeout(() => {
        delete record.nativeRecoveryTimer;
        void (record.kind === 'child' ? this.acceptPosixCompletion(record) : this.refreshService(record))
          .catch(() => this.markTerminationUnverified(record, errorMessage));
      }, recoveryDelay);
      record.nativeRecoveryTimer.unref();
    }
  }

  private waitForVerifiedTermination(record: ManagedRecord): Promise<void> {
    if (isVerifiedTerminal(record.state)) return Promise.resolve();
    if (record.terminationVerified === undefined) {
      record.terminationVerified = new Promise<void>((resolve) => { record.resolveTerminationVerified = resolve; });
    }
    return record.terminationVerified;
  }

  private snapshot(record: ManagedRecord): ManagedProcess {
    const pid = record.kind === 'child' ? record.child.pid : record.targetPid;
    return {
      processId: record.processId,
      ...(pid !== undefined && (record.state === 'starting' || record.state === 'running') ? { pid } : {}),
      executable: record.spec.executable,
      args: [...record.spec.args],
      cwd: record.spec.cwd,
      state: record.state,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
    };
  }
}

function isTerminal(state: ManagedProcessState): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out' || state === 'termination_unverified';
}

function isVerifiedTerminal(state: ManagedProcessState): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out';
}

function cancelledStart(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Process start was cancelled before launch completed', true));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isChildLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function sameNativeBinding(left: NativeAttemptBinding, right: NativeAttemptBinding): boolean {
  return left.taskId === right.taskId && left.reservationId === right.reservationId && left.attemptId === right.attemptId
    && left.generation === right.generation && left.requestDigest === right.requestDigest && left.ownerClientId === right.ownerClientId
    && left.ownerSessionId === right.ownerSessionId && left.workspaceId === right.workspaceId;
}

async function boundedOutputRead(handle: NativeAttemptHandle, cursor: NativeOutputCursor, timeoutMs: number): Promise<NativeOutputRead | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.readOutput(cursor).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}


function createSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'HOME', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    // Preserve non-secret POSIX desktop-session handles for UI processes.
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PULSE_SERVER', 'PIPEWIRE_REMOTE', 'AT_SPI_BUS_ADDRESS',
    'GDK_BACKEND', 'QT_QPA_PLATFORM',
  ].map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
    return allowed.has(normalizedKey) && value !== undefined;
  }));
}
