import { describe, expect, it } from 'vitest';
import { sanitizeException } from './error-sanitizer.js';

describe('sanitizeException', () => {
  it('returns a stable internal error and only redacted diagnostic metadata', () => {
    const diagnostics: unknown[] = [];
    const exception = new Error('TOKEN=super-secret SECRET=private-value');
    exception.stack = 'Error: TOKEN=super-secret SECRET=private-value\n    at C:\\workspace\\service.ts:10:4';

    const result = sanitizeException(exception, (event) => diagnostics.push(event));

    expect(result).toEqual({ code: 'INTERNAL_ERROR', message: 'Operation failed', recoverable: true });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('super-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('private-value');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ name: 'Error' });
  });

  it('handles non-Error exceptions without exposing their value', () => {
    const diagnostics: unknown[] = [];

    const result = sanitizeException({ token: 'do-not-log' }, (event) => diagnostics.push(event));

    expect(result).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Operation failed' });
    expect(JSON.stringify(diagnostics)).not.toContain('do-not-log');
  });
});
