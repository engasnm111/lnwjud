import type { NativeAttemptBinding } from './windows-native-authority.js';

export type ManagedProcessState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out' | 'termination_unverified';

export interface ManagedProcessStart {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Close stdin for non-interactive CLI children whose prompt was passed via argv. */
  readonly stdinMode?: 'ignore';
  /** Internal trusted host identity for native Job Object isolation, not an RPC field. */
  readonly containmentId?: string;
  /** Admission-issued binding, supplied only by trusted application composition. */
  readonly nativeBinding?: NativeAttemptBinding;
}

export interface ManagedProcess {
  readonly processId: string;
  /** Host-owned child PID for read-only resource sampling; never use as an authorization token. */
  readonly pid?: number;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly state: ManagedProcessState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export type ProcessLogStream = 'stdout' | 'stderr';

export interface ProcessLogEntry {
  readonly sequence: number;
  readonly stream: ProcessLogStream;
  readonly text: string;
}

export interface LogQuery {
  readonly tailLines?: number;
  readonly sinceSequence?: number;
}

export interface ProcessLogResult {
  readonly entries: readonly ProcessLogEntry[];
  readonly truncated: boolean;
  readonly nextSequence: number;
}
