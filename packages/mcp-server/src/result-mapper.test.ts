import { describe, expect, it } from 'vitest';
import { mapError, mapResult } from './result-mapper.js';

describe('mapResult image payloads', () => {
  it('includes MCP image content for base64 image reads', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        path: 'pixel.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64',
        mimeType: 'image/png',
        startLine: 1,
        endLine: 1,
      },
    });

    expect(response.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('keeps filesystem error messages instead of Operation failed', () => {
    const response = mapError({ code: 'FILE_NOT_FOUND', message: 'File or directory was not found', recoverable: false });
    expect(response.content[0]?.text).toBe('FILE_NOT_FOUND: File or directory was not found');
  });

  it('preserves structured recovery details on provider failures', () => {
    const response = mapError({
      code: 'INTERNAL_ERROR',
      message: 'provider failed after backup',
      recoverable: true,
      details: {
        replacementRecoveryId: 'recovery-123',
        replacementRecoveryPath: 'E:\\recovery\\recovery-123\\payload',
      },
    });

    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Operation failed',
        recoverable: true,
        details: {
          replacementRecoveryId: 'recovery-123',
          replacementRecoveryPath: 'E:\\recovery\\recovery-123\\payload',
        },
      },
    });
  });
});
