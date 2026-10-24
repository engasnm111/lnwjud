import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { WindowsContainedLaunch, WindowsContainedLaunchInput } from './windows-contained-launch.js';

export interface NativeAttemptBinding {
  readonly taskId: string; readonly reservationId: string; readonly attemptId: string; readonly generation: number;
  readonly requestDigest: string; readonly ownerClientId: string; readonly ownerSessionId: string; readonly workspaceId: string;
}
export interface WindowsNativeAuthorityConfiguration {
  readonly helper: { readonly executable: string; readonly sha256: string; readonly buildId: string };
  readonly pin: { readonly modulePath: string; readonly sha256: string };
  /** Legacy composition metadata; never used as process authority. */
  readonly profileDirectory?: string;
  readonly workerModulePath?: string;
  readonly workerModuleSha256?: string;
}
export type WindowsNativeAuthorityConfig = WindowsNativeAuthorityConfiguration;
interface StaleTunnelAliasCleanupLocation {
  readonly stateRoot: string;
  readonly alias: 'lnwjud';
  readonly profileDirectory: string;
}
export type StaleTunnelAliasCleanupRequest = StaleTunnelAliasCleanupLocation & ({
  readonly recoveryOnly: true;
} | {
  readonly recoveryOnly?: false;
  readonly expectedTunnelId: string;
  readonly expectedPid: number;
  readonly expectedAliasesSha256: string;
  readonly expectedProcessesSha256: string;
});
export type NativeProcessObservation =
  | { readonly state: 'launch_not_started'; readonly binding: NativeAttemptBinding }
  | { readonly state: 'running'; readonly binding: NativeAttemptBinding; readonly targetPid: number }
  | { readonly state: 'terminal_verified'; readonly binding: NativeAttemptBinding; readonly outcome: 'completed' | 'cancelled' | 'timed_out' | 'interrupted'; readonly exitCode: number; readonly activeProcesses: 0 }
  | { readonly state: 'termination_unknown'; readonly binding: NativeAttemptBinding; readonly reason: string };
export type NativeControlCommand = 'prepare_import' | 'publish_import' | 'inspect_publication';
export type NativeControlObservation =
  | { readonly state: 'control_verified'; readonly binding: NativeAttemptBinding; readonly command: NativeControlCommand; readonly result: unknown }
  | { readonly state: 'termination_unknown'; readonly binding: NativeAttemptBinding; readonly reason: string };

export interface NativeServiceProcessOperation {
  readonly kind: 'run_process'; readonly executable: string; readonly args: readonly string[]; readonly cwd: string;
  readonly timeoutMs: number; readonly windowsVerbatimArguments: boolean; readonly environment: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
}
export interface NativeOutputCursor { readonly stdoutOffset: number; readonly stderrOffset: number }
export type NativeOutputRead =
  | { readonly state: 'unavailable'; readonly binding: NativeAttemptBinding; readonly reason: string }
  | {
    readonly state: 'available'; readonly binding: NativeAttemptBinding;
    readonly stdout: Buffer; readonly stderr: Buffer; readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean;
    readonly complete: boolean; readonly nextCursor: NativeOutputCursor; readonly finalCursor: NativeOutputCursor | null;
    readonly persistence: { readonly state: 'persisted' } | { readonly state: 'unavailable'; readonly reason: string };
  };
export interface NativeAttemptHandle {
  readonly binding: NativeAttemptBinding;
  observe(): Promise<NativeProcessObservation>;
  cancel(): Promise<NativeProcessObservation>;
  abortBeforeDispatch(): Promise<NativeProcessObservation>;
  readOutput(cursor: NativeOutputCursor): Promise<NativeOutputRead>;
}
export interface NativeProcessSubmission { readonly handle: NativeAttemptHandle; readonly observation: NativeProcessObservation }
export interface NativeProcessRequest {
  readonly binding: NativeAttemptBinding; readonly executable: string; readonly args: readonly string[]; readonly cwd: string;
  readonly timeoutMs: number; readonly windowsVerbatimArguments?: boolean; readonly environment?: NodeJS.ProcessEnv;
  readonly maximumOutputBytes?: number; readonly signal?: AbortSignal;
}
export type WindowsContainmentRpcRequest = { readonly protocol: 3; readonly identity: NativeAttemptBinding } & (
  | { readonly command: 'prepare' | 'run'; readonly operation: NativeServiceProcessOperation; readonly reservationKey?: string; readonly operationDigest?: string }
  | { readonly command: 'inspect' | 'cancel' }
  | { readonly command: 'read_output'; readonly outputCursor?: NativeOutputCursor }
  | ({ readonly command: 'abort'; readonly reservationKey: string } & (
    | { readonly operation: NativeServiceProcessOperation; readonly operationDigest?: never }
    | { readonly operationDigest: string; readonly operation?: never }))
  | { readonly command: 'control'; readonly controlCommand: NativeControlCommand; readonly controlRequest: unknown }
  | { readonly command: 'inspect_control'; readonly controlCommand: NativeControlCommand }
);
export interface WindowsContainmentServiceClient {
  request<T = unknown>(request: WindowsContainmentRpcRequest): Promise<T>;
  startWatcher(child: ChildProcess, identity: NativeAttemptBinding): Promise<void>;
}
interface AttemptLocation { readonly directory?: string; readonly binding: NativeAttemptBinding }
const BINDING_FIELDS = ['taskId', 'reservationId', 'attemptId', 'generation', 'requestDigest', 'ownerClientId', 'ownerSessionId', 'workspaceId'] as const;
const MAX_RPC_BYTES = 1024 * 1024;

export function createWindowsNativeAuthority(configuration: WindowsNativeAuthorityConfiguration, client?: WindowsContainmentServiceClient): WindowsNativeAuthority {
  return new WindowsNativeAuthority(configuration, client);
}

/** Host-created authority. Process state and terminal proof come only from the installed SCM service. */
export class WindowsNativeAuthority {
  private readonly client: WindowsContainmentServiceClient;
  private readonly injectedClient: boolean;
  private readonly submissions = new Map<string, { readonly binding: NativeAttemptBinding; readonly fingerprint: string; readonly promise: Promise<NativeProcessSubmission> }>();
  public constructor(public readonly configuration: WindowsNativeAuthorityConfiguration, client?: WindowsContainmentServiceClient) {
    if (!path.isAbsolute(configuration.helper.executable)
      || !/^[a-f0-9]{64}$/i.test(configuration.helper.sha256) || configuration.helper.buildId !== 'lnwjud-containment-v2'
      || !path.isAbsolute(configuration.pin.modulePath) || !/^[a-f0-9]{64}$/i.test(configuration.pin.sha256)) throw new Error('NATIVE_TRUST_CONFIG_INVALID');
    this.injectedClient = client !== undefined;
    this.client = client ?? new ProcessWindowsContainmentServiceClient(configuration);
  }
  public get config(): WindowsNativeAuthorityConfiguration { return this.configuration; }

  public async clearStaleTunnelAlias(request: StaleTunnelAliasCleanupRequest): Promise<void> {
    if (process.platform !== 'win32') throw new Error('TUNNEL_STALE_WINDOWS_REQUIRED');
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    if (payload.length > 16 * 1024) throw new Error('TUNNEL_STALE_REQUEST_TOO_LARGE');
    const pinned = await pinVerifiedHelper(this.configuration);
    const child = spawn(this.configuration.helper.executable, ['clear-stale-tunnel-alias'], {
      windowsHide: true, shell: false, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let complete = false;
    try {
      const output: Buffer[] = [];
      let outputBytes = 0;
      let overflow = false;
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 16 * 1024) { overflow = true; child.kill(); return; }
        output.push(Buffer.from(chunk));
      });
      child.stderr.resume();
      const completion = childCompletion(child, 15_000);
      child.stdin.on('error', (): void => undefined);
      child.stdin.end(payload);
      const exitCode = await completion;
      complete = true;
      if (overflow || outputBytes === 0) throw new Error('TUNNEL_STALE_RESPONSE_INVALID');
      const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
      if (!isRecord(result)) throw new Error('TUNNEL_STALE_RESPONSE_INVALID');
      if (exitCode !== 0 || result.ok !== true) {
        throw new Error(typeof result.error === 'string' && /^TUNNEL_STALE_[A-Z_]+$/.test(result.error)
          ? result.error : 'TUNNEL_STALE_CLEANUP_FAILED');
      }
      if (request.recoveryOnly === true && result.recovered === false) return;
      if (typeof result.processesSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(result.processesSha256)
        || typeof result.aliasesSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(result.aliasesSha256)) {
        throw new Error('TUNNEL_STALE_RESPONSE_INVALID');
      }
    } finally {
      if (!complete) child.kill();
      pinned.close();
    }
  }

  public attachProcess(input: NativeAttemptBinding): NativeAttemptHandle {
    const binding = parseNativeAttemptBinding(input);
    if (binding === undefined) throw new Error('NATIVE_BINDING_INVALID');
    Object.freeze(binding);
    return Object.freeze({
      binding,
      observe: (): Promise<NativeProcessObservation> => this.inspect({ binding }),
      cancel: (): Promise<NativeProcessObservation> => this.cancel({ binding }),
      abortBeforeDispatch: (): Promise<NativeProcessObservation> => this.abortBeforeLaunch({ binding }),
      readOutput: (cursor: NativeOutputCursor): Promise<NativeOutputRead> => this.readAttemptOutput(binding, cursor),
    });
  }

  public async submitProcess(input: NativeProcessRequest): Promise<NativeProcessSubmission> {
    const handle = this.attachProcess(input.binding);
    const operation = processOperation(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    const previous = this.submissions.get(handle.binding.attemptId);
    if (previous !== undefined) {
      if (!sameBinding(previous.binding, handle.binding) || previous.fingerprint !== fingerprint) return Promise.reject(new Error('NATIVE_ATTEMPT_CONFLICT'));
      return previous.promise;
    }
    const promise = this.submitOwnedAttempt(handle, operation, input.signal);
    this.submissions.set(handle.binding.attemptId, { binding: handle.binding, fingerprint, promise });
    return promise;
  }

  private async submitOwnedAttempt(handle: NativeAttemptHandle, operation: NativeServiceProcessOperation, signal?: AbortSignal): Promise<NativeProcessSubmission> {
    const identity = handle.binding;
    try {
      if (submissionAborted(signal)) return { handle, observation: await this.abortBeforeLaunch({ binding: identity, operation }) };
      const prepared = await this.client.request<unknown>({ protocol: 3, command: 'prepare', identity, reservationKey: 'global-managed-writers', operation });
      if (!isPreparedObservation(prepared, identity)) return { handle, observation: toObservation(prepared, identity) };
      if (submissionAborted(signal)) return { handle, observation: await this.abortBeforeLaunch({ binding: identity, operation }) };
      const result = await this.client.request<unknown>({ protocol: 3, command: 'run', identity, operation });
      return { handle, observation: toObservation(result, identity) };
    } catch (error: unknown) {
      if (error instanceof Error && /^(?:ATTEMPT_ID_CONFLICT|SERVICE_OPERATION_DIGEST_MISMATCH)$/.test(error.message)) throw error;
      return { handle, observation: unknown(identity, serviceFailureCode(error, 'NATIVE_SERVICE_SUBMISSION_UNRESOLVED')) };
    }
  }

  private async readAttemptOutput(binding: NativeAttemptBinding, cursor: NativeOutputCursor): Promise<NativeOutputRead> {
    if (!isOutputCursor(cursor)) return { state: 'unavailable', binding, reason: 'NATIVE_OUTPUT_CURSOR_INVALID' };
    const requested = { stdoutOffset: cursor.stdoutOffset, stderrOffset: cursor.stderrOffset };
    try {
      const value = await this.client.request<unknown>({ protocol: 3, command: 'read_output', identity: binding, outputCursor: requested });
      return parseAttemptOutput(value, binding, requested);
    } catch { return { state: 'unavailable', binding, reason: 'NATIVE_SERVICE_OUTPUT_UNAVAILABLE' }; }
  }

  public async prepare(input: Omit<WindowsContainedLaunchInput, 'authority' | 'binding'> & { readonly binding: NativeAttemptBinding }): Promise<WindowsContainedLaunch> {
    if (!path.isAbsolute(input.directory) || !path.isAbsolute(input.executable) || !path.isAbsolute(input.cwd)
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 604_800_000
      || input.args.some((arg) => arg.includes('\0'))) throw new Error('NATIVE_PROCESS_REQUEST_INVALID');
    validateBinding(input.binding);
    const operation: NativeServiceProcessOperation = {
      kind: 'run_process', executable: input.executable, args: [...input.args], cwd: input.cwd,
      timeoutMs: input.timeoutMs, windowsVerbatimArguments: input.windowsVerbatimArguments === true,
      environment: definedEnvironment(input.environment ?? process.env),
      maximumOutputBytes: 128 * 1024,
    };
    const reservationKey = 'global-managed-writers';
    let pinned: ExecutablePin = { close: (): void => undefined };
    if (!this.injectedClient) pinned = await pinVerifiedHelper(this.config);
    let disposed = false;
    const releasePin = (): void => { if (disposed) return; disposed = true; pinned.close(); };
    try {
      const prepared = await this.client.request<unknown>({ protocol: 3, command: 'prepare', identity: input.binding, reservationKey, operation });
      if (!isPreparedObservation(prepared, input.binding)) throw new Error('NATIVE_SERVICE_PREPARE_UNVERIFIED');
      let connected = false;
      return {
        executable: this.config.helper.executable, args: ['service-watch', this.config.helper.sha256.toLowerCase()],
        environment: helperEnvironment(),
        connect: async (child): Promise<NativeProcessObservation> => {
          if (connected) throw new Error('NATIVE_ATTEMPT_ALREADY_CONNECTED');
          connected = true;
          try {
            await this.client.startWatcher(child, input.binding);
            const response = await this.client.request<unknown>({ protocol: 3, command: 'run', identity: input.binding, operation });
            const observation = toObservation(response, input.binding);
            if (observation.state === 'launch_not_started' || observation.state === 'termination_unknown') child.stdin?.end();
            return observation;
          } catch (error: unknown) {
            child.stdin?.destroy();
            // Never turn a failed/ambiguous native dispatch into terminal proof. Preserve
            // only service-issued symbolic error codes; OS errors may contain private paths.
            return unknown(input.binding, serviceFailureCode(error, 'NATIVE_SERVICE_START_UNRESOLVED'));
          } finally { releasePin(); }
        },
        inspect: () => this.inspect(input),
        cancel: () => this.cancel(input),
        abortBeforeLaunch: () => this.abortBeforeLaunch({ directory: input.directory, binding: input.binding, operation }),
        dispose: releasePin,
      };
    } catch (error) { releasePin(); throw error; }
  }

  public async inspect(input: AttemptLocation): Promise<NativeProcessObservation> {
    try {
      validateBinding(input.binding);
      return toObservation(await this.client.request<unknown>({ protocol: 3, command: 'inspect', identity: input.binding }), input.binding);
    } catch { return unknown(input.binding, 'NATIVE_SERVICE_PROOF_UNAVAILABLE'); }
  }

  public async cancel(input: AttemptLocation): Promise<NativeProcessObservation> {
    try {
      validateBinding(input.binding);
      const initial = toObservation(await this.client.request<unknown>({ protocol: 3, command: 'cancel', identity: input.binding }), input.binding);
      if (initial.state === 'terminal_verified' || initial.state === 'launch_not_started') return initial;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const observation = await this.inspect(input);
        if (observation.state === 'terminal_verified' || observation.state === 'launch_not_started') return observation;
        await delay(50);
      }
    } catch { return unknown(input.binding, 'NATIVE_SERVICE_CANCEL_UNRESOLVED'); }
    return unknown(input.binding, 'NATIVE_TERMINATION_PROOF_UNAVAILABLE');
  }

  /** The service records an abort before preparation so a later prepare cannot replay the attempt. */
  public async abortBeforeLaunch(input: AttemptLocation & { readonly operation?: NativeServiceProcessOperation }): Promise<NativeProcessObservation> {
    try {
      validateBinding(input.binding);
      const request: WindowsContainmentRpcRequest = input.operation === undefined
        ? {
          protocol: 3, command: 'abort', identity: input.binding, reservationKey: 'global-managed-writers',
          operationDigest: input.binding.requestDigest.toLowerCase(),
        }
        : {
          protocol: 3, command: 'abort', identity: input.binding, reservationKey: 'global-managed-writers',
          operation: input.operation,
        };
      return toObservation(await this.client.request<unknown>(request), input.binding);
    } catch { return unknown(input.binding, 'NATIVE_PRELAUNCH_ABORT_UNVERIFIED'); }
  }

  public async control(input: AttemptLocation & { readonly command: NativeControlCommand; readonly request: unknown }): Promise<NativeControlObservation> {
    try {
      validateBinding(input.binding);
      const value = await this.client.request<unknown>({ protocol: 3, command: 'control', identity: input.binding,
        controlCommand: input.command, controlRequest: input.request });
      return toControlObservation(value, input.binding, input.command, isRecord(input.request) ? input.request.commit : undefined);
    } catch { return unknown(input.binding, 'NATIVE_SERVICE_CONTROL_UNVERIFIED'); }
  }
  public async inspectControl(input: AttemptLocation & { readonly command: NativeControlCommand }): Promise<NativeControlObservation> {
    try {
      validateBinding(input.binding);
      return toControlObservation(await this.client.request<unknown>({ protocol: 3, command: 'inspect_control', identity: input.binding,
        controlCommand: input.command }), input.binding, input.command);
    } catch { return unknown(input.binding, 'NATIVE_SERVICE_CONTROL_PROOF_UNAVAILABLE'); }
  }
}

class ProcessWindowsContainmentServiceClient implements WindowsContainmentServiceClient {
  public constructor(private readonly configuration: WindowsNativeAuthorityConfiguration) {}
  public async request<T>(request: WindowsContainmentRpcRequest): Promise<T> {
    if (process.platform !== 'win32') throw new Error('NATIVE_WINDOWS_REQUIRED');
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    if (payload.length > MAX_RPC_BYTES) throw new Error('NATIVE_SERVICE_REQUEST_TOO_LARGE');
    const pinned = await pinVerifiedHelper(this.configuration);
    const child = spawn(this.configuration.helper.executable, ['service-rpc', this.configuration.helper.sha256.toLowerCase()], {
      windowsHide: true, shell: false, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.stdout === null) { pinned.close(); throw new Error('NATIVE_SERVICE_STDOUT_UNAVAILABLE'); }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RPC_BYTES) { overflow = true; child.kill(); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    let completed = false;
    try {
      // A Windows service process launch can incur antivirus/profile activation
      // latency. Bound run separately from short observation RPCs; failure
      // remains termination_unknown and never authorizes a duplicate launch.
      const completion = childCompletion(child, request.command === 'control' ? 120_000 : request.command === 'run' ? 40_000 : 15_000);
      await writePrivateFrame(child, payload, true);
      const exitCode = await completion;
      completed = true;
      if (overflow || outputBytes === 0 || exitCode !== 0) throw new Error('NATIVE_SERVICE_RPC_FAILED');
      const envelope: unknown = JSON.parse(Buffer.concat(chunks, outputBytes).toString('utf8'));
      if (!isRecord(envelope) || envelope.protocol !== 3 || typeof envelope.ok !== 'boolean') throw new Error('NATIVE_SERVICE_RESPONSE_INVALID');
      if (!envelope.ok) throw new Error(typeof envelope.error === 'string' ? envelope.error : 'NATIVE_SERVICE_RPC_FAILED');
      if (!Object.hasOwn(envelope, 'result')) throw new Error('NATIVE_SERVICE_RESPONSE_INVALID');
      return envelope.result as T;
    } finally { if (!completed) child.kill(); pinned.close(); }
  }
  public startWatcher(child: ChildProcess, identity: NativeAttemptBinding): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ protocol: 3, command: 'watch', identity }), 'utf8');
    if (payload.length > MAX_RPC_BYTES) return Promise.reject(new Error('NATIVE_SERVICE_REQUEST_TOO_LARGE'));
    return writePrivateFrame(child, payload, false);
  }
}

interface ExecutablePin { close(): void }
const requireNative = createRequire(import.meta.url);
async function pinVerifiedHelper(config: WindowsNativeAuthorityConfiguration): Promise<ExecutablePin> {
  await assertPlainPath(config.pin.modulePath, false);
  if (createHash('sha256').update(await readFile(config.pin.modulePath)).digest('hex') !== config.pin.sha256.toLowerCase()) throw new Error('NATIVE_PIN_BOOTSTRAP_INTEGRITY_FAILED');
  const loaded: unknown = requireNative(config.pin.modulePath);
  if (!isRecord(loaded) || typeof loaded.pinExecutable !== 'function') throw new Error('NATIVE_PIN_BOOTSTRAP_INVALID');
  const nativePin: unknown = loaded.pinExecutable(path.normalize(config.helper.executable));
  if (!isRecord(nativePin) || typeof nativePin.close !== 'function') throw new Error('NATIVE_PIN_BOOTSTRAP_INVALID');
  const close = nativePin.close;
  const pinned: ExecutablePin = { close: () => { Reflect.apply(close, nativePin, []); } };
  try { await verifyHelper(config); return pinned; } catch (error) { pinned.close(); throw error; }
}
async function verifyHelper(config: WindowsNativeAuthorityConfiguration): Promise<void> {
  await assertPlainPath(config.helper.executable, false);
  if (createHash('sha256').update(await readFile(config.helper.executable)).digest('hex') !== config.helper.sha256.toLowerCase()) throw new Error('NATIVE_HELPER_INTEGRITY_FAILED');
}
async function assertPlainPath(filename: string, directory: boolean): Promise<void> {
  if (!path.isAbsolute(filename)) throw new Error('NATIVE_ABSOLUTE_PATH_REQUIRED');
  let current = path.resolve(filename); let first = true;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (first && !directory ? !info.isFile() : !info.isDirectory())) throw new Error('NATIVE_REPARSE_PATH_REFUSED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    first = false;
  }
}
export function parseNativeAttemptBinding(value: unknown): NativeAttemptBinding | undefined {
  if (!isRecord(value) || Object.keys(value).length !== BINDING_FIELDS.length || !isInteger(value.generation) || value.generation < 1
    || typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestDigest)) return undefined;
  const strings = ['taskId', 'reservationId', 'attemptId', 'ownerClientId', 'ownerSessionId', 'workspaceId'] as const;
  if (strings.some((field) => typeof value[field] !== 'string' || value[field].length < 1 || value[field].length > 256 || [...value[field]].some(character => character.charCodeAt(0) < 32))) return undefined;
  if (typeof value.taskId !== 'string' || typeof value.reservationId !== 'string' || typeof value.attemptId !== 'string' || typeof value.ownerClientId !== 'string' || typeof value.ownerSessionId !== 'string' || typeof value.workspaceId !== 'string') return undefined;
  return { taskId: value.taskId, reservationId: value.reservationId, attemptId: value.attemptId, generation: value.generation, requestDigest: value.requestDigest, ownerClientId: value.ownerClientId, ownerSessionId: value.ownerSessionId, workspaceId: value.workspaceId };
}
function validateBinding(binding: NativeAttemptBinding): void { if (parseNativeAttemptBinding(binding) === undefined) throw new Error('NATIVE_BINDING_INVALID'); }
function isPreparedObservation(value: unknown, binding: NativeAttemptBinding): boolean {
  if (!isRecord(value) || value.phase !== 0 || value.reservationHeld !== true) return false;
  const identity = parseNativeAttemptBinding(value.identity);
  return identity !== undefined && sameBinding(identity, binding);
}
function toObservation(value: unknown, binding: NativeAttemptBinding): NativeProcessObservation {
  if (!isRecord(value)) return unknown(binding, 'NATIVE_SERVICE_RESPONSE_INVALID');
  const identity = parseNativeAttemptBinding(value.identity);
  if (identity === undefined || !sameBinding(identity, binding) || !isInteger(value.phase)) return unknown(binding, 'NATIVE_SERVICE_IDENTITY_MISMATCH');
  if (value.phase === 2) return value.reservationHeld === false
    ? { state: 'launch_not_started', binding } : unknown(binding, 'NATIVE_PRELAUNCH_RESERVATION_RETAINED');
  if (value.phase === 3 && isInteger(value.targetPid) && value.targetPid > 0) return { state: 'running', binding, targetPid: value.targetPid };
  if (value.phase === 4) {
    const outcome = value.outcome === 0 ? 'completed' : value.outcome === 1 ? 'cancelled' : value.outcome === 2 ? 'timed_out' : value.outcome === 3 ? 'interrupted' : undefined;
    if (outcome !== undefined && isInteger(value.exitCode) && value.activeProcesses === 0 && value.reservationHeld === false
      && (outcome !== 'interrupted' || value.exitCode === 125))
      return { state: 'terminal_verified', binding, outcome, exitCode: value.exitCode, activeProcesses: 0 };
    return unknown(binding, 'NATIVE_TERMINAL_PROOF_INCOMPLETE');
  }
  if (value.phase === 5) return unknown(binding, safeReason(value.reason) ?? 'NATIVE_SERVICE_TERMINATION_UNKNOWN');
  return unknown(binding, value.phase === 0 ? 'NATIVE_SERVICE_ATTEMPT_NOT_DISPATCHED' : 'NATIVE_SERVICE_DISPATCH_UNVERIFIED');
}
function sameBinding(candidate: NativeAttemptBinding, binding: NativeAttemptBinding): boolean { return BINDING_FIELDS.every((field) => candidate[field] === binding[field]); }
function toControlObservation(value: unknown, binding: NativeAttemptBinding, command: NativeControlCommand, expectedCommit?: unknown): NativeControlObservation {
  if (!isRecord(value) || value.verified !== true || value.command !== command) return unknown(binding, 'NATIVE_SERVICE_CONTROL_RESPONSE_INVALID');
  const identity = parseNativeAttemptBinding(value.identity);
  if (identity === undefined || !sameBinding(identity, binding)) return unknown(binding, 'NATIVE_SERVICE_CONTROL_IDENTITY_MISMATCH');
  const result = value.result;
  if (!isRecord(result) || result.version !== 2 || result.state !== (command === 'prepare_import' ? 'prepared' : 'published')
    || typeof result.nativeIdentity !== 'string' || !/^[0-9A-F]{16}-[0-9A-F]{32}$/.test(result.nativeIdentity)
    || typeof result.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commit)
    || expectedCommit !== undefined && result.commit !== expectedCommit) return unknown(binding, 'NATIVE_SERVICE_CONTROL_PROOF_INVALID');
  return { state: 'control_verified', binding, command, result };
}
function safeReason(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 128 && [...value].every(character => character.charCodeAt(0) >= 32) ? value : undefined; }
function serviceFailureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === 'string' && /^(?:SERVICE|PIPE|WRITER|ATTEMPT|NATIVE|TERMINAL)_[A-Z0-9_]{1,80}$/.test(message)
    ? message : fallback;
}
function processOperation(input: NativeProcessRequest): NativeServiceProcessOperation {
  if (!path.isAbsolute(input.executable) || !path.isAbsolute(input.cwd)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 604_800_000
    || !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || input.maximumOutputBytes !== undefined && (!Number.isSafeInteger(input.maximumOutputBytes) || input.maximumOutputBytes < 0 || input.maximumOutputBytes > 262_144)) throw new Error('NATIVE_PROCESS_REQUEST_INVALID');
  const environment = Object.fromEntries(Object.entries(definedEnvironment(input.environment ?? process.env)).sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({ kind: 'run_process', executable: input.executable, args: Object.freeze([...input.args]), cwd: input.cwd,
    timeoutMs: input.timeoutMs, windowsVerbatimArguments: input.windowsVerbatimArguments === true,
    environment: Object.freeze(environment), maximumOutputBytes: input.maximumOutputBytes ?? 128 * 1024 });
}
function submissionAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function isOutputCursor(value: unknown): value is NativeOutputCursor {
  return isRecord(value) && isInteger(value.stdoutOffset) && value.stdoutOffset >= 0 && value.stdoutOffset <= 262_144
    && isInteger(value.stderrOffset) && value.stderrOffset >= 0 && value.stderrOffset <= 262_144;
}
function outputBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length > 349_528) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value && bytes.length <= 262_144 ? bytes : undefined;
}
function parseAttemptOutput(value: unknown, binding: NativeAttemptBinding, cursor: NativeOutputCursor): NativeOutputRead {
  const invalid: NativeOutputRead = { state: 'unavailable', binding, reason: 'NATIVE_SERVICE_OUTPUT_INVALID' };
  if (!isRecord(value) || !isOutputCursor(value.nextCursor) || typeof value.stdoutTruncated !== 'boolean'
    || typeof value.stderrTruncated !== 'boolean' || typeof value.complete !== 'boolean' || typeof value.persisted !== 'boolean') return invalid;
  const identity = parseNativeAttemptBinding(value.identity);
  if (identity === undefined || !sameBinding(identity, binding)) return invalid;
  const stdout = outputBytes(value.stdoutBase64), stderr = outputBytes(value.stderrBase64);
  if (stdout === undefined || stderr === undefined || cursor.stdoutOffset + stdout.length !== value.nextCursor.stdoutOffset
    || cursor.stderrOffset + stderr.length !== value.nextCursor.stderrOffset) return invalid;
  const persisted = value.persisted && value.persistenceStatus === 'persisted';
  if (value.persisted !== persisted || !persisted && value.persistenceStatus !== 'unavailable') return invalid;
  let finalCursor: NativeOutputCursor | null = null;
  if (value.complete) {
    if (!persisted || !isOutputCursor(value.finalCursor) || value.finalCursor.stdoutOffset !== value.nextCursor.stdoutOffset
      || value.finalCursor.stderrOffset !== value.nextCursor.stderrOffset || value.incompleteReason !== null) return invalid;
    finalCursor = { stdoutOffset: value.finalCursor.stdoutOffset, stderrOffset: value.finalCursor.stderrOffset };
  } else if (value.finalCursor !== null) return invalid;
  const reason = safeReason(value.incompleteReason);
  if (!persisted && reason === undefined) return invalid;
  return { state: 'available', binding, stdout, stderr, stdoutTruncated: value.stdoutTruncated, stderrTruncated: value.stderrTruncated,
    complete: value.complete, nextCursor: { stdoutOffset: value.nextCursor.stdoutOffset, stderrOffset: value.nextCursor.stderrOffset }, finalCursor,
    persistence: persisted ? { state: 'persisted' } : { state: 'unavailable', reason: reason ?? 'NATIVE_OUTPUT_PERSISTENCE_UNAVAILABLE' } };
}
function definedEnvironment(input: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
function helperEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'localappdata', 'userprofile']);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function unknown(binding: NativeAttemptBinding, reason: string): Extract<NativeProcessObservation, { state: 'termination_unknown' }> { return { state: 'termination_unknown', binding, reason }; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function childCompletion(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); child.removeListener('error', onError); child.removeListener('close', onClose); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (code: number | null): void => { cleanup(); resolve(code); };
    const timer = setTimeout(() => { child.kill(); cleanup(); reject(new Error('NATIVE_SERVICE_RPC_TIMEOUT')); }, timeoutMs);
    timer.unref();
    child.once('error', onError);
    child.once('close', onClose);
  });
}
async function writePrivateFrame(child: ChildProcess, payload: Buffer, end: boolean): Promise<void> {
  if (child.stdin === null) throw new Error('NATIVE_PRIVATE_PIPE_REQUIRED');
  const prefix = Buffer.alloc(4); prefix.writeInt32LE(payload.length);
  const frame = Buffer.concat([prefix, payload]);
  await new Promise<void>((resolve, reject) => {
    const input = child.stdin;
    if (input === null) { reject(new Error('NATIVE_PRIVATE_PIPE_REQUIRED')); return; }
    const onError = (error: Error): void => { input.removeListener('error', onError); reject(error); };
    input.once('error', onError);
    input.write(frame, (error?: Error | null) => {
      input.removeListener('error', onError);
      if (error) { reject(error); return; }
      if (end) input.end();
      resolve();
    });
  });
}
