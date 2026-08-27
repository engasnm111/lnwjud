export const CAPABILITY_TASK_OWNER_METADATA_KEY = 'lnwjud.taskOwner.v1';

export const CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY = 'lnwjud.activeWorkspaceRoot.v1';

export interface CapabilityTaskOwner {
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
}

export function readCapabilityTaskOwner(input: unknown): CapabilityTaskOwner {
  if (!isRecord(input)) return legacyCapabilityTaskOwner();
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_TASK_OWNER_METADATA_KEY];
  if (!isRecord(value)) return legacyCapabilityTaskOwner();
  const clientId = boundedString(value.clientId);
  const sessionId = boundedString(value.sessionId);
  const workspaceId = boundedString(value.workspaceId);
  if (clientId === undefined || sessionId === undefined) return legacyCapabilityTaskOwner();
  return { clientId, sessionId, ...(workspaceId === undefined ? {} : { workspaceId }) };
}

export function readCapabilityActiveWorkspaceRoot(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY];
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32_768 ? trimmed : undefined;
}

export function legacyCapabilityTaskOwner(): CapabilityTaskOwner {
  return { clientId: 'legacy', sessionId: 'legacy' };
}

export function capabilityTaskOwnerMatches(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): boolean {
  if (stored.clientId !== requester.clientId || stored.sessionId !== requester.sessionId) return false;
  if (requester.workspaceId !== undefined && stored.workspaceId !== requester.workspaceId) return false;
  return true;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
