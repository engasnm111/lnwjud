import type { McpToolResponse } from './result-mapper.js';

/** Evidence only from first-party successful handlers. Never inspect raw caller-provided path for attribution. */
export interface VerifiedMutationReceipt {
  readonly path: string;
  readonly action: string;
  readonly checkpointId?: string;
  readonly afterSha256?: string;
  readonly sizeBytes?: number;
  readonly verification?: 'verified';
}
const FILE_TOOLS = new Set(['write_file','edit_file','move_file','copy_file']);
const VERIFIED_HASH = /^[a-f0-9]{64}$/u;

export function observedMutationReceipt(toolName: string, response: McpToolResponse): VerifiedMutationReceipt | undefined {
  if (response.isError || !response.structuredContent) return undefined;
  const data = response.structuredContent;
  if (!FILE_TOOLS.has(toolName) && toolName !== 'office_excel') return undefined;
  if (toolName === 'office_excel' && !(data.verification === 'verified' && data.provider === 'file_xlsx')) return undefined;
  const pathValue = toolName === 'office_excel' ? data.outputPath : data.path;
  if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.length > 4096 || pathValue.includes('\0')) return undefined;
  const checkpointId = typeof data.checkpointId === 'string' && data.checkpointId.length <= 128 ? data.checkpointId : undefined;
  const afterSha256 = typeof data.sha256 === 'string' && VERIFIED_HASH.test(data.sha256) ? data.sha256 : undefined;
  const sizeBytes = typeof data.sizeBytes === 'number' && Number.isSafeInteger(data.sizeBytes)
    && data.sizeBytes >= 0 ? data.sizeBytes : undefined;
  return {
    path:pathValue, action: toolName,
    ...(checkpointId===undefined?{}:{checkpointId}),
    ...(afterSha256===undefined?{}:{afterSha256}),
    ...(sizeBytes===undefined?{}:{sizeBytes}),
    ...(toolName==='office_excel' && afterSha256!==undefined?{verification:'verified' as const}:{}),
  };
}
