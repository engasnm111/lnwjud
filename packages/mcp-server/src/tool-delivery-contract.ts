export type ToolDeliveryState = 'operational' | 'dependency_gated' | 'feature_disabled' | 'planned';

export type ToolUnavailableStatus = 'needs_setup' | 'disabled' | 'unsupported';

export type ToolRuntimeEvidence =
  | { readonly kind: 'service_dispatch'; readonly serviceCall: string }
  | { readonly kind: 'deterministic_operation' }
  | { readonly kind: 'truthful_unavailable'; readonly unavailableStatus: ToolUnavailableStatus };

export function isAdvertisedDeliveryState(state: ToolDeliveryState): boolean {
  return state === 'operational' || state === 'dependency_gated';
}

export function truthfulUnavailable(
  tool: string,
  status: ToolUnavailableStatus,
  requirements: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({ tool, status, available: false, ready: false, executed: false, requirements: [...requirements] });
}
