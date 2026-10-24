import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { parseNativeAttemptBinding, type NativeAttemptBinding, type WindowsNativeAuthority } from '@lnwjud/process';
import { DurableShellTaskIndex, type DurableTaskReservation } from './durable-shell-task-index.js';
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

  constructor(taskDirectory: string, private readonly nativeAuthority?: WindowsNativeAuthority, private readonly platform: NodeJS.Platform = process.platform) {
    const store = new DurableShellTaskStore(taskDirectory, { ...(nativeAuthority === undefined ? {} : { windowsNativeAuthority: nativeAuthority }) });
    this.index = new DurableShellTaskIndex(taskDirectory, {
      maxConcurrentTasks: 10000,
      capacityClass: 'managed_writer',
      inspectTask: (taskId): ReturnType<DurableShellTaskStore['inspectForWriterAdmission']> =>
        store.inspectForWriterAdmission(taskId),
      verifyContainedTermination: (reservation): ReturnType<SharedManagedWriterAdmission['verifyNativeTermination']> => this.verifyNativeTermination(reservation),
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
    const reserved = await this.index.reserve({
      taskId: id,
      capacityClass: 'managed_writer',
      requestDigest,
      mutationKind: 'repository_import',
      ownerClientId: 'lnwjud-workspace-writer-fence',
      ownerWorkspaceId: workspaceId,
    });
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
    if (this.platform === 'darwin' && input.kind !== 'synchronous_mutation') {
      return err(appError('CONFLICT', 'macOS process writer containment unavailable: escaped descendants are not kernel-fenced'));
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
      if (this.nativeAuthority === undefined) {
        return err(appError('INVALID_INPUT', 'Contained writer trusted native authority is unavailable'));
      }
      if (input.nativeReceiptPath === undefined || !path.isAbsolute(input.nativeReceiptPath)
        || path.basename(input.nativeReceiptPath) !== 'containment.receipt.json'
        || path.basename(path.dirname(input.nativeReceiptPath)) !== nativeBinding.taskId) {
        return err(appError('INVALID_INPUT', 'Contained writer receipt path does not match native attempt identity'));
      }
    }
    const reserved = await this.index.reserve({
      taskId: id,
      capacityClass: 'managed_writer',
      requestDigest: digest,
      mutationKind: input.kind === 'uncontained_process' ? 'opaque_uncontained' : input.kind === 'contained_process' ? 'opaque_contained_process' : 'opaque',
      ...(input.nativeReceiptPath === undefined ? {} : { nativeReceiptPath: input.nativeReceiptPath }),
      ...(nativeBinding === undefined ? {} : { nativeBinding }),
      ownerClientId: input.actorClientId,
      ownerWorkspaceId: input.workspaceId,
    });
    if (!reserved.ok) return reserved;
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
          const proof = await this.nativeAuthority?.abortBeforeLaunch({ directory: path.dirname(receiptPath), binding: nativeBinding });
          if (proof?.state !== 'launch_not_started') throw new Error('MANAGED_WRITER_ABORT_UNVERIFIED');
        }
        await release();
      },
    });
  }

  private async verifyNativeTermination(reservation: DurableTaskReservation): Promise<boolean> {
    const binding = reservation.nativeBinding;
    if (this.nativeAuthority === undefined || binding === undefined || reservation.nativeReceiptPath === undefined
      || binding.reservationId !== reservation.taskId || binding.requestDigest !== reservation.requestDigest
      || binding.ownerClientId !== reservation.ownerClientId || binding.workspaceId !== reservation.ownerWorkspaceId
      || path.basename(reservation.nativeReceiptPath) !== 'containment.receipt.json'
      || path.basename(path.dirname(reservation.nativeReceiptPath)) !== binding.taskId) return false;
    let proof = await this.nativeAuthority.inspect({ directory: path.dirname(reservation.nativeReceiptPath), binding });
    if (proof.state === 'termination_unknown' && proof.reason === 'NATIVE_SERVICE_ATTEMPT_NOT_DISPATCHED') {
      proof = await this.nativeAuthority.abortBeforeLaunch({ directory: path.dirname(reservation.nativeReceiptPath), binding });
    }
    return proof.state === 'terminal_verified' || proof.state === 'launch_not_started';
  }
}
