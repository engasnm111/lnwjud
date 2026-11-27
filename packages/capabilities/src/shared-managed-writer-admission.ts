import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { parseNativeAttemptBinding, type NativeAttemptBinding, type WindowsNativeAuthority } from '@lnwjud/process';
import { DurableShellTaskIndex, workspaceProbeOwner, type DurableTaskReservation, type NativeWriterInspection } from './durable-shell-task-index.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';

export type WriterContainmentKind = 'synchronous_mutation' | 'uncontained_process' | 'contained_process';

export interface ManagedWriterAdmissionLease {
  readonly id: string;
  readonly nativeBinding?: NativeAttemptBinding;
  abortBeforeLaunch?(): Promise<void>;
  /** Call only after the mutation completed and every spawned process was verified terminated. */
  releaseAfterVerifiedTermination(): Promise<void>;
}

/**
 * Reuses the durable shell's single on-disk reservation index across all
 * workspaces. An uncontained process reservation deliberately cannot be
 * reclaimed by PID disappearance; child/orphan zero-activity proof is required.
 */
export class SharedManagedWriterAdmission {
  private readonly index: DurableShellTaskIndex;

  constructor(taskDirectory: string, private readonly nativeAuthority?: WindowsNativeAuthority, private readonly platform: NodeJS.Platform = process.platform,
    private readonly macosNativeAuthority?: import('@lnwjud/process').MacosNativeAuthority,
    workspaceRoot?: (workspaceId: string) => Promise<string | undefined>) {
    const store = new DurableShellTaskStore(taskDirectory, { ...(nativeAuthority === undefined ? {} : { windowsNativeAuthority: nativeAuthority }),
      ...(macosNativeAuthority === undefined ? {} : { macosNativeAuthority }) });
    this.index = new DurableShellTaskIndex(taskDirectory, {
      maxConcurrentTasks: 10000,
      capacityClass: 'managed_writer',
      inspectTask: (taskId, owner): ReturnType<DurableShellTaskStore['inspectForWriterAdmission']> =>
        store.inspectForWriterAdmission(taskId, owner),
      inspectNativeWriter: (reservation): Promise<NativeWriterInspection> => this.inspectNativeWriter(reservation),
      ...(workspaceRoot === undefined ? {} : { areWorkspacesDisjoint: async (leftId, rightId): Promise<boolean> => {
        const [left, right] = await Promise.all([workspaceRoot(leftId), workspaceRoot(rightId)]);
        if (left === undefined || right === undefined) return false;
        return disjointWorkspaceRoots(left, right);
      } }),
    });
  }

  /**
   * Acquire a short-lived repository-import-class barrier across the durable
   * shell/process index. It inspects and conservatively refuses active or
   * unverifiable tasks before a workspace lease is acquired or released.
   * The caller holds the barrier across its SQLite admission transaction.
   */
  async holdExclusiveProbe(workspaceId: string): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!workspaceId) return err(appError('INVALID_INPUT', 'Workspace lease probe requires a workspace ID'));
    const id = 'workspace-writer-probe-' + randomUUID();
    const requestDigest = createHash('sha256').update(id + ':' + workspaceId).digest('hex');
    const probe: DurableTaskReservation = {
      taskId: id,
      capacityClass: 'managed_writer',
      requestDigest,
      mutationKind: 'repository_import',
      ownerClientId: workspaceProbeOwner,
      ownerWorkspaceId: workspaceId,
    };
    let reserved = await this.index.reserve(probe);
    if (!reserved.ok && reserved.error.details?.blocker_state === 'changed') {
      reserved = await this.index.reserve(probe);
    }
    if (!reserved.ok) return reserved;
    return ok({
      id,
      releaseAfterVerifiedTermination: async (): Promise<void> => {
        await this.index.release(id, requestDigest);
        if (await this.index.hasReservation(id, requestDigest)) throw new Error('MANAGED_WRITER_RELEASE_UNVERIFIED');
      },
    });
  }

  async enter(input: {
    readonly actorClientId: string;
    readonly actorSessionId?: string;
    readonly nativeTaskId?: string;
    readonly workspaceId: string;
    readonly kind: WriterContainmentKind;
    readonly nativeReceiptPath?: string;
  }): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!input.actorClientId || !input.workspaceId
      || (input.kind !== 'synchronous_mutation' && input.kind !== 'uncontained_process' && input.kind !== 'contained_process')) {
      return err(appError('INVALID_INPUT', 'Managed writer admission identity is invalid'));
    }
    // A macOS detached child can outlive the original PGID and keep writing.
    if (this.platform === 'darwin' && input.kind !== 'synchronous_mutation'
      && (input.kind !== 'contained_process' || !await this.macosNativeAuthority?.available())) {
      return err(appError('CONFLICT', 'macOS process writer requires an enrolled Endpoint Security owner; no reservation was created'));
    }
    const id = 'managed-writer-' + randomUUID();
    const digest = createHash('sha256').update(JSON.stringify([id, input.actorClientId, input.actorSessionId, input.workspaceId])).digest('hex');
    const nativeBinding = input.kind === 'contained_process' ? parseNativeAttemptBinding({
      taskId: input.nativeTaskId, reservationId: id, attemptId: randomUUID(), generation: 1,
      requestDigest: digest, ownerClientId: input.actorClientId, ownerSessionId: input.actorSessionId,
      workspaceId: input.workspaceId,
    }) : undefined;
    if (input.kind === 'contained_process') {
      if (nativeBinding === undefined) {
        return err(appError('INVALID_INPUT', 'Contained writer native attempt or session identity is invalid'));
      }
      if ((this.platform === 'darwin' ? this.macosNativeAuthority : this.nativeAuthority) === undefined) {
        return err(appError('INVALID_INPUT', 'Contained writer trusted native authority is unavailable'));
      }
      if (input.nativeReceiptPath === undefined || !path.isAbsolute(input.nativeReceiptPath)
        || path.basename(input.nativeReceiptPath) !== 'containment.receipt.json'
        || path.basename(path.dirname(input.nativeReceiptPath)) !== nativeBinding.taskId) {
        return err(appError('INVALID_INPUT', 'Contained writer receipt path does not match native attempt identity'));
      }
    }
    if (this.platform === 'darwin' && nativeBinding !== undefined && !await this.macosNativeAuthority?.register(nativeBinding)) {
      return err(appError('CONFLICT', 'macOS native process owner could not register this attempt; no reservation was created'));
    }
    const reserved = await this.index.reserve({
      taskId: id,
      capacityClass: 'managed_writer',
      requestDigest: digest,
      mutationKind: input.kind === 'synchronous_mutation'
        ? 'synchronous_mutation'
        : input.kind === 'uncontained_process' ? 'opaque_uncontained' : 'opaque_contained_process',
      ...(input.nativeReceiptPath === undefined ? {} : { nativeReceiptPath: input.nativeReceiptPath }),
      ...(nativeBinding === undefined ? {} : { nativeBinding }),
      ownerClientId: input.actorClientId,
      ownerWorkspaceId: input.workspaceId,
    });
    if (!reserved.ok) {
      if (this.platform === 'darwin' && nativeBinding !== undefined) await this.macosNativeAuthority?.abortBeforeLaunch({ binding: nativeBinding });
      return reserved;
    }
    const release = async (): Promise<void> => {
      await this.index.release(id, digest);
      if (await this.index.hasReservation(id, digest)) throw new Error('MANAGED_WRITER_RELEASE_UNVERIFIED');
    };
    const receiptPath = input.nativeReceiptPath;
    return ok({
      id,
      ...(nativeBinding === undefined ? {} : { nativeBinding }),
      releaseAfterVerifiedTermination: release,
      abortBeforeLaunch: async (): Promise<void> => {
        if (nativeBinding !== undefined && receiptPath !== undefined) {
          const authority = this.platform === 'darwin' ? this.macosNativeAuthority : this.nativeAuthority;
          const proof = await authority?.abortBeforeLaunch({ directory: path.dirname(receiptPath), binding: nativeBinding });
          if (proof?.state !== 'launch_not_started') throw new Error('MANAGED_WRITER_ABORT_UNVERIFIED');
        }
        await release();
      },
    });
  }

  private async inspectNativeWriter(reservation: DurableTaskReservation): Promise<NativeWriterInspection> {
    const binding = reservation.nativeBinding;
    const authority = this.platform === 'darwin' ? this.macosNativeAuthority : this.nativeAuthority;
    if (authority === undefined) return { state: 'unknown', reason: 'NATIVE_WRITER_AUTHORITY_UNAVAILABLE' };
    if (binding === undefined || reservation.nativeReceiptPath === undefined
      || binding.reservationId !== reservation.taskId || binding.requestDigest !== reservation.requestDigest
      || binding.ownerClientId !== reservation.ownerClientId || binding.workspaceId !== reservation.ownerWorkspaceId
      || path.basename(reservation.nativeReceiptPath) !== 'containment.receipt.json'
      || path.basename(path.dirname(reservation.nativeReceiptPath)) !== binding.taskId) {
      return { state: 'unknown', reason: 'NATIVE_RESERVATION_IDENTITY_UNAVAILABLE' };
    }
    let proof = await authority.inspect({ directory: path.dirname(reservation.nativeReceiptPath), binding });
    // The service atomically checks dispatch state and writes an exact-attempt
    // tombstone. A dispatched or unverifiable attempt cannot take this path.
    if (proof.state === 'termination_unknown' && proof.reason === 'NATIVE_SERVICE_ATTEMPT_NOT_DISPATCHED') {
      proof = await authority.abortBeforeLaunch({ directory: path.dirname(reservation.nativeReceiptPath), binding });
    }
    if (proof.state === 'termination_unknown' && reservation.reservedAt !== undefined
      && proof.reason !== 'SERVICE_ENDPOINT_PACKAGE_MISMATCH' && proof.reason !== 'SERVICE_ENDPOINT_NOT_INSTALLED') {
      proof = await authority.recoverAfterReboot({
        directory: path.dirname(reservation.nativeReceiptPath), binding, recordedAt: reservation.reservedAt,
      });
    }
    if (proof.state === 'running') return { state: 'active' };
    if (proof.state === 'termination_unknown') {
      return { state: 'unknown', reason: /^[A-Z][A-Z0-9_]{1,100}$/.test(proof.reason) ? proof.reason : 'NATIVE_WRITER_PROOF_UNAVAILABLE' };
    }
    return { state: 'terminal' };
  }
}

async function disjointWorkspaceRoots(left: string, right: string): Promise<boolean> {
  const describe = async (root: string): Promise<{ canonical: string; dev: bigint; ino: bigint } | null> => {
    const canonical = await realpath(root);
    const identity = await stat(canonical, { bigint: true });
    const marker = await lstat(path.join(canonical, '.git')).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    // A linked checkout, junction or unresolved directory may share a resource.
    if (!identity.isDirectory() || identity.ino === 0n || (marker !== null && !marker.isDirectory())) return null;
    return { canonical, dev: identity.dev, ino: identity.ino };
  };
  const [a, b] = await Promise.all([describe(left), describe(right)]);
  const outside = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  };
  return a !== null && b !== null && (a.dev !== b.dev || a.ino !== b.ino)
    && outside(a.canonical, b.canonical) && outside(b.canonical, a.canonical);
}
