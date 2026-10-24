import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPosixProcessGroup, PosixProcessTree, parseNativeAttemptBinding, type PosixProcessGroupInspector, type NativeAttemptBinding, type WindowsNativeAuthority, type WindowsNativeAuthorityConfiguration } from '@lnwjud/process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appError, err, ok, type GoalTaskCancellationObservation, type Result } from '@lnwjud/domain';
import {
  DurableShellTaskIndex,
  type ActiveTaskInspection,
  type DurableMutationKind,
  type DurableTaskLaunchRecord,
  type DurableTaskReservation,
  type WriterAdmissionDiagnostics,
} from './durable-shell-task-index.js';
import { capabilityTaskOwnerCanInspect, capabilityTaskOwnerCanRecover, legacyCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';
import { createHostPosixProcessRuntime } from './host-native-authority.js';

export type DurableShellTaskState = 'starting' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified';

export interface DurableShellLaunchRequest {
  /** Trusted internal classification; never taken from generic shell inputs. */
  readonly mutationKind?: DurableMutationKind;
  readonly taskId: string;
  readonly commandFingerprint?: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly windowsVerbatimArguments?: boolean;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly owner: CapabilityTaskOwner;
}

interface DurableTaskMetadata {
  readonly containment?: 'windows_job_v1' | 'windows_job_v2' | 'posix_group_v1';
  posix_launch_not_started?: boolean;
  posix_stop_target?: 'cancelled' | 'timed_out';
  readonly containmentBinding?: NativeAttemptBinding;
  readonly version: 1 | 2;
  readonly task_id: string;
  readonly command_fingerprint?: string;
  readonly request_digest?: string;
  state: DurableShellTaskState;
  readonly started_at: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
  readonly include_stdout: boolean;
  readonly include_stderr: boolean;
  readonly max_output_bytes: number;
  readonly deadline_at: string;
  worker_pid?: number;
  worker_started_at?: string;
  child_pid?: number;
  child_started_at?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  output_finalized?: boolean;
  readonly owner_client_id?: string;
  readonly owner_session_id?: string;
  readonly owner_workspace_id?: string;
}

type GoalTaskProjection =
  | { readonly kind: 'legacy_unverified'; readonly metadata: DurableTaskMetadata; readonly reason: string }
  | { readonly kind: 'reconciled'; readonly metadata: DurableTaskMetadata };

interface DurableWorkerSpec {
  readonly posix?: { readonly moduleUrl: string; readonly sha256: string; readonly cancelPath: string };
  readonly native?: {
    readonly configuration: WindowsNativeAuthorityConfiguration;
    readonly binding: NativeAttemptBinding;
    readonly directory: string;
    readonly moduleUrl: string;
  };
  readonly version: 1;
  readonly taskId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly windowsVerbatimArguments?: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly metadataPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly requestDigest: string;
  readonly activeMarkerPath: string;
  readonly electronRunAsNode?: boolean;
}

const METADATA_FILENAME = 'task.json';
const STDOUT_FILENAME = 'stdout.log';
const STDERR_FILENAME = 'stderr.log';
const MAX_GOAL_EVIDENCE_STDOUT_BYTES = 256 * 1024;
const SPEC_FILENAME = 'spec.json';
const WORKER_PID_FILENAME = 'worker.pid';
const WORKER_STARTED_FILENAME = 'worker.started';
const METADATA_READ_RETRIES = 4;
const PROCESS_EXIT_RECONCILE_DELAY_MS = 75;
const PROCESS_EXIT_FINALIZATION_GRACE_MS = 1_000;
const PROCESS_HANDLE_RELEASE_GRACE_MS = 150;
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 5_000;
// Host process identity probes start a second PowerShell/`ps` process. Under
// a busy desktop test run that probe can be delayed even though the durable
// worker is healthy. Keep the startup window finite (so a genuinely
// unverifiable long-lived process still fails closed) but wide enough not to
// turn normal short-lived tasks into false `termination_unverified` results.
const PROCESS_IDENTITY_CAPTURE_GRACE_MS = 10_000;
const execFileAsync = promisify(execFile);

function repositoryImportBootstrapEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'SystemDrive', 'PROCESSOR_ARCHITECTURE']) {
    const value = process.env[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

export interface DurableShellTaskStoreOptions {
  readonly maxConcurrentTasks?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsNativeAuthority?: WindowsNativeAuthority;
  readonly posixProcessRuntime?: { readonly modulePath: string; readonly sha256: string };
  readonly posixGroupInspector?: PosixProcessGroupInspector;
}

export const DEFAULT_MAX_CONCURRENT_DURABLE_TASKS = 16;

export class DurableShellTaskStore {
  private readonly maxConcurrentTasks: number;
  private readonly platform: NodeJS.Platform;
  private readonly activeIndex: DurableShellTaskIndex;
  private readonly windowsNativeAuthority: WindowsNativeAuthority | undefined;
  private readonly posixProcessRuntime: { readonly modulePath: string; readonly sha256: string };
  private readonly posixGroupInspector: PosixProcessGroupInspector;

  public constructor(private readonly rootDirectory: string, options: DurableShellTaskStoreOptions = {}) {
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(options.maxConcurrentTasks);
    this.platform = options.platform ?? process.platform;
    this.windowsNativeAuthority = options.windowsNativeAuthority;
    this.posixProcessRuntime = options.posixProcessRuntime ?? createHostPosixProcessRuntime();
    this.posixGroupInspector = options.posixGroupInspector ?? inspectPosixProcessGroup;
    this.activeIndex = new DurableShellTaskIndex(rootDirectory, {
      maxConcurrentTasks: this.maxConcurrentTasks,
      inspectTask: async (taskId): Promise<ActiveTaskInspection> => this.inspectTaskForIndex(taskId),
      loadLaunchRecord: async (taskId): Promise<DurableTaskLaunchRecord | undefined> => this.loadLaunchRecord(taskId),
      verifyContainedTermination: (reservation): Promise<boolean> => this.verifyNativeReservation(reservation),
    });
  }

  public launch(request: DurableShellLaunchRequest): Promise<Result<Record<string, unknown>>> {
    return this.launchWithDigest(request, durableShellRequestDigest(request), 'session');
  }

  /** Trusted deterministic launch used only after the shell backend verifies the canonical automation digest. */
  public launchReserved(request: DurableShellLaunchRequest, requestDigest: string): Promise<Result<Record<string, unknown>>> {
    if (!/^[a-f0-9]{64}$/i.test(requestDigest)) {
      return Promise.resolve(err(appError('INVALID_INPUT', 'Reserved durable task digest is invalid')));
    }
    return this.launchWithDigest(request, requestDigest.toLowerCase(), 'automation');
  }

  private async launchWithDigest(
    request: DurableShellLaunchRequest,
    requestDigest: string,
    ownership: 'session' | 'automation',
  ): Promise<Result<Record<string, unknown>>> {
    if (!isSafeTaskId(request.taskId)) return err(appError('INVALID_INPUT', 'Durable task ID is invalid'));
    const existing = await this.readMetadata(request.taskId, false, 1);
    if (existing.ok) {
      const storedOwner = metadataOwner(existing.value);
      if (storedOwner.clientId !== request.owner.clientId || storedOwner.workspaceId !== request.owner.workspaceId
        || ownership === 'session' && storedOwner.sessionId !== request.owner.sessionId) {
        return err(appError('PERMISSION_DENIED', 'Durable task is not owned by this launch requester'));
      }
      if (existing.value.request_digest !== requestDigest) {
        return err(appError('CONFLICT', 'Durable task ID is already used by another request', true));
      }
      const reconciled = await this.reconcile(existing.value);
      await this.releaseTerminalReservation(reconciled);
      return ok(await this.snapshotFromMetadata(reconciled));
    }

    // macOS process-group cleanup is not a kernel-owned all-descendants fence.
    // A new opaque command cannot be safely accepted until native containment exists.
    if (this.platform === 'darwin') {
      return err(appError('CONFLICT', 'macOS durable shell unavailable: escaped descendants cannot be kernel-contained'));
    }
    if (this.platform === 'win32' && this.windowsNativeAuthority === undefined) {
      return err(appError('INTERNAL_ERROR', 'Trusted Windows native containment is unavailable; repair the installed helper before launching work', true));
    }
    if (this.platform !== 'win32') {
      try {
        const runtime = await readFile(this.posixProcessRuntime.modulePath);
        if (!path.isAbsolute(this.posixProcessRuntime.modulePath)
          || createHash('sha256').update(runtime).digest('hex') !== this.posixProcessRuntime.sha256) throw new Error('POSIX_RUNTIME_INTEGRITY');
      } catch {
        return err(appError('INTERNAL_ERROR', 'Trusted POSIX process runtime is unavailable; repair the installed runtime before launching work', true));
      }
    }
    const taskDirectory = this.taskDirectory(request.taskId);
    let nativeBinding: NativeAttemptBinding | undefined;
    try {
      nativeBinding = this.platform === 'win32' ? durableShellNativeBinding(request, requestDigest) : undefined;
    } catch {
      return err(appError('INVALID_INPUT', 'Native containment requires a registered workspace identity'));
    }
    const startedAt = new Date().toISOString();
    const reservation = await this.activeIndex.reserve({
      mutationKind: request.mutationKind ?? 'opaque',
      taskId: request.taskId,
      requestDigest,
      ownerClientId: request.owner.clientId,
      ...(nativeBinding === undefined ? {} : { nativeBinding, nativeReceiptPath: path.join(taskDirectory, 'containment.receipt.json') }),
      ...(request.owner.workspaceId === undefined ? {} : { ownerWorkspaceId: request.owner.workspaceId }),
      launchRecord: {
        version: 1,
        taskId: request.taskId,
        startedAt,
        ownerClientId: request.owner.clientId,
        ownerSessionId: request.owner.sessionId,
        ...(request.owner.workspaceId === undefined ? {} : { ownerWorkspaceId: request.owner.workspaceId }),
      },
    });
    if (!reservation.ok) return reservation;
    if (!reservation.value.created) {
      const concurrent = await this.readMetadata(request.taskId);
      if (concurrent.ok && concurrent.value.request_digest === requestDigest) {
        const storedOwner = metadataOwner(concurrent.value);
        if (storedOwner.clientId !== request.owner.clientId || storedOwner.workspaceId !== request.owner.workspaceId
          || ownership === 'session' && storedOwner.sessionId !== request.owner.sessionId) {
          return err(appError('PERMISSION_DENIED', 'Durable task is not owned by this launch requester'));
        }
        const reconciled = await this.reconcile(concurrent.value);
        await this.releaseTerminalReservation(reconciled);
        return ok(await this.snapshotFromMetadata(reconciled));
      }
      return err(appError('CONFLICT', 'Durable task launch is already in progress', true));
    }

    let workerOwnsReservation = false;
    const deadlineAt = new Date(Date.now() + request.timeoutSeconds * 1000).toISOString();
    const metadataPath = path.join(taskDirectory, METADATA_FILENAME);
    const stdoutPath = path.join(taskDirectory, STDOUT_FILENAME);
    const stderrPath = path.join(taskDirectory, STDERR_FILENAME);
    const specPath = path.join(taskDirectory, SPEC_FILENAME);
    const metadata: DurableTaskMetadata = {
      ...(this.platform === 'win32' ? {} : { containment: 'posix_group_v1' as const }),
      ...(nativeBinding === undefined ? {} : { containment: 'windows_job_v2' as const, containmentBinding: nativeBinding }),
      version: 2,
      task_id: request.taskId,
      ...(request.commandFingerprint === undefined ? {} : { command_fingerprint: request.commandFingerprint }),
      request_digest: requestDigest,
      state: nativeBinding === undefined ? 'running' : 'starting',
      started_at: startedAt,
      include_stdout: request.includeStdout,
      include_stderr: request.includeStderr,
      max_output_bytes: request.maxOutputBytes,
      deadline_at: deadlineAt,
      owner_client_id: request.owner.clientId,
      owner_session_id: request.owner.sessionId,
      ...(request.owner.workspaceId === undefined ? {} : { owner_workspace_id: request.owner.workspaceId }),
    };
    const spec: DurableWorkerSpec = {
      ...(this.platform === 'win32' ? {} : { posix: {
        moduleUrl: pathToFileURL(this.posixProcessRuntime.modulePath).href,
        sha256: this.posixProcessRuntime.sha256,
        cancelPath: path.join(taskDirectory, 'posix.cancel'),
      } }),
      version: 1,
      taskId: request.taskId,
      executable: request.executable,
      arguments: [...request.arguments],
      cwd: request.cwd,
      ...(request.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: request.windowsVerbatimArguments }),
      timeoutMs: request.timeoutSeconds * 1000,
      maxOutputBytes: request.maxOutputBytes,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      startedAt,
      deadlineAt,
      metadataPath,
      stdoutPath,
      stderrPath,
      requestDigest,
      activeMarkerPath: reservation.value.markerPath,
      ...(request.mutationKind === 'repository_import' ? { electronRunAsNode: true } : {}),
      ...(nativeBinding === undefined || this.windowsNativeAuthority === undefined ? {} : {
        native: {
          configuration: this.windowsNativeAuthority.configuration,
          binding: nativeBinding,
          directory: taskDirectory,
          moduleUrl: pathToFileURL(this.windowsNativeAuthority.configuration.workerModulePath
            ?? fileURLToPath(new URL('../../process/dist/index.js', import.meta.url))).href,
        },
      }),
    };
    try {
      await mkdir(taskDirectory, { recursive: true });
      await mkdir(this.rootDirectory, { recursive: true });
      await writeMetadataAtomically(metadataPath, metadata);
      await writeFile(specPath, JSON.stringify(spec), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const workerPath = await this.ensureWorkerScript();
      const worker = spawn(process.execPath, [workerPath, specPath], {
        // The durable worker only coordinates the real child process; it does not need
        // the workspace as its own cwd. Keeping the worker outside the workspace avoids
        // a transient Windows directory lock after the child has already completed.
        cwd: path.dirname(process.execPath),
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        env: request.mutationKind === 'repository_import'
          ? { ...repositoryImportBootstrapEnvironment(), ELECTRON_RUN_AS_NODE: '1' }
          : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      await waitForSpawn(worker);
      if (worker.pid === undefined) throw new Error('Durable task worker did not return a process ID');
      workerOwnsReservation = true;
      metadata.worker_pid = worker.pid;
      // Capture the launcher identity without delaying a short-lived task's
      // return path. The worker owns task.json, so the identity is published
      // separately when the bounded host probe completes.
      void probeProcessIdentity(worker.pid, this.platform).then(async (workerIdentity) => {
        if (workerIdentity.state === 'live') {
          await writeFile(path.join(taskDirectory, WORKER_STARTED_FILENAME), workerIdentity.processStartedAt, 'utf8').catch(() => undefined);
        }
      }).catch(() => undefined);
      // Publish the worker identity on its own file before returning the task handle.
      // The worker owns task.json; keeping launcher identity separate avoids a race
      // where a very fast completion can be overwritten back to running.
      await writeFile(path.join(taskDirectory, WORKER_PID_FILENAME), String(worker.pid), 'utf8').catch(() => undefined);
      worker.unref();
      return ok(await this.snapshotFromMetadata(metadata));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Durable task could not start';
      metadata.state = 'failed';
      metadata.exit_code = -1;
      metadata.error = `Durable task could not start: ${message}`;
      metadata.finished_at = new Date().toISOString();
      if (this.platform !== 'win32' && !workerOwnsReservation) metadata.posix_launch_not_started = true;
      if (!workerOwnsReservation && nativeBinding !== undefined && this.windowsNativeAuthority !== undefined) {
        await this.windowsNativeAuthority.abortBeforeLaunch({ directory: taskDirectory, binding: nativeBinding }).catch(() => undefined);
      }
      await writeMetadataAtomically(metadataPath, metadata).catch(() => undefined);
      if (!workerOwnsReservation) await this.activeIndex.release(request.taskId, requestDigest);
      return err(appError('INTERNAL_ERROR', 'Durable task could not start', true));
    }
  }

  public admissionDiagnostics(): Promise<WriterAdmissionDiagnostics> {
    return this.activeIndex.diagnostics();
  }

  public async list(owner?: CapabilityTaskOwner): Promise<Record<string, unknown>[]> {
    await mkdir(this.rootDirectory, { recursive: true });
    const taskIds = (await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && entry.name !== '.index')
      .map((entry) => entry.name);
    const hydrated = await mapWithConcurrency(taskIds, 16, async (taskId) => {
      const metadata = await this.readMetadata(taskId);
      if (!metadata.ok) return undefined;
      if (owner !== undefined && !capabilityTaskOwnerCanInspect(metadataOwner(metadata.value), owner)) return undefined;
      const reconciled = await this.reconcile(metadata.value);
      await this.releaseTerminalReservation(reconciled);
      return this.snapshotFromMetadata(reconciled, undefined, false);
    });
    const snapshots = hydrated.filter((snapshot): snapshot is Record<string, unknown> => snapshot !== undefined);
    return snapshots.sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')));
  }

  public async listPage(
    owner: CapabilityTaskOwner,
    limit: number,
    cursor?: string,
  ): Promise<Result<{ readonly tasks: readonly Record<string, unknown>[]; readonly nextCursor?: string }>> {
    const page = await this.activeIndex.listLaunches({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      accept: (record) => capabilityTaskOwnerCanInspect(launchRecordOwner(record), owner),
    });
    if (!page.ok) return page;
    const hydrated = await mapWithConcurrency(page.value.records, 16, async (record) => {
      const metadata = await this.readMetadata(record.taskId);
      if (!metadata.ok || !capabilityTaskOwnerCanInspect(metadataOwner(metadata.value), owner)) return undefined;
      const reconciled = await this.reconcile(metadata.value);
      await this.releaseTerminalReservation(reconciled);
      return this.snapshotFromMetadata(reconciled, undefined, false);
    });
    const tasks = hydrated.filter((snapshot): snapshot is Record<string, unknown> => snapshot !== undefined);
    return ok({ tasks, ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }) });
  }

  public async snapshot(taskId: string, tailLines?: number, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (owner !== undefined && !capabilityTaskOwnerCanInspect(metadataOwner(metadata.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    const reconciled = await this.reconcile(metadata.value);
    await this.releaseTerminalReservation(reconciled);
    return ok(await this.snapshotFromMetadata(reconciled, tailLines));
  }

  /** Trusted read-only host probe scoped to the durable goal's workspace. */
  public async isOwnedGoalTask(clientId: string, workspaceId: string, taskId: string): Promise<boolean> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return false;
    const owner = metadataOwner(metadata.value);
    return owner.clientId === clientId && owner.workspaceId === workspaceId;
  }

  public async snapshotForGoalLiveness(taskId: string, workspaceId: string): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (metadataOwner(metadata.value).workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Task belongs to another or unknown workspace'));
    }
    const { metadata: reconciled } = projectTaskForGoal(await this.reconcile(metadata.value));
    await this.releaseTerminalReservation(reconciled);
    // Goal liveness/resource probes need identity and state, not entire retained
    // stdout/stderr. Avoid rereading large logs on each 15-second sample.
    return ok({ ...await this.snapshotFromMetadata(reconciled, undefined, false), ...(reconciled.command_fingerprint === undefined ? {} : { command_fingerprint: reconciled.command_fingerprint }) });
  }

  /** Explicit bounded proof for a successfully completed task, never used during liveness polling. */
  public async snapshotForGoalEvidence(taskId: string, workspaceId: string): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (metadataOwner(metadata.value).workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Task belongs to another or unknown workspace'));
    }
    const projection = projectTaskForGoal(await this.reconcile(metadata.value));
    if (projection.kind === 'legacy_unverified') return err(appError('INVALID_INPUT', projection.reason));
    const reconciled = projection.metadata;
    await this.releaseTerminalReservation(reconciled);
    if (reconciled.state !== 'completed' || reconciled.exit_code !== 0 || !reconciled.include_stdout || reconciled.stdout_truncated === true
      || (reconciled.containment === 'windows_job_v2' && reconciled.output_finalized !== true)) {
      return err(appError('INVALID_INPUT', 'Engineering evidence requires complete stdout from a successful terminal task'));
    }
    const filename = path.join(this.taskDirectory(taskId), STDOUT_FILENAME);
    let size: number;
    try {
      const handle = await open(filename, 'r');
      try { size = (await handle.stat()).size; } finally { await handle.close(); }
    } catch {
      return err(appError('INVALID_INPUT', 'Engineering evidence stdout is unavailable'));
    }
    if (size <= 0 || size > MAX_GOAL_EVIDENCE_STDOUT_BYTES) {
      return err(appError('INVALID_INPUT', 'Engineering evidence stdout exceeds the bounded proof limit'));
    }
    const stdout = await readBoundedText(filename, MAX_GOAL_EVIDENCE_STDOUT_BYTES);
    if (stdout.length === 0) return err(appError('INVALID_INPUT', 'Engineering evidence stdout is unavailable'));
    return ok({
      ...await this.snapshotFromMetadata(reconciled, undefined, false),
      stdout,
      ...(reconciled.command_fingerprint === undefined ? {} : { command_fingerprint: reconciled.command_fingerprint }),
    });
  }

  /** Trusted exact lookup for a reserved automation task. Legacy/no-digest rows fail closed. */
  public async snapshotForAutomation(
    taskId: string,
    ownerClientId: string,
    workspaceId: string,
    requestDigest: string,
  ): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    const owner = metadataOwner(metadata.value);
    if (owner.clientId !== ownerClientId || owner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Task belongs to another client or workspace'));
    }
    if (metadata.value.request_digest === undefined || metadata.value.request_digest !== requestDigest.toLowerCase()) {
      return err(appError('CONFLICT', 'Durable task identity does not match the reserved automation request', true));
    }
    const reconciled = await this.reconcile(metadata.value);
    await this.releaseTerminalReservation(reconciled);
    return ok(await this.snapshotFromMetadata(reconciled));
  }

  /** Trusted cancellation path used by durable goals; it deliberately ignores the transient MCP session. */
  public async cancelForGoal(
    taskId: string,
    ownerClientId: string,
    workspaceId: string,
  ): Promise<Result<GoalTaskCancellationObservation>> {
    const metadataResult = await this.readMetadata(taskId);
    if (!metadataResult.ok) return metadataResult;
    const storedOwner = metadataOwner(metadataResult.value);
    if (storedOwner.clientId !== ownerClientId || storedOwner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Task belongs to another client or workspace'));
    }

    const projection = projectTaskForGoal(await this.reconcile(metadataResult.value));
    if (projection.kind === 'legacy_unverified') {
      return ok({ matched: true, state: 'termination_unverified', detail: projection.reason });
    }
    const before = projection.metadata;
    if (isTerminal(before.state)) {
      await this.releaseTerminalReservation(before);
      return ok({ matched: true, state: 'already_terminal', detail: before.state });
    }
    const cancelled = await this.cancel(taskId, storedOwner);
    if (!cancelled.ok) return cancelled;
    const state = cancelled.value.state;
    if (state === 'cancelled') return ok({ matched: true, state: 'cancelled' });
    if (isTerminalValue(state)) return ok({ matched: true, state: 'already_terminal', detail: state });
    return ok({ matched: true, state: 'termination_unverified', detail: typeof state === 'string' ? state : 'unknown' });
  }

  public async wait(taskId: string, seconds: number, tailLines?: number, owner?: CapabilityTaskOwner, refreshTerminalAfterDeadline = true): Promise<Result<Record<string, unknown>>> {
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    let snapshot = await this.snapshot(taskId, tailLines, owner);
    // A live POSIX worker may report unverified while descendants are still
    // draining; it must be polled, never mistaken for an authoritative terminal.
    while (snapshot.ok && (isExecutingState(snapshot.value.state) || snapshot.value.state === 'termination_unverified') && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(10, deadline - Date.now())));
      snapshot = await this.snapshot(taskId, tailLines, owner);
    }
    if (!snapshot.ok || !(isExecutingState(snapshot.value.state) || snapshot.value.state === 'termination_unverified') || !refreshTerminalAfterDeadline) return snapshot;

    // A slow host liveness probe can consume the wait budget after reading a
    // running snapshot while the worker persists its terminal state. Refresh
    // task.json once without another process probe so wait returns the latest
    // durable result instead of a stale running state.
    const latest = await this.readMetadata(taskId);
    if (!latest.ok || !isTerminal(latest.value.state)) return snapshot;
    if (owner !== undefined && !capabilityTaskOwnerCanInspect(metadataOwner(latest.value), owner)) return snapshot;
    const reconciled = await this.reconcile(latest.value);
    await this.releaseTerminalReservation(reconciled);
    return ok(await this.snapshotFromMetadata(reconciled, tailLines));
  }

  public async cancel(taskId: string, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadataResult = await this.readMetadata(taskId);
    if (!metadataResult.ok) return metadataResult;
    if (owner !== undefined && !capabilityTaskOwnerCanRecover(metadataOwner(metadataResult.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    let metadata = await this.reconcile(metadataResult.value);
    if (metadata.containment === undefined) {
      return ok(await this.snapshotFromMetadata({ ...metadata, state: 'termination_unverified',
        error: 'Legacy task has no authenticated containment proof; cancellation cannot prove descendant termination' }));
    }
    if (isTerminal(metadata.state)) {
      await this.releaseTerminalReservation(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    if (metadata.containment === 'posix_group_v1') return this.cancelPosix(metadata);
    if (metadata.containment === 'windows_job_v2') {
      if (this.windowsNativeAuthority === undefined || metadata.containmentBinding === undefined) {
        return ok(await this.snapshotFromMetadata({ ...metadata, state: 'termination_unverified', error: 'Native cancellation authority is unavailable' }));
      }
      await this.windowsNativeAuthority.cancel({ directory: this.taskDirectory(taskId), binding: metadata.containmentBinding });
      const deadline = Date.now() + 2_000;
      do {
        const current = await this.readMetadata(taskId);
        if (current.ok) metadata = await this.reconcile(current.value);
        if (isTerminal(metadata.state)) break;
        await delay(40);
      } while (Date.now() < deadline);
      await this.releaseTerminalReservation(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    if (metadata.containment === 'windows_job_v1') {
      await writeFile(path.join(this.taskDirectory(taskId), 'containment.cancel'), 'cancel', { mode: 0o600 });
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const latest = await this.readMetadata(taskId);
        if (latest.ok && isTerminal(latest.value.state)) return this.snapshot(taskId, undefined, owner);
        await delay(100);
      }
      return ok(await this.snapshotFromMetadata({ ...metadata, state: 'termination_unverified', error: 'Native containment cancellation has no verified terminal receipt' }));
    }
    metadata = await this.hydrateProcessIdentities(metadata);
    const workerProbe = metadata.worker_pid === undefined
      ? { state: 'gone' as const }
      : await probeProcessIdentity(metadata.worker_pid, this.platform);
    const childProbe = metadata.child_pid === undefined
      ? { state: 'gone' as const }
      : await probeProcessIdentity(metadata.child_pid, this.platform);
    const workerRunning = isTrackedProcessLive(workerProbe, metadata.worker_started_at);
    const childRunning = isTrackedProcessLive(childProbe, metadata.child_started_at);
    // POSIX workers and their children own separate detached process groups.
    // Stop the real child first and keep the worker alive to reap it, flush
    // output and exit. The termination verifier still requires both PIDs gone.
    // Windows taskkill /T instead needs the worker root to traverse its child.
    const terminationPid = this.platform !== 'win32' && childRunning
      ? metadata.child_pid
      : workerRunning ? metadata.worker_pid : (childRunning ? metadata.child_pid : undefined);
    if (terminationPid === undefined) {
      metadata.state = 'termination_unverified';
      metadata.error = 'Durable task process PID is unavailable; process termination could not be verified';
      delete metadata.finished_at;
      await this.writeMetadata(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    const relatedPids = [metadata.worker_pid, metadata.child_pid]
      .filter((pid): pid is number => pid !== undefined && pid !== terminationPid);
    const identities = new Map<number, string>();
    if (metadata.worker_pid !== undefined && metadata.worker_started_at !== undefined) identities.set(metadata.worker_pid, metadata.worker_started_at);
    if (metadata.child_pid !== undefined && metadata.child_started_at !== undefined) identities.set(metadata.child_pid, metadata.child_started_at);
    const stopped = await stopProcessTree(terminationPid, relatedPids, this.platform, identities);
    if (!stopped) {
      metadata.state = 'termination_unverified';
      metadata.error = 'Durable task process termination could not be verified';
      delete metadata.finished_at;
      await this.writeMetadata(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    metadata.state = 'cancelled';
    metadata.exit_code = -1;
    delete metadata.error;
    metadata.finished_at = new Date().toISOString();
    await this.writeMetadata(metadata);
    await this.releaseTerminalReservation(metadata);
    return ok(await this.snapshotFromMetadata(metadata));
  }

  public async has(taskId: string): Promise<boolean> {
    return (await this.readMetadata(taskId)).ok;
  }

  /** Shared writer admission inspects durable shell liveness without acquiring the index lock again. */
  public async inspectForWriterAdmission(taskId: string): Promise<ActiveTaskInspection> {
    return this.inspectTaskForIndex(taskId);
  }

  private async inspectTaskForIndex(taskId: string): Promise<ActiveTaskInspection> {
    const metadata = await this.readMetadata(taskId, false, 1);
    if (!metadata.ok) {
      try {
        const handle = await open(path.join(this.taskDirectory(taskId), METADATA_FILENAME), 'r');
        await handle.close();
        return 'unknown';
      } catch (error: unknown) {
        return isFileNotFound(error) ? 'missing' : 'unknown';
      }
    }
    if (metadata.value.containment === undefined) return 'unknown';
    const reconciled = await this.reconcile(metadata.value);
    if (isTerminal(reconciled.state)) {
      if (reconciled.containment === 'windows_job_v2' && !await this.verifyNativeReservation({
        taskId, requestDigest: reconciled.request_digest ?? '', ownerClientId: reconciled.owner_client_id ?? '',
        ...(reconciled.owner_workspace_id === undefined ? {} : { ownerWorkspaceId: reconciled.owner_workspace_id }),
        ...(reconciled.containmentBinding === undefined ? {} : { nativeBinding: reconciled.containmentBinding }),
      })) return 'unknown';
      return 'terminal';
    }
    return isExecutingState(reconciled.state) ? 'active' : 'unknown';
  }

  private async loadLaunchRecord(taskId: string): Promise<DurableTaskLaunchRecord | undefined> {
    const metadata = await this.readMetadata(taskId, false, 1);
    return metadata.ok ? this.launchRecord(metadata.value) : undefined;
  }

  private launchRecord(metadata: DurableTaskMetadata): DurableTaskLaunchRecord {
    const owner = metadataOwner(metadata);
    return {
      version: 1,
      taskId: metadata.task_id,
      startedAt: metadata.started_at,
      ownerClientId: owner.clientId,
      ownerSessionId: owner.sessionId,
      ...(owner.workspaceId === undefined ? {} : { ownerWorkspaceId: owner.workspaceId }),
    };
  }

  private async releaseTerminalReservation(metadata: DurableTaskMetadata): Promise<void> {
    if (!isTerminal(metadata.state) || metadata.containment === undefined) return;
    if (metadata.containment === 'posix_group_v1') {
      const canonical = await this.readMetadata(metadata.task_id, false, 1);
      if (!canonical.ok || canonical.value.containment !== 'posix_group_v1'
        || canonical.value.request_digest !== metadata.request_digest || canonical.value.state !== metadata.state
        || canonical.value.exit_code !== metadata.exit_code || canonical.value.finished_at !== metadata.finished_at
        || !await this.posixGroupIsEmpty(canonical.value)) return;
    }
    if (metadata.containment === 'windows_job_v1') return;
    if (metadata.containment === 'windows_job_v2' && !await this.verifyNativeReservation({
      taskId: metadata.task_id,
      requestDigest: metadata.request_digest ?? '',
      ownerClientId: metadata.owner_client_id ?? '',
      ...(metadata.owner_workspace_id === undefined ? {} : { ownerWorkspaceId: metadata.owner_workspace_id }),
      nativeReceiptPath: path.join(this.taskDirectory(metadata.task_id), 'containment.receipt.json'),
      ...(metadata.containmentBinding === undefined ? {} : { nativeBinding: metadata.containmentBinding }),
    })) return;
    await this.activeIndex.release(metadata.task_id, metadata.request_digest ?? null);
  }

  private async verifyNativeReservation(reservation: DurableTaskReservation): Promise<boolean> {
    const binding = reservation.nativeBinding;
    if (this.windowsNativeAuthority === undefined || binding === undefined || binding.taskId !== reservation.taskId
      || binding.reservationId !== reservation.taskId || binding.requestDigest !== reservation.requestDigest
      || binding.ownerClientId !== reservation.ownerClientId || binding.workspaceId !== reservation.ownerWorkspaceId) return false;
    const canonical = await this.readMetadata(reservation.taskId, false, 1);
    if (!canonical.ok || canonical.value.containment !== 'windows_job_v2' || !isTerminal(canonical.value.state)
      || !nativeBindingMatchesMetadata(canonical.value, binding)) return false;
    let proof = await this.windowsNativeAuthority.inspect({ directory: this.taskDirectory(reservation.taskId), binding });
    if (proof.state === 'termination_unknown' && canonical.value.state === 'failed' && canonical.value.exit_code === -1) {
      const abortProof = await this.windowsNativeAuthority.abortBeforeLaunch({ directory: this.taskDirectory(reservation.taskId), binding });
      if (abortProof.state === 'launch_not_started' || abortProof.state === 'terminal_verified') proof = abortProof;
    }
    if (proof.state === 'launch_not_started') return canonical.value.state === 'failed' && canonical.value.exit_code === -1;
    return proof.state === 'terminal_verified' && canonical.value.state === nativeOutcomeState(proof.outcome, proof.exitCode)
      && canonical.value.exit_code === proof.exitCode && typeof canonical.value.finished_at === 'string';
  }

  private async reconcile(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    if (metadata.containment === undefined) return metadata;
    if (metadata.containment === 'windows_job_v1') {
      return { ...metadata, state: 'termination_unverified', error: 'Legacy native task has no authenticated termination proof; recovery must not replay it' };
    }
    if (metadata.containment === 'windows_job_v2') return this.reconcileNative(metadata);
    if (metadata.containment === 'posix_group_v1') return this.reconcilePosix(metadata);
    if (this.platform !== 'win32' && !isTerminal(metadata.state)) {
      const unknown = { ...metadata, state: 'termination_unverified' as const,
        error: 'Legacy POSIX task has no process-group proof; keep its reservation and never replay it' };
      delete unknown.finished_at;
      return unknown;
    }
    if (metadata.state !== 'running' && metadata.state !== 'termination_unverified') return metadata;
    const workerPid = metadata.worker_pid;
    if (workerPid !== undefined) {
      const workerProbe = await probeProcessIdentity(workerPid, this.platform);
      if (isTrackedProcessLive(workerProbe, metadata.worker_started_at)) return metadata;
      if (identityCapturePendingForProbe(workerProbe, metadata.worker_started_at, metadata.started_at)) return metadata;
      if (isUnverifiableTrackedProbe(workerProbe, metadata.worker_started_at)) {
        const finalized = await this.awaitTerminalMetadata(metadata.task_id);
        if (finalized !== undefined) return finalized;
        // An unverifiable probe does not prove the worker is gone. Keep the
        // worker-owned task.json untouched so a later terminal write cannot be
        // overwritten by a stale host-side downgrade.
        const uncertain = { ...metadata, state: 'termination_unverified' as const };
        uncertain.error = uncertain.error ?? describeTrackedProbe('worker', workerProbe);
        delete uncertain.finished_at;
        return uncertain;
      }
    }
    await delay(PROCESS_EXIT_RECONCILE_DELAY_MS);
    const refreshed = await this.readMetadata(metadata.task_id);
    if (refreshed.ok && isTerminal(refreshed.value.state)) return refreshed.value;
    const current = refreshed.ok ? refreshed.value : metadata;
    if (current.worker_pid !== undefined) {
      const refreshedWorkerProbe = await probeProcessIdentity(current.worker_pid, this.platform);
      if (isTrackedProcessLive(refreshedWorkerProbe, current.worker_started_at)) return current;
      if (identityCapturePendingForProbe(refreshedWorkerProbe, current.worker_started_at, current.started_at)) return current;
      if (isUnverifiableTrackedProbe(refreshedWorkerProbe, current.worker_started_at)) {
        const finalized = await this.awaitTerminalMetadata(current.task_id);
        if (finalized !== undefined) return finalized;
        const uncertain = { ...current, state: 'termination_unverified' as const };
        uncertain.error = uncertain.error ?? describeTrackedProbe('worker', refreshedWorkerProbe);
        delete uncertain.finished_at;
        return uncertain;
      }
    }
    if (current.child_pid !== undefined) {
      const refreshedChildProbe = await probeProcessIdentity(current.child_pid, this.platform);
      if (isTrackedProcessLive(refreshedChildProbe, current.child_started_at)) {
        current.state = 'termination_unverified';
        current.error = current.error ?? 'Durable task worker exited while its child process is still running';
        delete current.finished_at;
        await this.writeMetadata(current);
        return current;
      }
      if (identityCapturePendingForProbe(refreshedChildProbe, current.child_started_at, current.started_at)) return current;
      if (isUnverifiableTrackedProbe(refreshedChildProbe, current.child_started_at)) {
        current.state = 'termination_unverified';
        current.error = current.error ?? describeTrackedProbe('child', refreshedChildProbe);
        delete current.finished_at;
        await this.writeMetadata(current);
        return current;
      }
    }
    if (current.state === 'termination_unverified') return current;

    // Once both tracked processes are gone, the worker may still be completing its
    // final atomic metadata rename. This window is observable on busy Windows CI:
    // declaring failure after a single refresh can overwrite a legitimate completion.
    const finalized = await this.awaitTerminalMetadata(current.task_id);
    if (finalized !== undefined) return finalized;

    current.state = 'failed';
    current.exit_code = current.exit_code ?? -1;
    current.error = current.error ?? 'Durable task worker exited before recording a final state';
    current.finished_at = current.finished_at ?? new Date().toISOString();
    await this.writeMetadata(current);
    return current;
  }

  private async posixGroupIsEmpty(metadata: DurableTaskMetadata): Promise<boolean> {
    if (this.platform === 'darwin') return false;
    if (metadata.posix_launch_not_started === true && metadata.child_pid === undefined) return true;
    if (metadata.child_pid === undefined) return false;
    return (await this.posixGroupInspector(metadata.child_pid, {
      platform: this.platform,
      ...(metadata.child_started_at === undefined ? {} : { expectedRootStartedAt: metadata.child_started_at }),
    })).state === 'empty';
  }

  private async reconcilePosix(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    // The coordinator persists its PID asynchronously after reservation. A
    // status read during this bounded bootstrap gap cannot infer owner loss.
    // Preserve the live provisional state, and keep its writer reservation;
    // when the grace expires without identity, recovery fails closed below.
    const started = Date.parse(metadata.started_at);
    if ((metadata.state === 'starting' || metadata.state === 'running')
      && metadata.worker_pid === undefined && metadata.child_pid === undefined
      && Number.isFinite(started) && Date.now() >= started
      && Date.now() - started < PROCESS_IDENTITY_CAPTURE_GRACE_MS) return metadata;
    const empty = await this.posixGroupIsEmpty(metadata);
    if (empty && isTerminal(metadata.state)) return metadata;
    const worker = metadata.worker_pid === undefined ? undefined : await probeProcessIdentity(metadata.worker_pid, this.platform);
    const workerLive = worker !== undefined && (isTrackedProcessLive(worker, metadata.worker_started_at)
      || identityCapturePendingForProbe(worker, metadata.worker_started_at, metadata.started_at));
    if (workerLive && !isTerminal(metadata.state)) return metadata;
    const unknown = (): DurableTaskMetadata => {
      const result = { ...metadata, state: 'termination_unverified' as const,
        error: 'POSIX group termination or worker ownership is unverified; the request must not be replayed' };
      delete result.finished_at;
      return result;
    };
    if (!empty || worker !== undefined && isUnverifiableTrackedProbe(worker, metadata.worker_started_at)) return unknown();
    const latest = await this.readMetadata(metadata.task_id, false, 1);
    if (!latest.ok || latest.value.request_digest !== metadata.request_digest) return unknown();
    if (isTerminal(latest.value.state)) return latest.value;
    const recovered: DurableTaskMetadata = { ...latest.value,
      state: latest.value.posix_stop_target ?? 'failed', exit_code: -1,
      finished_at: new Date().toISOString(), output_finalized: false,
      error: 'POSIX process group is empty; coordinator exited without a finalized result',
    };
    await this.writeMetadata(recovered);
    const canonical = await this.readMetadata(metadata.task_id, false, 1);
    return canonical.ok ? canonical.value : unknown();
  }

  private async cancelPosix(metadata: DurableTaskMetadata): Promise<Result<Record<string, unknown>>> {
    await writeFile(path.join(this.taskDirectory(metadata.task_id), 'posix.cancel'), 'cancel', { mode: 0o600 });
    const worker = metadata.worker_pid === undefined ? undefined : await probeProcessIdentity(metadata.worker_pid, this.platform);
    if (worker?.state === 'gone' && metadata.child_pid !== undefined && metadata.child_started_at !== undefined) {
      metadata.posix_stop_target = 'cancelled';
      await this.writeMetadata(metadata);
      await new PosixProcessTree({ platform: this.platform, inspectGroup: this.posixGroupInspector })
        .stopPid(metadata.child_pid, metadata.child_started_at).catch(() => undefined);
    }
    const deadline = Date.now() + 2_000;
    do {
      const current = await this.readMetadata(metadata.task_id);
      if (current.ok) metadata = await this.reconcilePosix(current.value);
      if (isTerminal(metadata.state)) break;
      await delay(50);
    } while (Date.now() < deadline);
    await this.releaseTerminalReservation(metadata);
    return ok(await this.snapshotFromMetadata(metadata));
  }

  private async reconcileNative(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    const binding = metadata.containmentBinding;
    const unknown = (): DurableTaskMetadata => {
      const unresolved = { ...metadata, state: 'termination_unverified' as const, error: 'Authenticated native termination proof is unavailable' };
      delete unresolved.finished_at;
      return unresolved;
    };
    if (this.windowsNativeAuthority === undefined || binding === undefined || !nativeBindingMatchesMetadata(metadata, binding)) return unknown();
    let proof = await this.windowsNativeAuthority.inspect({ directory: this.taskDirectory(metadata.task_id), binding });
    if (proof.state === 'running') return isTerminal(metadata.state) ? unknown() : { ...metadata, state: metadata.state === 'starting' ? 'running' : metadata.state };
    if (proof.state === 'termination_unknown') {
      const deadlinePassed = typeof metadata.deadline_at === 'string' && Date.now() > new Date(metadata.deadline_at).getTime();
      const isUnverifiedState = metadata.state === 'termination_unverified';
      if (metadata.state !== 'starting' && (isUnverifiedState || deadlinePassed) && metadata.worker_pid !== undefined) {
        const worker = await probeProcessIdentity(metadata.worker_pid, this.platform);
        const workerDead = worker.state === 'gone' || (worker.state === 'live' && metadata.worker_started_at !== undefined && worker.processStartedAt !== metadata.worker_started_at);
        let childDead = true;
        if (metadata.child_pid !== undefined && workerDead) {
          const child = await probeProcessIdentity(metadata.child_pid, this.platform);
          childDead = child.state === 'gone' || (child.state === 'live' && metadata.child_started_at !== undefined && child.processStartedAt !== metadata.child_started_at);
        }
        if (workerDead && childDead) {
          const abortProof = await this.windowsNativeAuthority.abortBeforeLaunch({ directory: this.taskDirectory(metadata.task_id), binding });
          if (abortProof.state === 'launch_not_started' || abortProof.state === 'terminal_verified') {
            proof = abortProof;
          }
        }
      }
    }
    if (proof.state === 'termination_unknown') return isTerminal(metadata.state) ? unknown() : metadata;
    const expectedState = proof.state === 'launch_not_started' ? 'failed' : nativeOutcomeState(proof.outcome, proof.exitCode);
    const expectedExitCode = proof.state === 'launch_not_started' ? -1 : proof.exitCode;
    if (metadata.state === expectedState && metadata.exit_code === expectedExitCode && metadata.finished_at !== undefined) return metadata;
    if (metadata.worker_pid !== undefined) {
      const worker = await probeProcessIdentity(metadata.worker_pid, this.platform);
      if (worker.state !== 'gone' && !(worker.state === 'live' && metadata.worker_started_at !== undefined
        && worker.processStartedAt !== metadata.worker_started_at)) return metadata;
    } else if (proof.state !== 'launch_not_started') {
      return unknown();
    }
    const readback = await this.readMetadata(metadata.task_id);
    if (!readback.ok || readback.value.containmentBinding === undefined || !nativeBindingMatchesMetadata(readback.value, binding)) return unknown();
    const current = readback.value;
    if (current.state === expectedState && current.exit_code === expectedExitCode && current.finished_at !== undefined) return current;
    const finalized = { ...current, state: expectedState, exit_code: expectedExitCode,
      finished_at: current.finished_at ?? new Date().toISOString() };
    delete finalized.error;
    await this.writeMetadata(finalized);
    return finalized;
  }

  private async awaitTerminalMetadata(taskId: string): Promise<DurableTaskMetadata | undefined> {
    const deadline = Date.now() + PROCESS_EXIT_FINALIZATION_GRACE_MS;
    while (true) {
      const latest = await this.readMetadata(taskId, false);
      if (latest.ok && isTerminal(latest.value.state)) return latest.value;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return undefined;
      await delay(Math.min(PROCESS_EXIT_RECONCILE_DELAY_MS, remainingMs));
    }
  }

  private async snapshotFromMetadata(metadata: DurableTaskMetadata, tailLines?: number, includeOutput = true): Promise<Record<string, unknown>> {
    const taskDirectory = this.taskDirectory(metadata.task_id);
    const stdout = includeOutput && metadata.include_stdout ? await readBoundedText(path.join(taskDirectory, STDOUT_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
    const stderr = includeOutput && metadata.include_stderr ? await readBoundedText(path.join(taskDirectory, STDERR_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
    return {
      task_id: metadata.task_id,
      state: metadata.state,
      ...(metadata.exit_code === undefined ? {} : { exit_code: metadata.exit_code }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(metadata.error === undefined ? {} : { error: metadata.error }),
      started_at: metadata.started_at,
      ...(metadata.finished_at === undefined ? {} : { finished_at: metadata.finished_at }),
      deadline_at: metadata.deadline_at,
      durable: true,
      ...(metadata.worker_pid === undefined ? {} : { worker_pid: metadata.worker_pid }),
      ...(metadata.worker_started_at === undefined ? {} : { worker_started_at: metadata.worker_started_at }),
      ...(metadata.child_pid === undefined ? {} : { child_pid: metadata.child_pid }),
      ...(metadata.child_started_at === undefined ? {} : { child_started_at: metadata.child_started_at }),
      truncated: metadata.stdout_truncated === true || metadata.stderr_truncated === true,
    };
  }

  private async readMetadata(
    taskId: string,
    hydrateWorkerIdentity = true,
    attempts = METADATA_READ_RETRIES,
  ): Promise<Result<DurableTaskMetadata>> {
    const metadataPath = path.join(this.taskDirectory(taskId), METADATA_FILENAME);
    const readAttempts = Math.max(1, attempts);
    for (let attempt = 0; attempt < readAttempts; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (isMetadata(parsed) && parsed.task_id === taskId) {
          if (hydrateWorkerIdentity && !isTerminal(parsed.state) && parsed.worker_pid === undefined) {
            const publishedPid = await readPublishedPid(path.join(this.taskDirectory(taskId), WORKER_PID_FILENAME));
            if (publishedPid !== undefined) parsed.worker_pid = publishedPid;
          }
          if (hydrateWorkerIdentity && !isTerminal(parsed.state) && parsed.worker_started_at === undefined) {
            const publishedStartedAt = await readPublishedStartedAt(path.join(this.taskDirectory(taskId), WORKER_STARTED_FILENAME));
            if (publishedStartedAt !== undefined) parsed.worker_started_at = publishedStartedAt;
          }
          return ok(parsed);
        }
      } catch {
        if (attempt === readAttempts - 1) break;
      }
      await delay(15);
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private async writeMetadata(metadata: DurableTaskMetadata): Promise<void> {
    await writeMetadataAtomically(path.join(this.taskDirectory(metadata.task_id), METADATA_FILENAME), metadata);
  }

  private taskDirectory(taskId: string): string {
    return path.join(this.rootDirectory, taskId);
  }

  private async ensureWorkerScript(): Promise<string> {
    const workerHash = createHash('sha256').update(DURABLE_WORKER_SOURCE).digest('hex').slice(0, 16);
    const workerPath = path.join(this.rootDirectory, `durable-shell-worker-${workerHash}.mjs`);
    try {
      await writeFile(workerPath, DURABLE_WORKER_SOURCE, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    return workerPath;
  }

  private async hydrateProcessIdentities(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    if (metadata.worker_started_at !== undefined && metadata.child_started_at !== undefined) return metadata;
    const startedAtPath = path.join(this.taskDirectory(metadata.task_id), WORKER_STARTED_FILENAME);
    const startedAtMs = Date.parse(metadata.started_at);
    const captureDeadline = Number.isFinite(startedAtMs)
      ? startedAtMs + PROCESS_IDENTITY_CAPTURE_GRACE_MS
      : Date.now() + PROCESS_IDENTITY_CAPTURE_GRACE_MS;
    while (true) {
      if (metadata.worker_started_at === undefined) {
        const publishedWorkerStartedAt = await readPublishedStartedAt(startedAtPath);
        if (publishedWorkerStartedAt !== undefined) metadata.worker_started_at = publishedWorkerStartedAt;
      }
      const refreshed = await this.readMetadata(metadata.task_id);
      if (refreshed.ok) {
        if (refreshed.value.worker_started_at !== undefined) metadata.worker_started_at = refreshed.value.worker_started_at;
        if (refreshed.value.child_started_at !== undefined) metadata.child_started_at = refreshed.value.child_started_at;
      }
      if (metadata.worker_started_at !== undefined && metadata.child_started_at !== undefined) break;
      const remainingMs = captureDeadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(50, remainingMs));
    }
    return metadata;
  }
}

async function writeMetadataAtomically(filename: string, metadata: DurableTaskMetadata): Promise<void> {
  const temporaryPath = `${filename}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    const serialized = JSON.stringify(metadata);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, filename);
    if (await readFile(filename, 'utf8') !== serialized) throw new Error('DURABLE_METADATA_READBACK_FAILED');
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readPublishedPid(filename: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(filename, 'utf8')).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMetadata(value: unknown): value is DurableTaskMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.version === 1 || record.version === 2)
    && typeof record.task_id === 'string'
    && (record.request_digest === undefined || (typeof record.request_digest === 'string' && /^[a-f0-9]{64}$/i.test(record.request_digest)))
    && (isExecutingState(record.state) || record.state === 'termination_unverified' || isTerminalValue(record.state))
    && (record.containment === undefined || record.containment === 'windows_job_v1' || record.containment === 'windows_job_v2' || record.containment === 'posix_group_v1')
    && (record.containment !== 'windows_job_v2' || parseNativeAttemptBinding(record.containmentBinding) !== undefined)
    && typeof record.started_at === 'string'
    && typeof record.include_stdout === 'boolean'
    && typeof record.include_stderr === 'boolean'
    && typeof record.max_output_bytes === 'number'
    && typeof record.deadline_at === 'string'
    && (record.worker_started_at === undefined || typeof record.worker_started_at === 'string')
    && (record.child_started_at === undefined || typeof record.child_started_at === 'string');
}

async function readPublishedStartedAt(filename: string): Promise<string | undefined> {
  try {
    const value = (await readFile(filename, 'utf8')).trim();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function projectTaskForGoal(reconciled: DurableTaskMetadata): GoalTaskProjection {
  if (reconciled.containment !== undefined) return { kind: 'reconciled', metadata: reconciled };
  const reason = 'Legacy task has no authenticated containment proof; historical completion cannot establish Goal termination';
  const metadata: DurableTaskMetadata = { ...reconciled, state: 'termination_unverified', error: reason };
  delete metadata.exit_code;
  delete metadata.finished_at;
  return { kind: 'legacy_unverified', metadata, reason };
}

function metadataOwner(metadata: DurableTaskMetadata): CapabilityTaskOwner {
  if (metadata.owner_client_id === undefined || metadata.owner_session_id === undefined) return legacyCapabilityTaskOwner();
  return {
    clientId: metadata.owner_client_id,
    sessionId: metadata.owner_session_id,
    ...(metadata.owner_workspace_id === undefined ? {} : { workspaceId: metadata.owner_workspace_id }),
  };
}

function launchRecordOwner(record: DurableTaskLaunchRecord): CapabilityTaskOwner {
  return {
    clientId: record.ownerClientId,
    sessionId: record.ownerSessionId,
    ...(record.ownerWorkspaceId === undefined ? {} : { workspaceId: record.ownerWorkspaceId }),
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function nativeOutcomeState(outcome: 'completed' | 'cancelled' | 'timed_out' | 'interrupted', exitCode: number): DurableShellTaskState {
  return outcome === 'interrupted' ? 'failed' : outcome === 'completed' ? (exitCode === 0 ? 'completed' : 'failed') : outcome;
}

function nativeBindingMatchesMetadata(metadata: DurableTaskMetadata, binding: NativeAttemptBinding): boolean {
  return binding.taskId === metadata.task_id && binding.reservationId === metadata.task_id
    && binding.requestDigest === metadata.request_digest && binding.ownerClientId === metadata.owner_client_id
    && binding.ownerSessionId === metadata.owner_session_id && binding.workspaceId === metadata.owner_workspace_id
    && JSON.stringify(parseNativeAttemptBinding(metadata.containmentBinding)) === JSON.stringify(parseNativeAttemptBinding(binding));
}

function isExecutingState(state: unknown): boolean { return state === 'starting' || state === 'running'; }

function isTerminal(state: DurableShellTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

function isTerminalValue(value: unknown): value is DurableShellTaskState {
  return typeof value === 'string' && isTerminal(value as DurableShellTaskState);
}

async function readBoundedText(filename: string, maxBytes: number, tailLines?: number): Promise<string> {
  const boundedBytes = Number.isFinite(maxBytes)
    ? Math.max(0, Math.min(Math.floor(maxBytes), 8 * 1024 * 1024))
    : 0;
  if (boundedBytes === 0) return '';
  let value = '';
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, 'r');
    const fileSize = (await handle.stat()).size;
    const bytesToRead = Math.min(boundedBytes, Math.max(0, fileSize));
    if (bytesToRead === 0) return '';
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    value = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
  value = redactText(value);
  if (tailLines === undefined || tailLines < 1) return tailLines === 0 ? '' : value;
  const lines = value.split(/\r?\n/);
  return lines.slice(-tailLines).join('\n');
}

function redactText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

type PortableProcessProbe =
  | { readonly state: 'live'; readonly processStartedAt: string }
  | { readonly state: 'gone' }
  | { readonly state: 'unverifiable'; readonly reason: string };

async function probeProcessIdentity(pid: number, platform: NodeJS.Platform): Promise<PortableProcessProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return { state: 'unverifiable', reason: 'invalid_pid' };
  try {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ESRCH') {
        return { state: 'gone' };
      }
    }
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){'GONE';exit 0};throw}; 'LIVE|' + $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)`,
      ], { windowsHide: true, encoding: 'utf8', timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 });
      return parsePortableProcessProbe(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
      encoding: 'utf8', timeout: 3_500, maxBuffer: 16 * 1024,
    });
    return parsePosixProcessProbe(stdout);
  } catch (error: unknown) {
    if (isProcessProbeNotFound(error)) return { state: 'gone' };
    return { state: 'unverifiable', reason: isProcessProbeTimeout(error) ? 'probe_timeout' : 'probe_failed' };
  }
}

function parsePortableProcessProbe(value: string): PortableProcessProbe {
  const trimmed = value.trim();
  if (trimmed === 'GONE') return { state: 'gone' };
  if (!trimmed.startsWith('LIVE|')) return { state: 'unverifiable', reason: 'invalid_probe_response' };
  const startedAt = trimmed.slice(5);
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? { state: 'live', processStartedAt: new Date(parsed).toISOString() } : { state: 'unverifiable', reason: 'invalid_start_time' };
}

export function parsePosixProcessProbe(value: string): PortableProcessProbe {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { state: 'gone' };
  const fields = trimmed.split(/\s+/);
  const status = fields.pop();
  if (status === undefined || fields.length === 0) return { state: 'unverifiable', reason: 'invalid_probe_response' };
  // A POSIX zombie has already exited and cannot execute further work. kill(pid, 0)
  // still succeeds until its parent reaps the process, so treating Z as live
  // makes verified cancellation falsely time out on Linux/macOS.
  if (status.startsWith('Z')) return { state: 'gone' };
  const parsed = Date.parse(fields.join(' '));
  return Number.isFinite(parsed) ? { state: 'live', processStartedAt: new Date(parsed).toISOString() } : { state: 'unverifiable', reason: 'invalid_start_time' };
}

function isTrackedProcessLive(probe: PortableProcessProbe, expectedStartedAt: string | undefined): boolean {
  return probe.state === 'live' && expectedStartedAt !== undefined && probe.processStartedAt === expectedStartedAt;
}

function identityCapturePendingForProbe(
  probe: PortableProcessProbe,
  expectedStartedAt: string | undefined,
  taskStartedAt: string,
): boolean {
  return expectedStartedAt === undefined
    && identityCapturePending(taskStartedAt)
    && (probe.state === 'live' || probe.state === 'unverifiable');
}

function isUnverifiableTrackedProbe(probe: PortableProcessProbe, expectedStartedAt: string | undefined): boolean {
  // If an expected identity was captured and the PID is now live with a different
  // start time, the tracked process is gone and Windows has reused the PID. That is
  // not an unverifiable state: reconciliation must continue to the bounded final
  // metadata grace instead of allowing a stale running snapshot to overwrite an
  // already-persisting completed result with termination_unverified.
  return probe.state === 'unverifiable' || (probe.state === 'live' && expectedStartedAt === undefined);
}

function describeTrackedProbe(kind: string, probe: PortableProcessProbe): string {
  if (probe.state === 'unverifiable') return `Durable task ${kind} liveness is unverifiable (${probe.reason})`;
  if (probe.state === 'live') return `Durable task ${kind} process identity could not be verified`;
  return `Durable task ${kind} process identity is no longer live`;
}

function identityCapturePending(startedAt: string): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && Date.now() - started < PROCESS_IDENTITY_CAPTURE_GRACE_MS;
}

function isProcessProbeNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = (error as NodeJS.ErrnoException).code;
  return code === 1 || code === 'ESRCH' || code === 'ENOENT';
}

function isProcessProbeTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return record.code === 'ETIMEDOUT' || record.killed === true || (record.code == null && record.signal === 'SIGTERM');
}

async function stopProcessTree(
  pid: number,
  relatedPids: readonly number[] = [],
  platform: NodeJS.Platform = process.platform,
  identities: ReadonlyMap<number, string> = new Map(),
): Promise<boolean> {
  const trackedPids = [...new Set([pid, ...relatedPids])];
  for (const trackedPid of trackedPids) {
    const expectedStartedAt = identities.get(trackedPid);
    const probe = await probeProcessIdentity(trackedPid, platform);
    if (probe.state === 'unverifiable' || (probe.state === 'live' && (expectedStartedAt === undefined || probe.processStartedAt !== expectedStartedAt))) return false;
  }
  if (await trackedProcessesExited(trackedPids, platform, identities)) {
    await delay(PROCESS_HANDLE_RELEASE_GRACE_MS);
    return true;
  }
  if (platform === 'win32') {
    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve(null));
      killer.once('close', resolve);
    });
    if (exitCode !== 0 && !(await trackedProcessesExited(trackedPids, platform, identities))) return false;
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (error: unknown) {
      // A missing group is safe only when every tracked identity is already
      // gone. Never fall back to killing a possibly reused naked PID.
      if (!isNoSuchProcess(error) || !(await trackedProcessesExited(trackedPids, platform, identities))) return false;
      return true;
    }
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (await trackedProcessesExited(trackedPids, platform, identities)) {
      // Windows can report the PIDs gone slightly before their final CWD/file
      // handles become deletable. POSIX can retain a zombie PID briefly after
      // exit, which the identity probe correctly treats as non-executing.
      await delay(PROCESS_HANDLE_RELEASE_GRACE_MS);
      return trackedProcessesExited(trackedPids, platform, identities);
    }
    await delay(50);
  }
  if (await trackedProcessesExited(trackedPids, platform, identities)) return true;
  if (platform !== 'win32') {
    // Revalidate the exact group leader before escalating. A reused PID must
    // never receive a signal merely because it inherited the same number.
    const targetProbe = await probeProcessIdentity(pid, platform);
    const expectedStartedAt = identities.get(pid);
    if (targetProbe.state === 'unverifiable'
      || (targetProbe.state === 'live' && (expectedStartedAt === undefined || targetProbe.processStartedAt !== expectedStartedAt))) return false;
    if (targetProbe.state === 'live') {
      try { process.kill(-pid, 'SIGKILL'); } catch (error: unknown) {
        if (!isNoSuchProcess(error)) return false;
      }
    }
    const killDeadline = Date.now() + 1_500;
    while (Date.now() < killDeadline) {
      if (await trackedProcessesExited(trackedPids, platform, identities)) return true;
      await delay(50);
    }
  }
  return trackedProcessesExited(trackedPids, platform, identities);
}

async function trackedProcessesExited(
  trackedPids: readonly number[],
  platform: NodeJS.Platform,
  identities: ReadonlyMap<number, string>,
): Promise<boolean> {
  for (const trackedPid of trackedPids) {
    if (platform === 'win32' && !isProcessRunning(trackedPid)) continue;
    const probe = await probeProcessIdentity(trackedPid, platform);
    if (probe.state === 'gone') continue;
    if (probe.state === 'unverifiable') return false;
    const expectedStartedAt = identities.get(trackedPid);
    if (expectedStartedAt === undefined || probe.processStartedAt !== expectedStartedAt) return false;
    return false;
  }
  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DURABLE_WORKER_SOURCE = String.raw`import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const METADATA_IO_RETRY_ATTEMPTS = 6;
const METADATA_IO_RETRY_BASE_MS = 15;

const specPath = process.argv[2];
if (!specPath) process.exit(64);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
await unlink(specPath).catch(() => undefined);
let metadata = JSON.parse(await readFile(spec.metadataPath, 'utf8'));
metadata.version = 2;
let persistenceQueue = Promise.resolve();
metadata.worker_pid = process.pid;
await persist();
let stdoutBytes = 0;
let stderrBytes = 0;
const stdoutHandle = await open(spec.stdoutPath, 'a');
const stderrHandle = await open(spec.stderrPath, 'a');
let settled = false;
let timer;
let child;
let nativeAuthority;
let nativeInvocation;
let posixRuntime;
let posixControlTimer;
let posixControlBusy = false;
let posixRootExit;
let posixPipesClosed = false;
let stopTarget;
let outputWriteFailed = false;
const pendingWrites = new Set();

function appendBounded(handle, chunk, stream) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
  const remaining = Math.max(0, spec.maxOutputBytes - used);
  if (remaining <= 0) {
    metadata[stream + '_truncated'] = true;
    return;
  }
  const slice = buffer.subarray(0, remaining);
  if (stream === 'stdout') stdoutBytes += slice.byteLength;
  else stderrBytes += slice.byteLength;
  if (buffer.byteLength > remaining) metadata[stream + '_truncated'] = true;
  const pending = handle.write(slice);
  pendingWrites.add(pending);
  void pending.then(() => pendingWrites.delete(pending), () => { outputWriteFailed = true; pendingWrites.delete(pending); });
}

function isTransientMetadataIoError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE';
}

function persist() {
  const serialized = JSON.stringify(metadata);
  const committed = persistenceQueue.catch(() => undefined).then(() => persistSnapshot(serialized));
  persistenceQueue = committed;
  return committed;
}

async function persistSnapshot(serialized) {
  for (let attempt = 0; attempt < METADATA_IO_RETRY_ATTEMPTS; attempt += 1) {
    const temporaryPath = spec.metadataPath + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2);
    let retryDelayMs = 0;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporaryPath, spec.metadataPath);
      if (await readFile(spec.metadataPath, 'utf8') !== serialized) throw new Error('DURABLE_METADATA_READBACK_FAILED');
      return;
    } catch (error) {
      if (attempt + 1 >= METADATA_IO_RETRY_ATTEMPTS || !isTransientMetadataIoError(error)) throw error;
      retryDelayMs = METADATA_IO_RETRY_BASE_MS * (attempt + 1);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

async function releaseReservation() {
  if (spec.native || spec.posix) return;
  try {
    const marker = JSON.parse(await readFile(spec.activeMarkerPath, 'utf8'));
    if ((marker?.version !== 1 && marker?.version !== 2) || marker.taskId !== spec.taskId || marker.requestDigest !== spec.requestDigest) return;
    await unlink(spec.activeMarkerPath);
  } catch {
    // A later warm reservation revalidates a stale marker against task.json.
  }
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

async function processStartedAt(pid) {
  try {
    if (process.platform === 'win32') {
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; try{$p=Get-Process -Id " + pid + " -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){'GONE';exit 0};throw}; 'LIVE|' + $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)",
      ], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
      const output = String(result.stdout || '').trim();
      return output.startsWith('LIVE|') ? output.slice(5) : null;
    }
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1750, maxBuffer: 16384 });
    const value = String(result.stdout || '').trim();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  } catch {
    return null;
  }
}

async function stopTree(pid) {
  if (spec.native) {
    if (!nativeAuthority) return false;
    const proof = await nativeAuthority.cancel({ directory: spec.native.directory, binding: spec.native.binding });
    return proof.state === 'terminal_verified' || proof.state === 'launch_not_started';
  }
  if (spec.posix) {
    if (!posixRuntime) return false;
    if ((await posixRuntime.inspectPosixProcessGroup(pid)).state === 'empty') return true;
    if (!metadata.child_started_at) return false;
    try {
      await new posixRuntime.PosixProcessTree().stopPid(pid, metadata.child_started_at);
      return (await posixRuntime.inspectPosixProcessGroup(pid, { expectedRootStartedAt: metadata.child_started_at })).state === 'empty';
    } catch { return false; }
  }
  if (!processRunning(pid)) return true;
  if (!metadata.child_started_at || await processStartedAt(pid) !== metadata.child_started_at) return false;
  if (process.platform === 'win32') {
    const code = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve(null));
      killer.once('close', resolve);
    });
    if (code !== 0 && processRunning(pid)) return false;
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) {
      if (!(error && error.code === 'ESRCH')) return false;
      return !processRunning(pid);
    }
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!processRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!processRunning(pid)) return true;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if (!(error && error.code === 'ESRCH')) return false;
    }
    const killDeadline = Date.now() + 1500;
    while (Date.now() < killDeadline) {
      if (!processRunning(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return !processRunning(pid);
}

async function containmentReceipt() {
  if (!spec.native || !nativeAuthority) return undefined;
  const proof = await nativeAuthority.inspect({ directory: spec.native.directory, binding: spec.native.binding });
  return proof.state === 'terminal_verified' || proof.state === 'launch_not_started' ? proof : undefined;
}

async function finish(state, exitCode, error) {
  if (settled) return;
  if (spec.posix) {
    if (!child?.pid) metadata.posix_launch_not_started = true;
    else if (!posixRuntime || (await posixRuntime.inspectPosixProcessGroup(child.pid, {
      expectedRootStartedAt: metadata.child_started_at,
    })).state !== 'empty') {
      if (metadata.state !== 'termination_unverified') {
        metadata.state = 'termination_unverified';
        metadata.error = 'POSIX process group remains live or unverified';
        delete metadata.finished_at;
        await persist();
      }
      return;
    }
    state = stopTarget ?? (posixRootExit === 0 ? 'completed' : 'failed');
    exitCode = stopTarget ? -1 : posixRootExit ?? exitCode;
    if (child?.pid && !posixPipesClosed) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(drainTimer); child.off('close', done); resolve(); };
        const drainTimer = setTimeout(done, 1000);
        child.once('close', done);
      });
      if (!posixPipesClosed) {
        metadata.state = 'termination_unverified';
        metadata.error = 'POSIX group is empty but inherited output pipes remain open';
        delete metadata.finished_at;
        await persist();
        return;
      }
    }
    if (settled) return;
  }
  settled = true;
  if (posixControlTimer) clearInterval(posixControlTimer);
  if (spec.native && state !== 'termination_unverified') {
    if (state === 'failed' && nativeAuthority) await nativeAuthority.abortBeforeLaunch({ directory: spec.native.directory, binding: spec.native.binding }).catch(() => undefined);
    const receipt = await containmentReceipt();
    if (!receipt) { state = 'termination_unverified'; error = 'Native containment has no verified terminal receipt'; }
    else if (receipt.state === 'launch_not_started') { state = 'failed'; exitCode = -1; }
    else { state = receipt.outcome === 'completed' ? (receipt.exitCode === 0 ? 'completed' : 'failed') : receipt.outcome; exitCode = receipt.exitCode; }
  }
  settled = true;
  if (timer) clearTimeout(timer);
  metadata.state = state;
  metadata.exit_code = exitCode;
  if (error) metadata.error = error;
  else delete metadata.error;
  if (state === 'termination_unverified') delete metadata.finished_at;
  else metadata.finished_at = new Date().toISOString();
  await Promise.allSettled([...pendingWrites]);
  const outputClosed = await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
  metadata.output_finalized = !outputWriteFailed && outputClosed.every((result) => result.status === 'fulfilled');
  const persisted = await persist().then(() => true, () => false);
  if (persisted && state !== 'termination_unverified') await releaseReservation();
}

try {
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  if (spec.electronRunAsNode) childEnvironment.ELECTRON_RUN_AS_NODE = '1';
  if (spec.posix) {
    if (createHash('sha256').update(await readFile(new URL(spec.posix.moduleUrl))).digest('hex') !== spec.posix.sha256) {
      throw new Error('POSIX_WORKER_RUNTIME_INTEGRITY_FAILED');
    }
    posixRuntime = await import(spec.posix.moduleUrl);
  }
  if (spec.native) {
    if (spec.native.configuration.workerModuleSha256 !== undefined
      && createHash('sha256').update(await readFile(new URL(spec.native.moduleUrl))).digest('hex') !== spec.native.configuration.workerModuleSha256) {
      throw new Error('NATIVE_WORKER_RUNTIME_INTEGRITY_FAILED');
    }
    const nativeRuntime = await import(spec.native.moduleUrl);
    nativeAuthority = nativeRuntime.createWindowsNativeAuthority(spec.native.configuration);
    nativeInvocation = await nativeAuthority.prepare({
      directory: spec.native.directory, binding: spec.native.binding,
      executable: spec.executable, args: spec.arguments, cwd: spec.cwd, timeoutMs: spec.timeoutMs,
      environment: childEnvironment, windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
    });
  }
  child = spawn(nativeInvocation?.executable ?? spec.executable, [...(nativeInvocation?.args ?? spec.arguments)], {
    cwd: spec.cwd,
    env: nativeInvocation?.environment ?? childEnvironment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...(nativeInvocation || spec.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: spec.windowsVerbatimArguments }),
  });
  metadata.child_pid = child.pid;
  child.stdout?.on('data', (chunk) => { appendBounded(stdoutHandle, chunk, 'stdout'); });
  child.stderr?.on('data', (chunk) => { appendBounded(stderrHandle, chunk, 'stderr'); });
  child.once('close', () => { posixPipesClosed = true; });
  child.once('error', (error) => { void finish('failed', -1, 'Local task failed to start: ' + error.message); });
  child.once('exit', (code) => {
    if (spec.posix) {
      posixRootExit = code ?? -1;
      void finish(code === 0 ? 'completed' : 'failed', code ?? -1);
      return;
    }
    if (stopTarget || settled) return;
    if (timer) clearTimeout(timer);
    void (async () => {
      // Prefer the child's close event because it fires only after direct-child
      // stdio has drained. A detached descendant can inherit those pipes and
      // postpone close indefinitely, so bound that wait before severing only
      // our read ends and completing on the direct child lifecycle.
      await new Promise((resolve) => {
        const directChild = child;
        if (!directChild) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(drainTimer);
          directChild.off('close', done);
          resolve();
        };
        const drainTimer = setTimeout(done, 250);
        directChild.once('close', done);
      });
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      await finish(code === 0 ? 'completed' : 'failed', code ?? -1);
    })();
  });
  if (spec.posix) {
    await persist();
    posixControlTimer = setInterval(() => {
      if (settled || posixControlBusy) return;
      posixControlBusy = true;
      void (async () => {
        const cancelled = await readFile(spec.posix.cancelPath, 'utf8').then(() => true, () => false);
        if (cancelled && !stopTarget) {
          stopTarget = 'cancelled';
          metadata.posix_stop_target = stopTarget;
          await persist();
          if (child?.pid) await stopTree(child.pid);
        }
        if (posixRootExit !== undefined || stopTarget) await finish(stopTarget ?? 'completed', posixRootExit ?? -1);
      })().catch(() => undefined).finally(() => { posixControlBusy = false; });
    }, 100);
  }
  if (nativeInvocation) {
    const start = await nativeInvocation.connect(child);
    if (!settled) {
      if (start.state === 'running') metadata.state = 'running';
      else if (start.state === 'terminal_verified' || start.state === 'launch_not_started') await finish('completed', 0);
      else { metadata.state = 'termination_unverified'; metadata.error = start.reason; }
    }
  }
  metadata.child_started_at = child.pid ? await processStartedAt(child.pid) : null;
  if (metadata.child_started_at === null) delete metadata.child_started_at;
  if (!settled) await persist();
  if (!settled && !spec.native) timer = setTimeout(() => {
    void (async () => {
      if (settled || !child?.pid) return;
      stopTarget = 'timed_out';
      if (spec.posix) { metadata.posix_stop_target = stopTarget; await persist(); }
      const stopped = await stopTree(child.pid);
      await finish(stopped ? 'timed_out' : 'termination_unverified', -1, stopped ? 'Local task timed out' : 'Local task timed out, but process termination could not be verified');
    })();
  }, spec.timeoutMs);
} catch (error) {
  await finish('failed', -1, 'Local task failed to start: ' + (error instanceof Error ? error.message : String(error)));
}
`;

export function durableShellNativeBinding(request: DurableShellLaunchRequest, requestDigest = durableShellRequestDigest(request)): NativeAttemptBinding {
  if (request.owner.workspaceId === undefined) throw new Error('Native containment requires a workspace identity');
  return {
    taskId: request.taskId,
    reservationId: request.taskId,
    attemptId: request.taskId,
    generation: 1,
    requestDigest,
    ownerClientId: request.owner.clientId,
    ownerSessionId: request.owner.sessionId,
    workspaceId: request.owner.workspaceId,
  };
}

export function durableShellRequestDigest(request: DurableShellLaunchRequest): string {
  const canonicalRequest = {
    version: 1,
    task_id: request.taskId,
    executable: request.executable,
    arguments: [...request.arguments],
    cwd: request.cwd,
    windows_verbatim_arguments: request.windowsVerbatimArguments ?? null,
    timeout_seconds: request.timeoutSeconds,
    max_output_bytes: request.maxOutputBytes,
    include_stdout: request.includeStdout,
    include_stderr: request.includeStderr,
    owner_client_id: request.owner.clientId,
    owner_workspace_id: request.owner.workspaceId ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonicalRequest)).digest('hex');
}

function normalizeMaxConcurrentTasks(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_DURABLE_TASKS;
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error('maxConcurrentTasks must be between 1 and 128');
  return value;
}

function isSafeTaskId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
