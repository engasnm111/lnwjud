import type { Result } from '@lnwjud/domain';
import type { NativeAttemptBinding } from '@lnwjud/process';

export interface ManagedWriterAdmissionLease {
  readonly id: string;
  readonly nativeBinding?: NativeAttemptBinding;
  abortBeforeLaunch?(): Promise<void>;
  /** Release only when the mutation and all child processes are provably terminal. */
  releaseAfterVerifiedTermination(): Promise<void>;
}

export interface ManagedWriterAdmissionPort {
  enter(input: {
    readonly actorClientId: string;
    readonly actorSessionId?: string;
    readonly nativeTaskId?: string;
    readonly workspaceId: string;
    readonly kind: 'synchronous_mutation' | 'uncontained_process' | 'contained_process';
    readonly nativeReceiptPath?: string;
  }): Promise<Result<ManagedWriterAdmissionLease>>;
}
