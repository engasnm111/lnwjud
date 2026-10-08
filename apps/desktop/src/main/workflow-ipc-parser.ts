import type { CallHistoryRequest, ResourceSnapshotRequest, WorkflowPrepareRequest } from '@lnwjud/ipc-contracts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid workflow IPC payload');
  return value as RecordValue;
}
function bounded(value: unknown, limit = 128): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit || value.includes('\0')) {
    throw new Error('Invalid workflow IPC field');
  }
  return value;
}
function guardKeys(input: RecordValue, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error('Unexpected workflow IPC field');
}
export function parseWorkflowWorkspace(value: unknown): { workspaceId: string } {
  const input = record(value);
  guardKeys(input, ['workspaceId']);
  return { workspaceId: bounded(input.workspaceId) };
}
export function parseDoctorGoalsRequest(value: unknown): { workspaceId: string; view?: 'calls' | 'results' } {
  const input = record(value);
  guardKeys(input, ['workspaceId', 'view']);
  const workspaceId = bounded(input.workspaceId);
  if (input.view === undefined) return { workspaceId };
  if (input.view !== 'calls' && input.view !== 'results') throw new Error('Invalid Doctor Goal view');
  return { workspaceId, view: input.view };
}

export function parseWorkflowPrepare(value: unknown): WorkflowPrepareRequest {
  const input = record(value);
  guardKeys(input, ['workspaceId', 'templateId', 'inputs']);
  const templateId = bounded(input.templateId, 40);
  if (!['project-check','code-review','release-readiness','connection-check','data-audit','template-report'].includes(templateId)) {
    throw new Error('Unknown workflow template');
  }
  const rawInputs = record(input.inputs);
  if (Object.keys(rawInputs).length > 16) throw new Error('Too many workflow inputs');
  const values: Record<string, string> = Object.create(null);
  for (const [key, raw] of Object.entries(rawInputs)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(key) || typeof raw !== 'string'
      || raw.length > 1024 || raw.includes('\0')) throw new Error('Invalid workflow input');
    values[key] = raw;
  }
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 16_384) throw new Error('Workflow inputs exceed limit');
  return { workspaceId: bounded(input.workspaceId), templateId: templateId as WorkflowPrepareRequest['templateId'], inputs: values };
}
export function parseCallHistory(value: unknown): CallHistoryRequest {
  const input = record(value);
  guardKeys(input, ['workspaceId','goalId','toolName','transport','since','until','limit','cursor']);
  const response: {
    workspaceId: string; goalId?: string; toolName?: string; transport?: NonNullable<CallHistoryRequest['transport']>;
    since?: string; until?: string; limit?: number; cursor?: string;
  } = { workspaceId: bounded(input.workspaceId) };
  if (input.goalId !== undefined) response.goalId = bounded(input.goalId);
  if (input.toolName !== undefined) response.toolName = bounded(input.toolName);
  if (input.transport !== undefined) {
    if (!['local_stdio','loopback_http','secure_tunnel','external_mcp','unknown'].includes(String(input.transport))) {
      throw new Error('Invalid call transport');
    }
    response.transport = input.transport as NonNullable<CallHistoryRequest['transport']>;
  }
  for (const key of ['since', 'until'] as const) {
    const date = input[key];
    if (date !== undefined) {
      const parsed = bounded(date, 64);
      if (Number.isNaN(Date.parse(parsed))) throw new Error('Invalid call window');
      response[key] = parsed;
    }
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 200) throw new Error('Invalid call limit');
    response.limit = input.limit as number;
  }
  if (input.cursor !== undefined) response.cursor = bounded(input.cursor, 1024);
  return response;
}
export function parseWorkflowGoal(value: unknown): { readonly workspaceId: string; readonly goalId: string } {
  const input = record(value);
  guardKeys(input, ['workspaceId', 'goalId']);
  return { workspaceId: bounded(input.workspaceId), goalId: bounded(input.goalId) };
}

export function parseRestoreTaskCheckpoint(value: unknown): import('@lnwjud/ipc-contracts').RestoreTaskCheckpointRequest {
  const input = record(value);
  guardKeys(input, ['workspaceId','goalId','goalRevision','checkpointId','expectedCurrentHashes','userConfirmed']);
  if (!Number.isSafeInteger(input.goalRevision) || (input.goalRevision as number) < 0 || input.userConfirmed !== true) {
    throw new Error('Restore requires current Goal revision and explicit confirmation');
  }
  const hashes = record(input.expectedCurrentHashes);
  const paths = Object.keys(hashes);
  if (paths.length < 1 || paths.length > 20) throw new Error('Restore requires hashes for 1–20 files');
  const values: Record<string,string> = Object.create(null);
  for (const path of paths) {
    if (path.length < 1 || path.length > 1024 || path.includes('\0') || typeof hashes[path] !== 'string'
      || !/^[a-f0-9]{64}$/i.test(hashes[path] as string)) {
      throw new Error('Invalid expected restore hash or file path');
    }
    values[path] = hashes[path] as string;
  }
  return {
    workspaceId: bounded(input.workspaceId), goalId: bounded(input.goalId),
    goalRevision: input.goalRevision as number, checkpointId: bounded(input.checkpointId),
    expectedCurrentHashes: values, userConfirmed: true,
  };
}
export function parseCancelOwnedGoalTask(value: unknown): import('@lnwjud/ipc-contracts').CancelOwnedGoalTaskRequest {
  const input=record(value);
  guardKeys(input,['workspaceId','goalId','taskId','provider','userConfirmed']);
  const provider=bounded(input.provider,20);
  if (!['process','codex','shell'].includes(provider) || input.userConfirmed !== true) {
    throw new Error('Task cancellation requires explicit confirmation and a supported provider');
  }
  return {
    workspaceId: bounded(input.workspaceId), goalId: bounded(input.goalId),
    taskId: bounded(input.taskId,256), provider: provider as 'process'|'codex'|'shell',
    userConfirmed: true,
  };
}
export function parseResourceSnapshot(value: unknown): ResourceSnapshotRequest {
  const input = record(value);
  guardKeys(input, ['workspaceId','goalId']);
  return { workspaceId: bounded(input.workspaceId), ...(input.goalId === undefined ? {} : { goalId: bounded(input.goalId) }) };
}
