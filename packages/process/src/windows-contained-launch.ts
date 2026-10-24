import type { ChildProcess } from 'node:child_process';
import type { NativeAttemptBinding, NativeProcessObservation, WindowsNativeAuthority } from './windows-native-authority.js';

export interface WindowsContainedLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  connect(child: ChildProcess): Promise<NativeProcessObservation>;
  inspect(): Promise<NativeProcessObservation>;
  cancel(): Promise<NativeProcessObservation>;
  abortBeforeLaunch(): Promise<NativeProcessObservation>;
  dispose(): void;
}
export interface WindowsContainmentReceipt {
  readonly kind: 'windows_job_v2';
  readonly outcome: 'completed' | 'cancelled' | 'timed_out' | 'interrupted';
  readonly exitCode: number;
  readonly activeProcesses: 0;
}
export interface WindowsContainedLaunchInput {
  readonly directory: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly windowsVerbatimArguments?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly binding?: NativeAttemptBinding;
  readonly authority?: WindowsNativeAuthority;
}
/** Trusted host authority is mandatory; the service verifies process identity and terminal state. */
export async function prepareWindowsContainedLaunch(input: WindowsContainedLaunchInput): Promise<WindowsContainedLaunch> {
  if (input.authority === undefined || input.binding === undefined) throw new Error('WINDOWS_CONTAINMENT_AUTHORITY_REQUIRED');
  return input.authority.prepare({ ...input, binding: input.binding });
}
/** A path alone carries no issuer or reservation authority. */
export async function readWindowsContainmentReceipt(_filename: string, trusted?: { readonly authority: WindowsNativeAuthority; readonly directory: string; readonly binding: NativeAttemptBinding }): Promise<WindowsContainmentReceipt | undefined> {
  if (trusted === undefined) return undefined;
  const observation = await trusted.authority.inspect(trusted);
  return observation.state === 'terminal_verified'
    ? { kind: 'windows_job_v2', outcome: observation.outcome, exitCode: observation.exitCode, activeProcesses: 0 }
    : undefined;
}
