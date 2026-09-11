import { describe, expect, it } from 'vitest';
import { mapError, mapResult } from './result-mapper.js';

describe('mapResult image payloads', () => {
  it('includes MCP image content for base64 image reads without duplicating binary data into metadata', () => {
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
      value: { format: 'png', mime_type: 'image/png', data_base64: 'native-png', width: 10, height: 10 },
    });
    const annotated = mapResult({
      ok: true as const,
      value: { observationId: 'obs-1', image: { format: 'png', mime_type: 'image/png', data_base64: 'marked-png', width: 10, height: 10 } },
    });

    expect(direct.content[0]).toEqual({ type: 'image', data: 'native-png', mimeType: 'image/png' });
    expect(direct.content[1]?.type === 'text' ? direct.content[1].text : '').not.toContain('native-png');
    expect(direct.structuredContent).toEqual({ format: 'png', mime_type: 'image/png', width: 10, height: 10 });

    expect(annotated.content[0]).toEqual({ type: 'image', data: 'marked-png', mimeType: 'image/png' });
    expect(annotated.content[1]?.type === 'text' ? annotated.content[1].text : '').not.toContain('marked-png');
    expect(annotated.structuredContent).toEqual({
      observationId: 'obs-1',
      image: { format: 'png', mime_type: 'image/png', width: 10, height: 10 },
    });
  });

  it('passes through child MCP image content instead of flattening it into JSON text', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        content: [
          { type: 'image', data: 'child-png', mimeType: 'image/png' },
          { type: 'text', text: 'child caption' },
        ],
        structuredContent: {
          source: 'external',
          preview: { type: 'image', data: 'duplicate-png', mimeType: 'image/png' },
        },
      },
    });

    expect(response.content).toEqual([
      { type: 'image', data: 'child-png', mimeType: 'image/png' },
      { type: 'text', text: 'child caption' },
    ]);
    expect(response.structuredContent).toEqual({
      source: 'external',
      preview: { type: 'image', mimeType: 'image/png' },
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
