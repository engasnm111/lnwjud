import type { DestructiveApprovalKey } from '@lnwjud/shared';
import { inspectMutationOperation, requiresMutationConfirmation } from './mutation-policy.js';
import type { McpPermissionLevel } from './tools/tool-types.js';

/** @deprecated Use MutationPolicyDecision from mutation-policy.ts. */
export interface DestructivePolicyDecision {
  readonly destructive: boolean;
  readonly reason?: string;
  readonly approvalKey?: DestructiveApprovalKey;
}

/**
 * Compatibility adapter for callers that still consume the former boolean
 * policy. Classification is delegated to the fail-closed mutation gateway so
 * this legacy surface cannot reintroduce regex/parser bypasses.
 */
export function inspectDestructiveOperation(toolName: string, input: unknown): DestructivePolicyDecision {
  const decision = inspectMutationOperation(toolName, input, legacyPermission(toolName));
  return {
    destructive: requiresMutationConfirmation(decision),
    reason: decision.reason,
    ...(decision.approvalKey === undefined ? {} : { approvalKey: decision.approvalKey }),
  };
}

export function hasExplicitUserConfirmation(input: unknown): boolean {
  return asRecord(input)?.userConfirmed === true;
}

function legacyPermission(toolName: string): McpPermissionLevel {
  if (['read_file', 'read_files', 'list_recovery_items', 'web_fetch', 'dom_cdp', 'accessibility'].includes(toolName)) return 'READ';
  if (['write_file', 'apply_patch', 'edit_file', 'move_file', 'copy_file', 'office'].includes(toolName)) return 'WRITE';
  if (toolName === 'delete_file') return 'DANGEROUS';
  return 'EXECUTE';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
