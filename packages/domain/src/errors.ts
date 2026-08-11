export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'WORKSPACE_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SECRET_ACCESS_DENIED'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_REQUIRED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_TIMEOUT'
  | 'EXECUTABLE_NOT_FOUND'
  | 'GIT_NOT_REPOSITORY'
  | 'CODEX_NOT_AVAILABLE'
  | 'INTERNAL_ERROR';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, string | number>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

export function appError(code: AppErrorCode, message: string, recoverable = false): AppError {
  return { code, message, recoverable };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: AppError): Result<T> {
  return { ok: false, error };
}
