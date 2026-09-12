import { createHash } from 'node:crypto';
import type { AppError, Result } from '@lnwjud/domain';

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpImageContent {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

export interface McpToolResponse {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export function mapResult<T>(result: Result<T>): McpToolResponse {
  if (!result.ok) return mapError(result.error);

  const integrityFailure = validateImagePayloads(result.value);
  if (integrityFailure !== undefined) return mapImageIntegrityFailure(integrityFailure);

  const passthrough = extractMcpToolResponse(result.value);
  if (passthrough !== undefined) return passthrough;

  const image = extractImageContent(result.value);
  const metadataValue = image === undefined ? result.value : stripImagePayloads(result.value);
  const structuredContent = toStructuredContent(metadataValue);
  return {
    content: image === undefined
      ? [{ type: 'text', text: toText(metadataValue) }]
      : [image, { type: 'text', text: toText(metadataValue) }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

export function mapError(error: AppError): McpToolResponse {
  const message = error.code === 'INTERNAL_ERROR' ? 'Operation failed' : error.message;
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${message}` }],
    structuredContent: {
      error: {
        code: error.code,
        message,
        recoverable: error.recoverable,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}

interface ImageIntegrityFailure {
  readonly reason: string;
  readonly mimeType: string;
  readonly expectedByteLength?: number;
  readonly actualByteLength?: number;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly expectedWidth?: number;
  readonly actualWidth?: number;
  readonly expectedHeight?: number;
  readonly actualHeight?: number;
}

function mapImageIntegrityFailure(failure: ImageIntegrityFailure): McpToolResponse {
  return {
    isError: true,
    content: [{ type: 'text', text: `INTERNAL_ERROR: Image payload integrity check failed: ${failure.reason}` }],
    structuredContent: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Image payload integrity check failed',
        recoverable: true,
        details: failure,
      },
    },
  };
}

function validateImagePayloads(value: unknown): ImageIntegrityFailure | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = validateImagePayloads(item);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.data_base64 === 'string' && typeof record.mime_type === 'string' && record.mime_type.startsWith('image/')) {
    return validateEncodedImage(record.data_base64, record.mime_type, record);
  }
  if (record.encoding === 'base64' && typeof record.content === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    return validateEncodedImage(record.content, record.mimeType, record);
  }
  if (record.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    return validateEncodedImage(record.data, record.mimeType, record);
  }

  for (const nested of Object.values(record)) {
    const failure = validateImagePayloads(nested);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function validateEncodedImage(data: string, mimeType: string, metadata: Record<string, unknown>): ImageIntegrityFailure | undefined {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return { reason: 'Image data is not canonical base64', mimeType };
  }

  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')) {
    return { reason: 'Image base64 could not be decoded losslessly', mimeType };
  }

  const expectedByteLength = readPositiveInteger(metadata.byte_length ?? metadata.byteLength);
  if (expectedByteLength !== undefined && expectedByteLength !== bytes.length) {
    return { reason: 'Decoded image byte length does not match metadata', mimeType, expectedByteLength, actualByteLength: bytes.length };
  }

  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  const expectedSha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(metadata.sha256) ? metadata.sha256.toLowerCase() : undefined;
  if (expectedSha256 !== undefined && expectedSha256 !== actualSha256) {
    return { reason: 'Decoded image SHA-256 does not match metadata', mimeType, expectedSha256, actualSha256 };
  }

  if (mimeType === 'image/png') {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    const iend = Buffer.from('0000000049454e44ae426082', 'hex');
    if (bytes.length < 24 || !bytes.subarray(0, signature.length).equals(signature)) {
      return { reason: 'PNG signature is missing or truncated', mimeType, actualByteLength: bytes.length, actualSha256 };
    }
    if (bytes.length < iend.length || !bytes.subarray(bytes.length - iend.length).equals(iend)) {
      return { reason: 'PNG IEND trailer is missing; image payload is truncated', mimeType, actualByteLength: bytes.length, actualSha256 };
    }
    const actualWidth = bytes.readUInt32BE(16);
    const actualHeight = bytes.readUInt32BE(20);
    const expectedWidth = readPositiveInteger(metadata.width);
    const expectedHeight = readPositiveInteger(metadata.height);
    if (expectedWidth !== undefined && expectedWidth !== actualWidth) {
      return { reason: 'PNG width does not match metadata', mimeType, expectedWidth, actualWidth, actualByteLength: bytes.length, actualSha256 };
    }
    if (expectedHeight !== undefined && expectedHeight !== actualHeight) {
      return { reason: 'PNG height does not match metadata', mimeType, expectedHeight, actualHeight, actualByteLength: bytes.length, actualSha256 };
    }
  } else if (mimeType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      return { reason: 'JPEG start/end markers are missing; image payload is truncated', mimeType, actualByteLength: bytes.length, actualSha256 };
    }
  } else if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    if ((header !== 'GIF87a' && header !== 'GIF89a') || bytes[bytes.length - 1] !== 0x3b) {
      return { reason: 'GIF header/trailer is invalid or truncated', mimeType, actualByteLength: bytes.length, actualSha256 };
    }
  } else if (mimeType === 'image/webp') {
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
      return { reason: 'WebP RIFF container length is invalid or truncated', mimeType, actualByteLength: bytes.length, actualSha256 };
    }
  }

  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function extractMcpToolResponse(value: unknown): McpToolResponse | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return undefined;

  const content: McpContent[] = [];
  for (const item of record.content) {
    const parsed = readMcpContent(item);
    if (parsed === undefined) return undefined;
    content.push(parsed);
  }

  const structuredContent = toStructuredContent(stripImagePayloads(record.structuredContent));
  return {
    content,
    ...(record.isError === true ? { isError: true } : {}),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function readMcpContent(value: unknown): McpContent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') {
    return { type: 'text', text: record.text };
  }
  if (record.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    return { type: 'image', data: record.data, mimeType: record.mimeType };
  }
  return undefined;
}

function toText(value: unknown): string {
  if (value === undefined) return 'null';
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

function toStructuredContent(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value };
  return value as Readonly<Record<string, unknown>>;
}

function extractImageContent(value: unknown): McpImageContent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (record.encoding === 'base64' && typeof record.content === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    return { type: 'image', data: record.content, mimeType: record.mimeType };
  }
  if (typeof record.data_base64 === 'string' && typeof record.mime_type === 'string' && record.mime_type.startsWith('image/')) {
    return { type: 'image', data: record.data_base64, mimeType: record.mime_type };
  }
  return extractImageContent(record.image);
}

function stripImagePayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImagePayloads);
  if (typeof value !== 'object' || value === null) return value;

  const record = value as Record<string, unknown>;
  const omitContent = record.encoding === 'base64'
    && typeof record.content === 'string'
    && typeof record.mimeType === 'string'
    && record.mimeType.startsWith('image/');
  const omitDataBase64 = typeof record.data_base64 === 'string'
    && typeof record.mime_type === 'string'
    && record.mime_type.startsWith('image/');
  const omitMcpImageData = record.type === 'image'
    && typeof record.data === 'string'
    && typeof record.mimeType === 'string'
    && record.mimeType.startsWith('image/');

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if ((omitContent && key === 'content') || (omitDataBase64 && key === 'data_base64') || (omitMcpImageData && key === 'data')) continue;
    sanitized[key] = stripImagePayloads(nested);
  }
  return sanitized;
}
