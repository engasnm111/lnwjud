import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { NativeAttemptBinding, WindowsNativeAuthority, WindowsNativeAuthorityConfig } from '@lnwjud/process';
import { DurableShellTaskStore, durableShellNativeBinding, type DurableShellLaunchRequest } from './durable-shell-task-store.js';
import { repositoryImportWorkerSource } from './repository-import-worker-source.js';
import { repositoryImportNativeIdentityPattern } from './windows-repository-import-anchor.js';
import type { CapabilityTaskOwner } from './task-ownership.js';

export interface SecureRepositoryImportStart {
  readonly request: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly url: string;
    readonly destination: string;
    readonly commit: string;
  };
  readonly owner: CapabilityTaskOwner;
  readonly workspaceRoot: string;
}

export interface SecureRepositoryImportHandle {
  readonly taskId: string;
  readonly owner: CapabilityTaskOwner;
}

interface ImportManifest {
  readonly version: 2;
  readonly requestDigest: string;
  readonly manifestDigest: string;
  readonly owner: CapabilityTaskOwner;
  readonly requestId: string;
  readonly url: string;
  readonly commit: string;
  readonly workspaceRoot: string;
  readonly destination: string;
  readonly stagePath: string;
  readonly privateHome: string;
  readonly binding: NativeAttemptBinding;
  readonly authorityConfig: WindowsNativeAuthorityConfig;
  readonly processModule: string;
  readonly originalInput: SecureRepositoryImportStart;
}

interface NativeReceipt {
  readonly version: 2;
  readonly state: 'prepared' | 'published';
  readonly nativeIdentity: string;
  readonly commit: string;
}

/**
 * Native Windows-only provider. A durable Windows Job Object contains every
 * Git/PowerShell descendant. Its reservation index is the SAME directory used
 * by the generic shell provider, not an independently scoped workspace queue.
 *
 * NOTE: the public tool must not be advertised until direct process/Git/file
 * writers also participate in the same exclusive admission boundary.
 */
export class SecureRepositoryImportRuntime {
  private readonly taskStore: DurableShellTaskStore;
  private readonly root: string;

  constructor(private readonly dataPath: string, private readonly nativeAuthority?: WindowsNativeAuthority) {
    this.root = path.join(dataPath, 'repository-imports');
    this.taskStore = new DurableShellTaskStore(path.join(dataPath, 'background-tasks'), nativeAuthority ? { windowsNativeAuthority: nativeAuthority } : {});
  }

  async start(input: SecureRepositoryImportStart, _signal?: AbortSignal): Promise<Result<Record<string, unknown>>> {
    if (process.platform !== 'win32') return err(appError('INVALID_INPUT', 'Secure repository import requires verified local Windows NTFS'));
    if (!this.nativeAuthority) return err(appError('PERMISSION_DENIED', 'Repository import native authority is unavailable'));
    if (_signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Repository import request was cancelled', true));
    const { request, owner } = input;
    if (request.workspaceId !== owner.workspaceId
      || !/^[0-9a-f-]{36}$/i.test(request.requestId)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(request.commit)
      || !path.win32.isAbsolute(input.workspaceRoot)
      || input.workspaceRoot.startsWith('\\\\')) return err(appError('INVALID_INPUT', 'Repository import scope is invalid'));
    const taskId = this.taskId(request.requestId);
    const directory = this.importDirectory(request.requestId);
    const manifestPath = path.join(directory, 'spec.json');
    const digest = createHash('sha256').update(JSON.stringify({ input })).digest('hex');
    const workerPath = path.join(directory, 'worker.cjs');
    const launchRequestBase = {
      mutationKind: 'repository_import', taskId, executable: process.execPath,
      arguments: [workerPath, manifestPath, digest], cwd: directory, timeoutSeconds: 900,
      maxOutputBytes: 4096, includeStdout: true, includeStderr: false, owner,
    } satisfies DurableShellLaunchRequest;
    let launchRequest: DurableShellLaunchRequest;
    try {
      const canonicalWorkspace = await realpath(input.workspaceRoot);
      if (canonicalWorkspace.toLowerCase() !== path.win32.normalize(input.workspaceRoot).toLowerCase()
        || !(await stat(canonicalWorkspace)).isDirectory()) {
        return err(appError('PERMISSION_DENIED', 'Repository import workspace identity is not stable'));
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let manifest: ImportManifest;
      try {
        const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as ImportManifest;
        if (existing.version !== 2 || existing.requestDigest !== digest
          || existing.owner.clientId !== owner.clientId || existing.owner.sessionId !== owner.sessionId
          || existing.owner.workspaceId !== owner.workspaceId) {
          return err(appError('CONFLICT', 'Repository import request identifier was already used', true));
        }
        const observed = await this.status({ taskId, owner });
        return observed.ok ? observed : ok({ task_id: taskId, state: 'unresolved', detail: 'Existing import requires reconciliation' });
      } catch (error: unknown) {
        if (!isMissing(error)) return err(appError('CONFLICT', 'Repository import manifest could not be verified', true));
        const stagePath = path.join(path.win32.dirname(canonicalWorkspace), '.lnwjud-import-stage-' + randomUUID());
        const core = {
          version: 2 as const, requestDigest: digest, owner, requestId: request.requestId.toLowerCase(),
          url: request.url, commit: request.commit.toLowerCase(), workspaceRoot: canonicalWorkspace,
          destination: request.destination, stagePath,
          privateHome: path.join(directory, 'home'),
          authorityConfig: this.nativeAuthority.config,
          processModule: fileURLToPath(import.meta.resolve('@lnwjud/process')),
          originalInput: input,
        };
        const manifestDigest = createHash('sha256').update(JSON.stringify(core)).digest('hex');
        launchRequest = { ...launchRequestBase, arguments: [...launchRequestBase.arguments, manifestDigest] };
        manifest = { ...core, manifestDigest, binding: durableShellNativeBinding(launchRequest) };
        try {
          await writeFile(manifestPath, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
          if (isExists(error)) return err(appError('CONFLICT', 'Concurrent repository import admission requires a retry', true));
          throw error;
        }
      }
      for (const [filename, content] of [
        [workerPath, repositoryImportWorkerSource],
      ] as const) {
        const asset = await this.ensureAsset(filename, content);
        if (!asset) return err(appError('CONFLICT', 'Repository import runner assets changed unexpectedly'));
      }
      const started = await this.taskStore.launch(launchRequest);
      if (!started.ok) return started;
      return this.status({ taskId, owner });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Repository import could not be admitted', true));
    }
  }

  async status(input: SecureRepositoryImportHandle): Promise<Result<Record<string, unknown>>> {
    const manifest = await this.readOwnedManifest(input);
    if (!manifest.ok) return manifest;
    if (manifest.value.version !== 2) return ok({ task_id: input.taskId, state: 'unresolved', detail: 'Legacy native publication proof requires reconciliation' });
    const snapshot = await this.taskStore.snapshot(input.taskId, undefined, input.owner);
    if (!snapshot.ok) return snapshot;
    const state = snapshot.value.state;
    const response = { task_id: input.taskId, requested_commit: manifest.value.commit, destination: manifest.value.destination };
    if (state === 'starting') return ok({ ...response, state: 'starting' });
    if (state === 'running') return ok({ ...response, state: 'running' });
    if (state === 'completed' && snapshot.value.exit_code === 0) {
      const native = await this.nativeReceipt(manifest.value, 'publish_import');
      if (native?.state === 'published' && native.commit === manifest.value.commit
        && await this.verifyPublishedIdentity(manifest.value, native)) {
        return ok({ ...response, state: 'completed', verified_commit: native.commit, native_identity: native.nativeIdentity });
      }
      // A process can crash after no-replace rename but before writing its
      // terminal receipt. A matching commit/HEAD is NOT native ownership proof.
      return ok({ ...response, state: 'unresolved', detail: 'Native publication proof is incomplete' });
    }
    if (state === 'termination_unverified' || state === 'running') {
      return ok({ ...response, state: 'unresolved' });
    }
    if (state !== 'completed' && state !== 'failed' && state !== 'cancelled' && state !== 'timed_out') {
      return ok({ ...response, state: 'unresolved', detail: 'Contained worker state is unverified' });
    }
    const native = await this.nativeReceipt(manifest.value, 'publish_import') ?? await this.nativeReceipt(manifest.value, 'prepare_import');
    if (native?.commit === manifest.value.commit && (native.state === 'prepared' || native.state === 'published')) {
      // The native no-replace rename can complete between durable receipt writes.
      // A prepared receipt cannot prove whether publication happened, even when the worker failed.
      return ok({ ...response, state: 'unresolved', detail: 'Native publication may have occurred without a successful contained worker receipt' });
    }
    // A worker can stop without its publication receipt even after a native
    // rename. A destination still present makes a terminal failure ambiguous.
    if (typeof manifest.value.workspaceRoot !== 'string'
      || typeof manifest.value.destination !== 'string'
      || !path.win32.isAbsolute(manifest.value.workspaceRoot)
      || path.win32.isAbsolute(manifest.value.destination)
      || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(manifest.value.destination)) {
      return ok({ ...response, state: 'unresolved', detail: 'Native publication destination is unverified' });
    }
    try {
      await lstat(path.win32.join(manifest.value.workspaceRoot, manifest.value.destination));
      return ok({ ...response, state: 'unresolved', detail: 'Destination exists without a verified native publication receipt' });
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error)
        || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return ok({ ...response, state: 'unresolved', detail: 'Native destination could not be inspected' });
      }
    }
    return ok({ ...response, state: state === 'cancelled' ? 'cancelled' : 'failed' });
  }

  async cancel(input: SecureRepositoryImportHandle): Promise<Result<Record<string, unknown>>> {
    const manifest = await this.readOwnedManifest(input);
    if (!manifest.ok) return manifest;
    const cancelled = await this.taskStore.cancel(input.taskId, input.owner);
    if (!cancelled.ok) return cancelled;
    return this.status(input);
  }

  private taskId(requestId: string): string {
    return 'repository-import-' + requestId.toLowerCase();
  }

  private importDirectory(requestId: string): string {
    return path.join(this.root, requestId.toLowerCase());
  }

  private async readOwnedManifest(handle: SecureRepositoryImportHandle): Promise<Result<ImportManifest>> {
    if (!/^repository-import-[0-9a-f-]{36}$/.test(handle.taskId)) {
      return err(appError('INVALID_INPUT', 'Repository import task ID is invalid'));
    }
    const requestId = handle.taskId.slice('repository-import-'.length);
    try {
      const value = JSON.parse(await readFile(path.join(this.importDirectory(requestId), 'spec.json'), 'utf8')) as ImportManifest;
      if ((value.version !== 2 && Number(value.version) !== 1) || value.requestId !== requestId
        || value.owner.clientId !== handle.owner.clientId
        || value.owner.sessionId !== handle.owner.sessionId
        || value.owner.workspaceId !== handle.owner.workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Repository import belongs to another client, session or workspace'));
      }
      if (value.version === 2 && (!value.binding
        || value.binding.taskId !== handle.taskId || value.binding.reservationId !== handle.taskId
        || value.binding.attemptId !== handle.taskId || value.binding.generation !== 1
        || value.binding.ownerClientId !== handle.owner.clientId || value.binding.ownerSessionId !== handle.owner.sessionId
        || value.binding.workspaceId !== handle.owner.workspaceId)) {
        return err(appError('PERMISSION_DENIED', 'Repository import native binding does not match its owner or attempt'));
      }
      if (value.version === 2) {
        const original = value.originalInput;
        const directory = this.importDirectory(requestId);
        const expected = durableShellNativeBinding({
          mutationKind: 'repository_import', taskId: handle.taskId, executable: process.execPath,
          arguments: [path.join(directory, 'worker.cjs'), path.join(directory, 'spec.json'), value.requestDigest, value.manifestDigest],
          cwd: directory, timeoutSeconds: 900, maxOutputBytes: 4096, includeStdout: true, includeStderr: false, owner: handle.owner,
        });
        if (!original || manifestIntegrityDigest(value) !== value.manifestDigest
          || createHash('sha256').update(JSON.stringify({ input: original })).digest('hex') !== value.requestDigest
          || value.binding.requestDigest !== expected.requestDigest
          || original.request.commit.toLowerCase() !== value.commit || original.request.destination !== value.destination
          || original.request.url !== value.url || original.request.requestId.toLowerCase() !== requestId
          || path.win32.normalize(original.workspaceRoot).toLowerCase() !== path.win32.normalize(value.workspaceRoot).toLowerCase()) {
          return err(appError('PERMISSION_DENIED', 'Repository import request does not match its authenticated binding'));
        }
      }
      return ok(value);
    } catch {
      return err(appError('PROCESS_NOT_FOUND', 'Repository import task was not found'));
    }
  }

  private async ensureAsset(filename: string, content: string): Promise<boolean> {
    try {
      await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      try {
        if (await readFile(filename, 'utf8') !== content) return false;
      } catch { return false; }
    }
    return true;
  }

  private async verifyPublishedIdentity(manifest: ImportManifest, native: NativeReceipt): Promise<boolean> {
    if (process.platform !== 'win32' || !this.nativeAuthority || manifest.version !== 2) return false;
    try {
      const result = await this.nativeAuthority.control({
        directory: path.join(this.importDirectory(manifest.requestId), 'inspection-' + randomUUID()),
        binding: manifest.binding, command: 'inspect_publication',
        request: { workspaceRoot: manifest.workspaceRoot, destination: manifest.destination, commit: manifest.commit },
      });
      return result.state === 'control_verified' && isNativeReceipt(result.result)
        && result.result.state === 'published' && result.result.nativeIdentity === native.nativeIdentity
        && result.result.commit === manifest.commit;
    } catch { return false; }
  }

  private async nativeReceipt(manifest: ImportManifest, command: 'prepare_import' | 'publish_import'): Promise<NativeReceipt | undefined> {
    if (!this.nativeAuthority || manifest.version !== 2) return undefined;
    try {
      const result = await this.nativeAuthority.inspectControl({
        directory: path.join(this.importDirectory(manifest.requestId), command), binding: manifest.binding, command,
      });
      return result.state === 'control_verified' && isNativeReceipt(result.result)
        && result.result.state === (command === 'prepare_import' ? 'prepared' : 'published') ? result.result : undefined;
    } catch { return undefined; }
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function isExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function isNativeReceipt(value: unknown): value is NativeReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.version === 2 && (receipt.state === 'prepared' || receipt.state === 'published')
    && typeof receipt.nativeIdentity === 'string' && repositoryImportNativeIdentityPattern.test(receipt.nativeIdentity)
    && typeof receipt.commit === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.commit);
}

function manifestIntegrityDigest(manifest: ImportManifest): string {
  const core = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'binding' && key !== 'manifestDigest'));
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}
