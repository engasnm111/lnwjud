import { randomUUID } from 'node:crypto';

export interface ActivitySinkEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly phase: 'started' | 'completed';
  readonly resultCode: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly targetSummary?: string;
  readonly timestamp: string;
}

export interface ActivitySink {
  record(event: ActivitySinkEvent): Promise<void>;
}

export interface InFlightToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly workspaceId?: string;
  readonly targetSummary?: string;
}

export class ActivityTracker {
  private readonly inflight = new Map<string, InFlightToolCall>();

  public constructor(private readonly sink?: ActivitySink) {}

  public listInFlight(): readonly InFlightToolCall[] {
    return [...this.inflight.values()];
  }

  public async begin(toolName: string, input: unknown): Promise<string> {
    const callId = randomUUID();
    const timestamp = new Date().toISOString();
    const workspaceId = readWorkspaceId(input);
    const targetSummary = summarizeToolTarget(toolName, input);
    const entry: InFlightToolCall = {
      callId,
      toolName,
      startedAt: timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
    };
    this.inflight.set(callId, entry);
    await this.safeRecord({
      callId,
      toolName,
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
    });
    return callId;
  }

  public async end(callId: string, resultCode: string, durationMs: number): Promise<void> {
    const existing = this.inflight.get(callId);
    this.inflight.delete(callId);
    const timestamp = new Date().toISOString();
    await this.safeRecord({
      callId,
      toolName: existing?.toolName ?? 'unknown',
      phase: 'completed',
      resultCode,
      durationMs,
      timestamp,
      ...(existing?.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
      ...(existing?.targetSummary === undefined ? {} : { targetSummary: existing.targetSummary }),
    });
  }

  private async safeRecord(event: ActivitySinkEvent): Promise<void> {
    if (this.sink === undefined) return;
    try {
      await this.sink.record(event);
    } catch {
      // Activity recording must never fail tool execution.
    }
  }
}

export function summarizeToolTarget(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const pathValue = firstString(input, ['path', 'relativePath', 'filePath', 'targetPath']);
  if (pathValue !== undefined) return truncate(pathValue, 160);
  const query = firstString(input, ['query', 'pattern']);
  if (query !== undefined) return truncate(query, 120);
  const executable = firstString(input, ['executable', 'command']);
  if (executable !== undefined) {
    const args = Array.isArray(input.arguments)
      ? input.arguments.filter((entry): entry is string => typeof entry === 'string').slice(0, 4).join(' ')
      : Array.isArray(input.args)
        ? input.args.filter((entry): entry is string => typeof entry === 'string').slice(0, 4).join(' ')
        : '';
    return truncate(args.length > 0 ? `${executable} ${args}` : executable, 160);
  }
  const operation = firstString(input, ['operation', 'action', 'mode']);
  if (operation !== undefined) return truncate(`${toolName}:${operation}`, 120);
  const skillId = firstString(input, ['skillId', 'serverId', 'name']);
  if (skillId !== undefined) return truncate(skillId, 120);
  return undefined;
}

function readWorkspaceId(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
    return undefined;
  }
  return input.workspaceId;
}

function firstString(input: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
