export type InvocationAuthorizationMode = 'standard' | 'full_bypass';

export type InvocationAuthorizationSource =
  | 'profile'
  | 'explicit_user'
  | 'scoped_policy'
  | 'host_approval'
  | 'full_bypass';

/**
 * Trusted, per-invocation authorization established by the MCP gateway.
 *
 * This is deliberately separate from tool input. A profile or Full Bypass may
 * authorize an operation, but it must never be misreported as caller-supplied
 * `userConfirmed: true`.
 */
export interface InvocationAuthorization {
  readonly mode: InvocationAuthorizationMode;
  readonly applicationApproved: boolean;
  readonly bypassApplicationAuthorization: boolean;
  readonly source: InvocationAuthorizationSource;
}

export function isFullBypassAuthorization(
  authorization: InvocationAuthorization | undefined,
): boolean {
  return authorization?.mode === 'full_bypass'
    && authorization.applicationApproved
    && authorization.bypassApplicationAuthorization;
}

export function isApplicationAuthorized(
  authorization: InvocationAuthorization | undefined,
  callerConfirmed = false,
): boolean {
  return callerConfirmed || authorization?.applicationApproved === true;
}
