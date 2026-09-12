import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapError, mapResult } from './result-mapper.js';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_1X1, 'base64');
const PNG_SHA256 = createHash('sha256').update(PNG_BYTES).digest('hex');

describe('mapResult image payloads', () => {
  it('includes MCP image content for base64 image reads without duplicating binary data into metadata', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        path: 'pixel.png',
        content: PNG_1X1,
        encoding: 'base64',
        mimeType: 'image/png',
        startLine: 1,
        endLine: 1,
      },
    });

    expect(response.content[0]).toEqual({ type: 'image', data: PNG_1X1, mimeType: 'image/png' });
    expect(response.content[1]).toEqual({
      type: 'text',
      text: JSON.stringify({ path: 'pixel.png', encoding: 'base64', mimeType: 'image/png', startLine: 1, endLine: 1 }),
    });
    expect(response.structuredContent).toEqual({
      path: 'pixel.png',
      encoding: 'base64',
      mimeType: 'image/png',
      startLine: 1,
      endLine: 1,
    });
  });

  it('includes MCP image content for native vision and Set-of-Marks payloads without base64 duplication', () => {
    const direct = mapResult({
      ok: true as const,
      value: { format: 'png', mime_type: 'image/png', data_base64: PNG_1X1, byte_length: PNG_BYTES.length, sha256: PNG_SHA256, width: 1, height: 1 },
    });
    const annotated = mapResult({
      ok: true as const,
      value: { observationId: 'obs-1', image: { format: 'png', mime_type: 'image/png', data_base64: PNG_1X1, byte_length: PNG_BYTES.length, sha256: PNG_SHA256, width: 1, height: 1 } },
    });

    expect(direct.content[0]).toEqual({ type: 'image', data: PNG_1X1, mimeType: 'image/png' });
    expect(direct.content[1]?.type === 'text' ? direct.content[1].text : '').not.toContain(PNG_1X1);
    expect(direct.structuredContent).toEqual({
      format: 'png',
      mime_type: 'image/png',
      byte_length: PNG_BYTES.length,
      sha256: PNG_SHA256,
      width: 1,
      height: 1,
    });

    expect(annotated.content[0]).toEqual({ type: 'image', data: PNG_1X1, mimeType: 'image/png' });
    expect(annotated.content[1]?.type === 'text' ? annotated.content[1].text : '').not.toContain(PNG_1X1);
    expect(annotated.structuredContent).toEqual({
      observationId: 'obs-1',
      image: {
        format: 'png',
        mime_type: 'image/png',
        byte_length: PNG_BYTES.length,
        sha256: PNG_SHA256,
        width: 1,
        height: 1,
      },
    });
  });

  it('passes through child MCP image content instead of flattening it into JSON text', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        content: [
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
          { type: 'text', text: 'child caption' },
        ],
        structuredContent: {
          source: 'external',
          preview: { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
        },
      },
    });

    expect(response.content).toEqual([
      { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
      { type: 'text', text: 'child caption' },
    ]);
    expect(response.structuredContent).toEqual({
      source: 'external',
      preview: { type: 'image', mimeType: 'image/png' },
    });
  });

  it('fails closed when a PNG image payload is truncated or metadata no longer matches the bytes', () => {
    const truncated = PNG_BYTES.subarray(0, PNG_BYTES.length - 12).toString('base64');
    const truncatedResponse = mapResult({
      ok: true as const,
      value: { format: 'png', mime_type: 'image/png', data_base64: truncated, width: 1, height: 1 },
    });
    expect(truncatedResponse.isError).toBe(true);
    expect(truncatedResponse.content[0]).toMatchObject({ type: 'text' });
    expect(truncatedResponse.content[0]?.type === 'text' ? truncatedResponse.content[0].text : '').toContain('PNG IEND trailer is missing');

    const hashMismatchResponse = mapResult({
      ok: true as const,
      value: {
        format: 'png',
        mime_type: 'image/png',
        data_base64: PNG_1X1,
        byte_length: PNG_BYTES.length,
        sha256: '0'.repeat(64),
        width: 1,
        height: 1,
      },
    });
    expect(hashMismatchResponse.isError).toBe(true);
    expect(hashMismatchResponse.structuredContent).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Image payload integrity check failed',
        recoverable: true,
      },
    });
  });

  it('preserves child MCP error state while passing through its content', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        isError: true,
        content: [{ type: 'text', text: 'child failed' }],
      },
    });

    expect(response).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'child failed' }],
    });
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
