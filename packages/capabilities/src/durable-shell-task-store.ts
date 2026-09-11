import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { appError, err, ok, type GoalTaskCancellationObservation, type Result } from '@lnwjud/domain';
import { capabilityTaskOwnerMatches, legacyCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

export type DurableShellTaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified';

export interface DurableShellLaunchRequest {
  readonly taskId: string;
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
  readonly version: 1;
  readonly task_id: string;
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
  readonly owner_client_id?: string;
  readonly owner_session_id?: string;
  readonly owner_workspace_id?: string;
}

interface DurableWorkerSpec {
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
}

const METADATA_FILENAME = 'task.json';
const STDOUT_FILENAME = 'stdout.log';
const STDERR_FILENAME = 'stderr.log';
const SPEC_FILENAME = 'spec.json';
const WORKER_PID_FILENAME = 'worker.pid';
const WORKER_STARTED_FILENAME = 'worker.started';
const METADATA_READ_RETRIES = 4;
const PROCESS_EXIT_RECONCILE_DELAY_MS = 75;
const PROCESS_HANDLE_RELEASE_GRACE_MS = 150;
// Host process identity probes start a second PowerShell/`ps` process. Under
// a busy desktop test run that probe can be delayed even though the durable
// worker is healthy. Keep the startup window finite (so a genuinely
// unverifiable long-lived process still fails closed) but wide enough not to
// turn normal short-lived tasks into false `termination_unverified` results.
const PROCESS_IDENTITY_CAPTURE_GRACE_MS = 10_000;
const execFileAsync = promisify(execFile);

export interface DurableShellTaskStoreOptions {
  readonly maxConcurrentTasks?: number;
  readonly platform?: NodeJS.Platform;
}

export const DEFAULT_MAX_CONCURRENT_DURABLE_TASKS = 16;

export class DurableShellTaskStore {
  private readonly maxConcurrentTasks: number;
  private readonly platform: NodeJS.Platform;

  public constructor(private readonly rootDirectory: string, options: DurableShellTaskStoreOptions = {}) {
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(options.maxConcurrentTasks);
    this.platform = options.platform ?? process.platform;
  }

  public async launch(request: DurableShellLaunchRequest): Promise<Result<Record<string, unknown>>> {
    const activeTasks = await this.activeTaskCount();
    if (activeTasks >= this.maxConcurrentTasks) {
      return err(appError('CONFLICT', `Too many durable background tasks are already running (${activeTasks}/${this.maxConcurrentTasks}); inspect or stop existing tasks before starting another.`, true));
    }

    const taskDirectory = this.taskDirectory(request.taskId);
    await mkdir(taskDirectory, { recursive: true });
    await mkdir(this.rootDirectory, { recursive: true });
    const startedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + request.timeoutSeconds * 1000).toISOString();
    const metadataPath = path.join(taskDirectory, METADATA_FILENAME);
    const stdoutPath = path.join(taskDirectory, STDOUT_FILENAME);
    const stderrPath = path.join(taskDirectory, STDERR_FILENAME);
    const specPath = path.join(taskDirectory, SPEC_FILENAME);
    const metadata: DurableTaskMetadata = {
      version: 1,
      task_id: request.taskId,
      state: 'running',
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
    };
    try {
      await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
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
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      await waitForSpawn(worker);
      if (worker.pid === undefined) return err(appError('INTERNAL_ERROR', 'Durable task worker did not return a process ID', true));
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
      await writeFile(path.join(taskDirectory, WORKER_PID_FILENAME), String(worker.pid), 'utf8');
      worker.unref();
      return ok(await this.snapshotFromMetadata(metadata));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Durable task could not start';
      metadata.state = 'failed';
      metadata.exit_code = -1;
      metadata.error = `Durable task could not start: ${message}`;
      metadata.finished_at = new Date().toISOString();
      await writeFile(metadataPath, JSON.stringify(metadata), 'utf8').catch(() => undefined);
      return err(appError('INTERNAL_ERROR', 'Durable task could not start', true));
    }
  }

  public async list(owner?: CapabilityTaskOwner): Promise<Record<string, unknown>[]> {
    await mkdir(this.rootDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);
    const snapshots: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshot = await this.snapshot(entry.name, undefined, owner);
      if (snapshot.ok) snapshots.push(snapshot.value);
    }
    return snapshots.sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')));
  }

  public async snapshot(taskId: string, tailLines?: number, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (owner !== undefined && !capabilityTaskOwnerMatches(metadataOwner(metadata.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    const reconciled = await this.reconcile(metadata.value);
    return ok(await this.snapshotFromMetadata(reconciled, tailLines));
  }

  /** Trusted read-only host probe scoped to the durable goal's workspace. */
  public async snapshotForGoalLiveness(taskId: string, workspaceId: string): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (metadataOwner(metadata.value).workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Task belongs to another or unknown workspace'));
    }
    const reconciled = await this.reconcile(metadata.value);
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

    const before = await this.reconcile(metadataResult.value);
    if (isTerminal(before.state)) {
      return ok({ matched: true, state: 'already_terminal', detail: before.state });
    }
    const cancelled = await this.cancel(taskId, storedOwner);
    if (!cancelled.ok) return cancelled;
    const state = cancelled.value.state;
    if (state === 'cancelled') return ok({ matched: true, state: 'cancelled' });
    if (isTerminalValue(state)) return ok({ matched: true, state: 'already_terminal', detail: state });
    return ok({ matched: true, state: 'termination_unverified', detail: typeof state === 'string' ? state : 'unknown' });
  }

  public async wait(taskId: string, seconds: number, tailLines?: number, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    let snapshot = await this.snapshot(taskId, tailLines, owner);
    while (snapshot.ok && snapshot.value.state === 'running' && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(10, deadline - Date.now())));
      snapshot = await this.snapshot(taskId, tailLines, owner);
    }
    return snapshot;
  }

  public async cancel(taskId: string, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadataResult = await this.readMetadata(taskId);
    if (!metadataResult.ok) return metadataResult;
    if (owner !== undefined && !capabilityTaskOwnerMatches(metadataOwner(metadataResult.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    let metadata = await this.reconcile(metadataResult.value);
    if (isTerminal(metadata.state)) return ok(await this.snapshotFromMetadata(metadata));
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
    return ok(await this.snapshotFromMetadata(metadata));
  }

  public async has(taskId: string): Promise<boolean> {
    return (await this.readMetadata(taskId)).ok;
  }

  private async activeTaskCount(): Promise<number> {
    const tasks = await this.list();
    return tasks.filter((task) => task.state === 'running' || task.state === 'termination_unverified').length;
  }

  private async reconcile(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    if (metadata.state !== 'running' && metadata.state !== 'termination_unverified') return metadata;
    const workerPid = metadata.worker_pid;
    if (workerPid !== undefined) {
      const workerProbe = await probeProcessIdentity(workerPid, this.platform);
      if (isTrackedProcessLive(workerProbe, metadata.worker_started_at)) return metadata;
      if (identityCapturePendingForProbe(workerProbe, metadata.worker_started_at, metadata.started_at)) return metadata;
      if (isUnverifiableTrackedProbe(workerProbe, metadata.worker_started_at)) {
        metadata.state = 'termination_unverified';
        metadata.error = metadata.error ?? describeTrackedProbe('worker', workerProbe);
        delete metadata.finished_at;
        await this.writeMetadata(metadata);
        return metadata;
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
        current.state = 'termination_unverified';
        current.error = current.error ?? describeTrackedProbe('worker', refreshedWorkerProbe);
        delete current.finished_at;
        await this.writeMetadata(current);
        return current;
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
    current.state = 'failed';
    current.exit_code = current.exit_code ?? -1;
    current.error = current.error ?? 'Durable task worker exited before recording a final state';
    current.finished_at = current.finished_at ?? new Date().toISOString();
    await this.writeMetadata(current);
    return current;
  }

  private async snapshotFromMetadata(metadata: DurableTaskMetadata, tailLines?: number): Promise<Record<string, unknown>> {
    const taskDirectory = this.taskDirectory(metadata.task_id);
    const stdout = metadata.include_stdout ? await readBoundedText(path.join(taskDirectory, STDOUT_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
    const stderr = metadata.include_stderr ? await readBoundedText(path.join(taskDirectory, STDERR_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
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

  private async readMetadata(taskId: string): Promise<Result<DurableTaskMetadata>> {
    const metadataPath = path.join(this.taskDirectory(taskId), METADATA_FILENAME);
    for (let attempt = 0; attempt < METADATA_READ_RETRIES; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (isMetadata(parsed) && parsed.task_id === taskId) {
          if (parsed.worker_pid === undefined) {
            const publishedPid = await readPublishedPid(path.join(this.taskDirectory(taskId), WORKER_PID_FILENAME));
            if (publishedPid !== undefined) parsed.worker_pid = publishedPid;
          }
          if (parsed.worker_started_at === undefined) {
            const publishedStartedAt = await readPublishedStartedAt(path.join(this.taskDirectory(taskId), WORKER_STARTED_FILENAME));
            if (publishedStartedAt !== undefined) parsed.worker_started_at = publishedStartedAt;
          }
          return ok(parsed);
        }
      } catch {
        if (attempt === METADATA_READ_RETRIES - 1) break;
      }
      await delay(15);
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private async writeMetadata(metadata: DurableTaskMetadata): Promise<void> {
    await writeFile(path.join(this.taskDirectory(metadata.task_id), METADATA_FILENAME), JSON.stringify(metadata), 'utf8');
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
    for (let attempt = 0; attempt < 12; attempt += 1) {
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
      await delay(25);
    }
    return metadata;
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
  return record.version === 1
    && typeof record.task_id === 'string'
    && typeof record.state === 'string'
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

function metadataOwner(metadata: DurableTaskMetadata): CapabilityTaskOwner {
  if (metadata.owner_client_id === undefined || metadata.owner_session_id === undefined) return legacyCapabilityTaskOwner();
  return {
    clientId: metadata.owner_client_id,
    sessionId: metadata.owner_session_id,
    ...(metadata.owner_workspace_id === undefined ? {} : { workspaceId: metadata.owner_workspace_id }),
  };
}

function isTerminal(state: DurableShellTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

function isTerminalValue(value: unknown): value is DurableShellTaskState {
  return typeof value === 'string' && isTerminal(value as DurableShellTaskState);
}

async function readBoundedText(filename: string, maxBytes: number, tailLines?: number): Promise<string> {
  let value = '';
  try {
    const buffer = await readFile(filename);
    value = buffer.subarray(0, maxBytes).toString('utf8');
  } catch {
    return '';
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
      ], { windowsHide: true, encoding: 'utf8', timeout: 3_500, maxBuffer: 16 * 1024 });
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
  return probe.state === 'unverifiable' || (probe.state === 'live' && (expectedStartedAt === undefined || probe.processStartedAt !== expectedStartedAt));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DURABLE_WORKER_SOURCE = String.raw`import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const specPath = process.argv[2];
if (!specPath) process.exit(64);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
await unlink(specPath).catch(() => undefined);
let metadata = JSON.parse(await readFile(spec.metadataPath, 'utf8'));
metadata.worker_pid = process.pid;
await persist();
let stdoutBytes = 0;
let stderrBytes = 0;
const stdoutHandle = await open(spec.stdoutPath, 'a');
const stderrHandle = await open(spec.stderrPath, 'a');
let settled = false;
let timer;
let child;
let stopTarget;
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
  void pending.then(() => pendingWrites.delete(pending), () => pendingWrites.delete(pending));
}

async function persist() {
  await writeFile(spec.metadataPath, JSON.stringify(metadata), 'utf8');
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
      ], { windowsHide: true, encoding: 'utf8', timeout: 1750, maxBuffer: 16384 });
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

async function finish(state, exitCode, error) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  metadata.state = state;
  metadata.exit_code = exitCode;
  if (error) metadata.error = error;
  else delete metadata.error;
  if (state === 'termination_unverified') delete metadata.finished_at;
  else metadata.finished_at = new Date().toISOString();
  await Promise.allSettled([...pendingWrites]);
  await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
  await persist().catch(() => undefined);
}

try {
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  child = spawn(spec.executable, [...spec.arguments], {
    cwd: spec.cwd,
    env: childEnvironment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...(spec.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: spec.windowsVerbatimArguments }),
  });
  metadata.child_pid = child.pid;
  child.stdout?.on('data', (chunk) => { appendBounded(stdoutHandle, chunk, 'stdout'); });
  child.stderr?.on('data', (chunk) => { appendBounded(stderrHandle, chunk, 'stderr'); });
  child.once('error', (error) => { void finish('failed', -1, 'Local task failed to start: ' + error.message); });
  child.once('exit', (code) => {
    if (stopTarget || settled) return;
    if (timer) clearTimeout(timer);
    void (async () => {
      // The direct command is the durable task boundary. A detached descendant
      // may inherit stdout/stderr and keep Node's child close event pending
      // indefinitely after the command itself has already exited. Give queued
      // output one event-loop turn to drain, then sever only our read ends so
      // task completion follows the direct child lifecycle instead of pipe EOF.
      await new Promise((resolve) => setImmediate(resolve));
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      await finish(code === 0 ? 'completed' : 'failed', code ?? -1);
    })();
  });
  metadata.child_started_at = child.pid ? await processStartedAt(child.pid) : null;
  if (metadata.child_started_at === null) delete metadata.child_started_at;
  if (!settled) await persist();
  if (!settled) timer = setTimeout(() => {
    void (async () => {
      if (settled || !child?.pid) return;
      stopTarget = 'timed_out';
      const stopped = await stopTree(child.pid);
      await finish(stopped ? 'timed_out' : 'termination_unverified', -1, stopped ? 'Local task timed out' : 'Local task timed out, but process termination could not be verified');
    })();
  }, spec.timeoutMs);
} catch (error) {
  await finish('failed', -1, 'Local task failed to start: ' + (error instanceof Error ? error.message : String(error)));
}
`;

function normalizeMaxConcurrentTasks(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_DURABLE_TASKS;
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error('maxConcurrentTasks must be between 1 and 128');
  return value;
}
