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
