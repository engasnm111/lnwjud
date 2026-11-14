import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import {
  parseNativeAttemptBinding,
  type NativeAttemptBinding, type NativeAttemptHandle, type NativeOutputCursor, type NativeOutputRead,
  type NativeProcessObservation, type NativeProcessRequest, type NativeProcessSubmission,
} from './windows-native-authority.js';

export const MACOS_PROCESS_OWNER_ROOT = '/Library/Application Support/lnwjud/process-owner';
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024;
const BINDING_FIELDS = ['taskId', 'reservationId', 'attemptId', 'generation', 'requestDigest', 'ownerClientId', 'ownerSessionId', 'workspaceId'] as const;

export interface MacosNativeAuthorityConfiguration {
  readonly platform: 'darwin';
}

export interface MacosOwnerRequest {
  readonly command: 'health' | 'prepare' | 'run' | 'inspect' | 'cancel' | 'abort' | 'recover_after_reboot' | 'read_output';
  readonly binding?: NativeAttemptBinding;
  readonly operation?: {
    readonly executable: string; readonly args: readonly string[]; readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly maximumOutputBytes: number;
  };
  readonly cursor?: NativeOutputCursor;
}

export interface MacosOwnerTransport { request(request: MacosOwnerRequest): Promise<unknown> }

/** Replies are signed by the enrolled root-owned authority, not by the JS requester. */
export class MacosNativeAuthority {
  public readonly configuration: MacosNativeAuthorityConfiguration = { platform: 'darwin' };
  private readonly transport: MacosOwnerTransport;

  public constructor(transport?: MacosOwnerTransport) { this.transport = transport ?? { request: requestMacosOwner }; }

  public async available(): Promise<boolean> {
    try {
      const value = await this.transport.request({ command: 'health' });
      return record(value) && value.state === 'available' && value.contract === 'lnwjud-macos-process-owner-v1';
    } catch { return false; }
  }

  public async register(binding: NativeAttemptBinding): Promise<boolean> {
    const value = await this.observe('prepare', binding);
    return value.state === 'termination_unknown' && value.reason === 'MACOS_ATTEMPT_PREPARED';
  }

  public attachProcess(input: NativeAttemptBinding): NativeAttemptHandle {
    const binding = requireBinding(input);
    return Object.freeze({
      binding,
      observe: (): Promise<NativeProcessObservation> => this.inspect({ binding }),
      cancel: (): Promise<NativeProcessObservation> => this.cancel({ binding }),
      abortBeforeDispatch: (): Promise<NativeProcessObservation> => this.abortBeforeLaunch({ binding }),
      readOutput: (cursor: NativeOutputCursor): Promise<NativeOutputRead> => this.readOutput(binding, cursor),
    });
  }

  public async submitProcess(input: NativeProcessRequest): Promise<NativeProcessSubmission> {
    const handle = this.attachProcess(input.binding);
    if (input.signal?.aborted) return { handle, observation: await this.abortBeforeLaunch({ binding: handle.binding }) };
    if (!path.isAbsolute(input.executable) || !path.isAbsolute(input.cwd) || input.executable.includes('\0') || input.cwd.includes('\0')
      || input.args.length > 512 || input.args.some(value => typeof value !== 'string' || value.includes('\0'))
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 604_800_000
      || input.windowsVerbatimArguments === true) throw new Error('MACOS_PROCESS_REQUEST_INVALID');
    const maximumOutputBytes = input.maximumOutputBytes ?? 128 * 1024;
    if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 0 || maximumOutputBytes > MAX_OUTPUT) throw new Error('MACOS_OUTPUT_LIMIT_INVALID');
    try {
      const prepared = await this.observe('prepare', handle.binding);
      if (prepared.state === 'launch_not_started' || prepared.state === 'termination_unknown' && prepared.reason !== 'MACOS_ATTEMPT_PREPARED') return { handle, observation: prepared };
      if (input.signal?.aborted) return { handle, observation: await this.abortBeforeLaunch({ binding: handle.binding }) };
      const environment = Object.fromEntries(Object.entries(input.environment ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const value = await this.transport.request({ command: 'run', binding: handle.binding, operation: {
        executable: input.executable, args: [...input.args], cwd: input.cwd, environment,
        timeoutMs: input.timeoutMs, maximumOutputBytes,
      } });
      return { handle, observation: parseMacosProcessObservation(value, handle.binding) };
    } catch { return { handle, observation: unknown(handle.binding, 'MACOS_SUBMISSION_UNVERIFIED') }; }
  }

  public inspect(input: { readonly binding: NativeAttemptBinding; readonly directory?: string }): Promise<NativeProcessObservation> {
    return this.observe('inspect', input.binding);
  }

  public async cancel(input: { readonly binding: NativeAttemptBinding; readonly directory?: string }): Promise<NativeProcessObservation> {
    let value = await this.observe('cancel', input.binding);
    const deadline = Date.now() + 12_000;
    while (value.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      value = await this.inspect(input);
    }
    return value.state === 'running' ? unknown(input.binding, 'MACOS_CANCELLATION_UNVERIFIED') : value;
  }

  public abortBeforeLaunch(input: { readonly binding: NativeAttemptBinding; readonly directory?: string }): Promise<NativeProcessObservation> {
    return this.observe('abort', input.binding);
  }

  public recoverAfterReboot(input: { readonly binding: NativeAttemptBinding; readonly directory?: string; readonly recordedAt?: string }): Promise<NativeProcessObservation> {
    return this.observe('recover_after_reboot', input.binding);
  }

  private async observe(command: 'prepare' | 'inspect' | 'cancel' | 'abort' | 'recover_after_reboot', input: NativeAttemptBinding): Promise<NativeProcessObservation> {
    const binding = requireBinding(input);
    try { return parseMacosProcessObservation(await this.transport.request({ command, binding }), binding); }
    catch { return unknown(binding, 'MACOS_OWNER_UNAVAILABLE'); }
  }

  private async readOutput(binding: NativeAttemptBinding, cursor: NativeOutputCursor): Promise<NativeOutputRead> {
    const invalid: NativeOutputRead = { state: 'unavailable', binding, reason: 'MACOS_OUTPUT_UNVERIFIED' };
    if (!validCursor(cursor)) return invalid;
    try {
      const value = await this.transport.request({ command: 'read_output', binding, cursor });
      if (!record(value) || !sameBinding(value.binding, binding) || value.state !== 'available'
        || typeof value.stdoutTruncated !== 'boolean' || typeof value.stderrTruncated !== 'boolean'
        || typeof value.complete !== 'boolean' || !validCursor(value.nextCursor)
        || !record(value.persistence) || value.persistence.state !== 'persisted') return invalid;
      const stdout = outputBytes(value.stdout), stderr = outputBytes(value.stderr);
      if (stdout === undefined || stderr === undefined || cursor.stdoutOffset + stdout.length !== value.nextCursor.stdoutOffset
        || cursor.stderrOffset + stderr.length !== value.nextCursor.stderrOffset) return invalid;
      if (value.complete ? !validCursor(value.finalCursor) || value.finalCursor.stdoutOffset !== value.nextCursor.stdoutOffset
        || value.finalCursor.stderrOffset !== value.nextCursor.stderrOffset : value.finalCursor !== null) return invalid;
      return { state: 'available', binding, stdout, stderr, stdoutTruncated: value.stdoutTruncated, stderrTruncated: value.stderrTruncated,
        complete: value.complete, nextCursor: value.nextCursor, finalCursor: value.complete && validCursor(value.finalCursor) ? value.finalCursor : null,
        persistence: { state: 'persisted' } };
    } catch { return invalid; }
  }
}

export function parseMacosProcessObservation(value: unknown, binding: NativeAttemptBinding): NativeProcessObservation {
  if (!record(value) || !sameBinding(value.binding, binding)) return unknown(binding, 'MACOS_OWNER_IDENTITY_MISMATCH');
  if (value.state === 'launch_not_started' && fields(value, ['state', 'binding'])) return { state: 'launch_not_started', binding };
  if (value.state === 'running' && fields(value, ['state', 'binding', 'targetPid']) && Number.isSafeInteger(value.targetPid)
    && typeof value.targetPid === 'number' && value.targetPid > 1) return { state: 'running', binding, targetPid: value.targetPid };
  if (value.state === 'terminal_verified' && fields(value, ['state', 'binding', 'outcome', 'exitCode', 'activeProcesses'])
    && value.activeProcesses === 0 && Number.isSafeInteger(value.exitCode) && typeof value.exitCode === 'number'
    && (value.outcome === 'completed' || value.outcome === 'cancelled' || value.outcome === 'timed_out' || value.outcome === 'interrupted')) {
    return { state: 'terminal_verified', binding, activeProcesses: 0, outcome: value.outcome, exitCode: value.exitCode };
  }
  if (value.state === 'termination_unknown' && fields(value, ['state', 'binding', 'reason'])
    && typeof value.reason === 'string' && /^MACOS_[A-Z0-9_]{1,100}$/.test(value.reason)) return unknown(binding, value.reason);
  return unknown(binding, 'MACOS_OWNER_RESPONSE_INVALID');
}

export function verifyMacosOwnerReply(frame: unknown, expected: { readonly nonce: string; readonly requestDigest: string; readonly uid: number }, publicKey: Buffer): unknown {
  if (!record(frame) || !fields(frame, ['payload', 'signature']) || typeof frame.payload !== 'string' || typeof frame.signature !== 'string'
    || frame.payload.length > MAX_FRAME || publicKey.length !== 32) throw new Error('MACOS_OWNER_REPLY_INVALID');
  const payload = Buffer.from(frame.payload, 'base64'), signature = Buffer.from(frame.signature, 'base64');
  if (payload.toString('base64') !== frame.payload || signature.length !== 64 || signature.toString('base64') !== frame.signature
    || !verify(null, payload, createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' }), signature)) {
    throw new Error('MACOS_OWNER_SIGNATURE_INVALID');
  }
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  if (!record(body) || !fields(body, ['protocol', 'nonce', 'requestDigest', 'uid', 'bootId', 'result'])
    || body.protocol !== 1 || body.nonce !== expected.nonce || body.requestDigest !== expected.requestDigest || body.uid !== expected.uid
    || typeof body.bootId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.bootId)
    || !record(body.result)) throw new Error('MACOS_OWNER_REPLY_SCOPE_MISMATCH');
  return body.result;
}

async function requestMacosOwner(request: MacosOwnerRequest): Promise<unknown> {
  if (process.platform !== 'darwin' || process.getuid === undefined) throw new Error('MACOS_OWNER_PLATFORM_UNAVAILABLE');
  const publicKey = await enrolledPublicKey();
  const nonce = randomUUID();
  const bytes = Buffer.from(JSON.stringify({ protocol: 1, nonce, ...request }), 'utf8');
  if (bytes.length > MAX_FRAME) throw new Error('MACOS_OWNER_REQUEST_TOO_LARGE');
  const result: Buffer = await new Promise((resolve, reject) => {
    const socket = connect({ path: `${MACOS_PROCESS_OWNER_ROOT}/owner.sock` });
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(Buffer.concat(chunks, length));
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error('MACOS_OWNER_RPC_TIMEOUT')), 15_000);
    timer.unref();
    socket.on('error', () => finish(new Error('MACOS_OWNER_RPC_UNAVAILABLE')));
    socket.once('connect', () => socket.end(Buffer.concat([bytes, Buffer.from('\n')])));
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_FRAME) { finish(new Error('MACOS_OWNER_REPLY_TOO_LARGE')); return; }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => finish());
    socket.once('close', () => { if (!settled) finish(new Error('MACOS_OWNER_REPLY_UNAVAILABLE')); });
  });
  const frame = new TextDecoder('utf-8', { fatal: true }).decode(result);
  if (!frame.endsWith('\n') || frame.slice(0, -1).includes('\n')) throw new Error('MACOS_OWNER_FRAME_INVALID');
  return verifyMacosOwnerReply(JSON.parse(frame), { nonce, requestDigest: createHash('sha256').update(bytes).digest('hex'), uid: process.getuid() }, publicKey);
}

async function enrolledPublicKey(): Promise<Buffer> {
  let directory = MACOS_PROCESS_OWNER_ROOT;
  while (true) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('MACOS_OWNER_ENROLLMENT_UNTRUSTED');
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const key = await open(`${MACOS_PROCESS_OWNER_ROOT}/public.key`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await key.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size !== 32) throw new Error('MACOS_OWNER_KEY_UNTRUSTED');
    const bytes = await key.readFile();
    if (bytes.length !== 32) throw new Error('MACOS_OWNER_KEY_UNTRUSTED');
    return bytes;
  } finally { await key.close(); }
}

function requireBinding(value: NativeAttemptBinding): NativeAttemptBinding {
  const binding = parseNativeAttemptBinding(value);
  if (binding === undefined || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(binding.attemptId)) throw new Error('MACOS_BINDING_INVALID');
  return Object.freeze(binding);
}
function sameBinding(value: unknown, expected: NativeAttemptBinding): boolean {
  const binding = parseNativeAttemptBinding(value);
  return binding !== undefined && BINDING_FIELDS.every(field => binding[field] === expected[field]);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function fields(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function unknown(binding: NativeAttemptBinding, reason: string): Extract<NativeProcessObservation, { state: 'termination_unknown' }> { return { state: 'termination_unknown', binding, reason }; }
function validCursor(value: unknown): value is NativeOutputCursor {
  return record(value) && fields(value, ['stdoutOffset', 'stderrOffset']) && [value.stdoutOffset, value.stderrOffset].every(offset => typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_OUTPUT);
}
function outputBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_OUTPUT / 3) * 4) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= MAX_OUTPUT && bytes.toString('base64') === value ? bytes : undefined;
}
