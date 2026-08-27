import type { Result } from '@lnwjud/domain';

export interface ReplacementRecoveryBackup {
  readonly recoveryId: string;
  readonly recoveryPath: string;
}

/**
 * A provider can fail after lnwjud has already captured the target pre-image.
 * Preserve the original error semantics while making that recovery artifact
 * discoverable to the caller. The backup is intentionally not deleted here.
 */
export function withReplacementRecoveryDetails<T>(
  result: Result<T>,
  backup: ReplacementRecoveryBackup | undefined,
): Result<T> {
  if (result.ok || backup === undefined) return result;
  return {
    ok: false,
    error: {
      ...result.error,
      details: {
        ...(result.error.details ?? {}),
        replacementRecoveryId: backup.recoveryId,
        replacementRecoveryPath: backup.recoveryPath,
      },
    },
  };
}
