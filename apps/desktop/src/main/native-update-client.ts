import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { UPDATE_WORKER_BUILD_ID, UPDATE_WORKER_PIN_SHA256, UPDATE_WORKER_PROTOCOL, UPDATE_WORKER_SHA256 } from './update-worker-integrity.generated.js';

export interface NativeUpdateBootstrapConfiguration {
  readonly executable: string;
  readonly executableSha256: string;
  readonly pinModule: string;
  readonly pinSha256: string;
  readonly stateRoot: string;
  readonly installationId: string;
}

export type UpdateStartupDisposition =
  | { readonly kind: 'ready' }
  | { readonly kind: 'held'; readonly reason: string };

export type NativeUpdateCapability = {
  readonly kind: 'unavailable';
  readonly reason: string;
};

interface NativePin { close(): void }
interface PinModule { pinExecutable(filename: string): unknown }
const requireNative = createRequire(import.meta.url);
const MAX_FRAME_BYTES = 65_536;
const DIGEST = /^[a-f0-9]{64}$/;
const POSITION = /^(?:0|[1-9][0-9]{0,19})$/;
const REASON = /^[A-Z][A-Z0-9_]{0,127}$/;
const TRANSACTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pinModule(value: unknown): value is PinModule {
  return record(value) && typeof value.pinExecutable === 'function';
}

function nativePin(value: unknown): value is NativePin {
  return record(value) && typeof value.close === 'function';
}

async function plainFile(filename: string): Promise<void> {
  if (!path.isAbsolute(filename)) throw new Error('UPDATE_WORKER_PATH_INVALID');
  let current = path.resolve(filename);
  let file = true;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
      throw new Error('UPDATE_WORKER_PATH_UNSAFE');
    }
    const parent = path.dirname(current);
    if (current === parent) return;
    current = parent;
    file = false;
  }
}

async function pinWorker(config: NativeUpdateBootstrapConfiguration): Promise<NativePin> {
  await plainFile(config.pinModule);
  if (createHash('sha256').update(await readFile(config.pinModule)).digest('hex') !== config.pinSha256) {
    throw new Error('UPDATE_WORKER_PIN_INTEGRITY_FAILED');
  }
  const module: unknown = requireNative(config.pinModule);
  if (!pinModule(module)) throw new Error('UPDATE_WORKER_PIN_INVALID');
  const pin = module.pinExecutable(config.executable);
  if (!nativePin(pin)) throw new Error('UPDATE_WORKER_PIN_INVALID');
  try {
    await plainFile(config.executable);
    if (createHash('sha256').update(await readFile(config.executable)).digest('hex') !== config.executableSha256) {
      throw new Error('UPDATE_WORKER_INTEGRITY_FAILED');
    }
    return pin;
  } catch (error) {
    pin.close();
    throw error;
  }
}

function position(value: unknown): boolean {
  return value === null || typeof value === 'string' && POSITION.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

export function parseUpdateWorkerReply(value: unknown, expected: { installationId: string; requestId: string }): Record<string, unknown> {
  if (!record(value) || !fields(value, ['protocol', 'buildId', 'installationId', 'requestId', 'generation', 'revision', 'result'])
    || value.protocol !== UPDATE_WORKER_PROTOCOL || value.buildId !== UPDATE_WORKER_BUILD_ID
    || value.installationId !== expected.installationId || value.requestId !== expected.requestId
    || !position(value.generation) || !position(value.revision) || (value.generation === null) !== (value.revision === null) || !record(value.result)) {
    throw new Error('UPDATE_WORKER_RESPONSE_INVALID');
  }
  const result = value.result;
  if (result.kind === 'capabilities' && fields(result, ['kind', 'platform', 'architecture', 'automaticInstallation', 'reason'])
    && result.platform === 'windows' && result.architecture === 'x64'
    && result.automaticInstallation === 'unavailable' && result.reason === 'TRANSACTION_BOOTSTRAP_ONLY') return result;
  if (result.kind === 'none' && fields(result, ['kind', 'safeToStart']) && result.safeToStart === true && value.generation !== null) return result;
  if (result.kind === 'recovered' && result.safeToStart === true && result.reason === 'PREAUTH_OWNER_RECOVERED'
    && fields(result, ['kind', 'reason', 'safeToStart', 'transactionId', 'phase'])
    && result.phase === 'unavailable' && typeof result.transactionId === 'string' && TRANSACTION_ID.test(result.transactionId)
    && value.generation !== null && value.generation !== '0' && value.revision !== '0') return result;
  if ((result.kind === 'held' && result.safeToStart === false && fields(result, ['kind', 'reason', 'safeToStart'], ['transactionId'])
    && (result.transactionId === undefined || typeof result.transactionId === 'string' && TRANSACTION_ID.test(result.transactionId))
    || result.kind === 'error' && fields(result, ['kind', 'reason']))
    && typeof result.reason === 'string' && REASON.test(result.reason)) return result;
  throw new Error('UPDATE_WORKER_RESPONSE_INVALID');
}

/** Bootstrap only. No command exposed here can install or roll back a package. */
export class NativeUpdateBootstrapClient {
  public constructor(private readonly config: NativeUpdateBootstrapConfiguration) {
    if (![config.executable, config.pinModule, config.stateRoot].every((filename) => path.isAbsolute(filename))
      || ![config.executableSha256, config.pinSha256, config.installationId].every((digest) => DIGEST.test(digest))) {
      throw new Error('UPDATE_WORKER_CONFIG_INVALID');
    }
  }

  public async recoverBeforeStartup(): Promise<UpdateStartupDisposition> {
    try {
      const result = await this.invoke('recover');
      return result.kind === 'none' || result.kind === 'recovered'
        ? { kind: 'ready' }
        : { kind: 'held', reason: symbolicReason(result) };
    } catch {
      try { await lstat(this.config.stateRoot); }
      catch (error: unknown) {
        if (record(error) && error.code === 'ENOENT') return { kind: 'ready' };
      }
      return { kind: 'held', reason: 'UPDATE_RECOVERY_AUTHORITY_UNAVAILABLE' };
    }
  }

  public async automaticCapability(): Promise<NativeUpdateCapability> {
    try {
      const result = await this.invoke('capabilities');
      return { kind: 'unavailable', reason: result.kind === 'capabilities' ? 'TRANSACTION_BOOTSTRAP_ONLY' : symbolicReason(result) };
    } catch { return { kind: 'unavailable', reason: 'UPDATE_WORKER_UNAVAILABLE' }; }
  }

  private async invoke(command: 'recover' | 'capabilities'): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('UPDATE_WORKER_PLATFORM_UNAVAILABLE');
    const pin = await pinWorker(this.config);
    const requestId = randomUUID();
    let closed = false;
    try {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        ['systemroot', 'windir', 'temp', 'tmp', 'localappdata', 'userprofile'].includes(key.toLowerCase()) && value !== undefined));
      const child = spawn(this.config.executable, ['--stdio', '--state-root', this.config.stateRoot, '--installation-id', this.config.installationId], {
        shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { failed = true; child.kill(); }, 15_000);
        timer.unref();
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_FRAME_BYTES + 1) { failed = true; child.kill(); }
          else chunks.push(Buffer.from(chunk));
        });
        child.stderr.resume();
        child.stdin.on('error', () => { failed = true; });
        child.on('error', () => { failed = true; });
        child.once('close', (code) => {
          clearTimeout(timer);
          closed = true;
          pin.close();
          try {
            if (failed || code !== 0 || bytes === 0) throw new Error('UPDATE_WORKER_TRANSPORT_FAILED');
            const frame = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
            if (!frame.endsWith('\n') || frame.slice(0, -1).includes('\n')) throw new Error('UPDATE_WORKER_RESPONSE_INVALID');
            const value: unknown = JSON.parse(frame);
            resolve(parseUpdateWorkerReply(value, { installationId: this.config.installationId, requestId }));
          } catch { reject(new Error('UPDATE_WORKER_RESPONSE_INVALID')); }
        });
        child.stdin.end(`${JSON.stringify({ protocol: UPDATE_WORKER_PROTOCOL, requestId, command })}\n`);
      });
    } catch (error) {
      if (!closed) pin.close();
      throw error;
    }
  }
}

function symbolicReason(result: Record<string, unknown>): string {
  return typeof result.reason === 'string' && REASON.test(result.reason) ? result.reason : 'UPDATE_RECOVERY_UNRESOLVED';
}

export function createNativeUpdateBootstrapClient(dataPath: string, executablePath: string, resourceDirectory: string): NativeUpdateBootstrapClient {
  return new NativeUpdateBootstrapClient({
    executable: path.join(resourceDirectory, 'update-worker', 'lnwjud-update-worker.exe'),
    executableSha256: UPDATE_WORKER_SHA256,
    pinModule: path.join(resourceDirectory, 'native-containment', 'lnwjud-containment-pin.node'),
    pinSha256: UPDATE_WORKER_PIN_SHA256,
    stateRoot: path.join(dataPath, 'update-transactions'),
    installationId: createHash('sha256').update(path.normalize(path.resolve(executablePath)).toLowerCase()).digest('hex'),
  });
}
