import { appError, type AppError } from '@lnwjud/domain';

const MAX_DIAGNOSTIC_TEXT = 8 * 1024;
const AUTHORIZATION_HEADER = /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*[^\s,;]+/gi;
const API_KEY_VALUE = /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g;

export interface DiagnosticError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type DiagnosticLogger = (event: DiagnosticError) => void;

export function sanitizeException(error: unknown, diagnostic?: DiagnosticLogger): AppError {
  const event = toDiagnosticError(error);
  try {
    diagnostic?.(event);
  } catch {
    // Diagnostics must never change the safe application result.
  }
  return appError('INTERNAL_ERROR', 'Operation failed', true);
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(API_KEY_VALUE, '[REDACTED]')
    .slice(0, MAX_DIAGNOSTIC_TEXT);
}

function toDiagnosticError(error: unknown): DiagnosticError {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: 'Non-Error exception' };
  const message = redactDiagnosticText(error.message);
  const stack = error.stack === undefined ? undefined : redactDiagnosticText(error.stack);
  return { name: redactDiagnosticText(error.name), message, ...(stack === undefined ? {} : { stack }) };
}
