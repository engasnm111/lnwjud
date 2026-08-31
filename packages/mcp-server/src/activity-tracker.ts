import { randomUUID } from 'node:crypto';

export interface ActivitySinkEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly phase: 'started' | 'completed';
  readonly resultCode: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly resultMessage?: string;
  readonly timestamp: string;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}

export interface TraceContext {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
}

export interface ActivitySink {
  record(event: ActivitySinkEvent): Promise<void>;
}

export type ActivityRecordErrorHandler = (error: unknown, event: ActivitySinkEvent) => void;

export interface InFlightToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}

export class ActivityTracker {
  private readonly inflight = new Map<string, InFlightToolCall>();
  private activityRevision = 0;

  public constructor(
    private readonly sink?: ActivitySink,
    private readonly onRecordError?: ActivityRecordErrorHandler,
  ) {}

  public listInFlight(): readonly InFlightToolCall[] {
    return [...this.inflight.values()];
  }

  public revision(): number {
    return this.activityRevision;
  }

  public async begin(
    toolName: string,
    input: unknown,
    traceContext?: TraceContext,
    authorizationMode?: ActivitySinkEvent['authorizationMode'],
  ): Promise<string> {
    const callId = randomUUID();
    const timestamp = new Date().toISOString();
    const workspaceId = readWorkspaceId(input);
    const targetSummary = summarizeToolTarget(toolName, input);
    const trace = traceContext ?? readTraceContext(input);
    const entry: InFlightToolCall = {
      callId,
      toolName,
      startedAt: timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
      ...(authorizationMode === undefined ? {} : { authorizationMode }),
    };
    this.inflight.set(callId, entry);
    this.activityRevision += 1;
    await this.safeRecord({
      callId,
      toolName,
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
      ...(authorizationMode === undefined ? {} : { authorizationMode }),
    });
    return callId;
  }

  public updateTarget(callId: string, targetSummary: string | undefined): void {
    if (targetSummary === undefined || targetSummary.trim().length === 0) return;
    const existing = this.inflight.get(callId);
    if (existing === undefined || existing.targetSummary === targetSummary) return;
    this.inflight.set(callId, { ...existing, targetSummary });
    this.activityRevision += 1;
  }

  public updateAuthorizationMode(callId: string, authorizationMode: 'standard' | 'full_bypass'): void {
    const existing = this.inflight.get(callId);
    if (existing === undefined || existing.authorizationMode === authorizationMode) return;
    this.inflight.set(callId, { ...existing, authorizationMode });
    this.activityRevision += 1;
  }

  public async end(callId: string, resultCode: string, durationMs: number, resultMessage?: string): Promise<void> {
    const existing = this.inflight.get(callId);
    this.inflight.delete(callId);
    this.activityRevision += 1;
    const timestamp = new Date().toISOString();
    await this.safeRecord({
      callId,
      toolName: existing?.toolName ?? 'unknown',
      phase: 'completed',
      resultCode,
      durationMs,
      timestamp,
      ...(existing?.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
      ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
      ...(existing?.targetSummary === undefined ? {} : { targetSummary: existing.targetSummary }),
      ...(existing?.traceId === undefined ? {} : { traceId: existing.traceId }),
      ...(existing?.traceParent === undefined ? {} : { traceParent: existing.traceParent }),
      ...(existing?.authorizationMode === undefined ? {} : { authorizationMode: existing.authorizationMode }),
      ...(resultMessage === undefined || resultMessage.length === 0 ? {} : { resultMessage }),
    });
  }

  private async safeRecord(event: ActivitySinkEvent): Promise<void> {
    if (this.sink === undefined) return;
    try {
      await this.sink.record(event);
    } catch (error: unknown) {
      // Activity recording must never fail tool execution, but failures must remain observable.
      try {
        this.onRecordError?.(error, event);
      } catch {
        // Diagnostics must not fail tool execution either.
      }
    }
  }
}

export function summarizeToolTarget(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return humanizeToolName(toolName);

  const goalTarget = goalActivitySummary(toolName, input);
  if (goalTarget !== undefined) return goalTarget;

  const command = commandSummary(toolName, input);
  if (command !== undefined) return command;

  const sourcePath = firstString(input, ['sourcePath']);
  const destinationPath = firstString(input, ['destinationPath']);
  if (sourcePath !== undefined && destinationPath !== undefined) return summarizeForLog(`${sourcePath} → ${destinationPath}`);

  const pathCollection = pathCollectionSummary(input);
  if (pathCollection !== undefined) return pathCollection;

  const url = firstString(input, ['url']);
  if (url !== undefined) {
    const method = firstString(input, ['method']);
    return summarizeForLog(method === undefined ? url : `${method} ${url}`);
  }

  const server = firstString(input, ['server']);
  const childTool = firstString(input, ['tool']);
  if (server !== undefined && childTool !== undefined) return summarizeForLog(`${server}/${childTool}`);

  const pathValue = firstString(input, ['path', 'relativePath', 'filePath', 'targetPath', 'output_path', 'file_path', 'target_path']);
  if (pathValue !== undefined) return summarizeForLog(pathValue);

  const query = firstString(input, ['query', 'pattern', 'instruction']);
  if (query !== undefined) return summarizeForLog(query);

  const operation = firstString(input, ['operation', 'action', 'mode', 'capture']);
  if (operation !== undefined) {
    const context = operationContextSummary(input);
    return summarizeForLog(context.length === 0 ? `${toolName}:${operation}` : `${toolName}:${operation} ${context}`);
  }

  const identifier = identifierSummary(input);
  if (identifier !== undefined) return summarizeForLog(identifier);

  const batch = batchSummary(input);
  if (batch !== undefined) return batch;

  const skillId = firstString(input, ['skillId', 'serverId', 'name']);
  if (skillId !== undefined) return summarizeForLog(skillId);

  const generic = genericPrimitiveSummary(input);
  return defaultToolSummary(toolName) ?? generic ?? humanizeToolName(toolName);
}

export function summarizeStructuredResultTarget(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const command = commandSummary('result', value);
  if (command !== undefined) return command;
  const nestedCommand = isRecord(value.command) ? commandSummary('result', value.command) : undefined;
  return nestedCommand;
}

export function readTraceContext(input: unknown): TraceContext {
  if (!isRecord(input)) return {};
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const traceId = boundedTraceValue(input.trace_id ?? input.traceId ?? metadata?.trace_id ?? metadata?.traceId);
  const traceParent = boundedTraceValue(input.traceparent ?? input.traceParent ?? metadata?.traceparent ?? metadata?.traceParent);
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(traceParent === undefined ? {} : { traceParent }),
  };
}

function readWorkspaceId(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) return undefined;
  return input.workspaceId;
}

function firstString(input: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function commandSummary(toolName: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const approved = isRecord(input.__lnwjudApprovedProjectCommand) ? input.__lnwjudApprovedProjectCommand : undefined;
  const executable = approved === undefined ? firstString(input, ['executable', 'command']) : firstString(approved, ['executable', 'command']);
  const args = approved === undefined
    ? readStringArray(input.arguments) ?? readStringArray(input.args)
    : readStringArray(approved.args) ?? readStringArray(approved.arguments);
  if (executable !== undefined) return summarizeForLog(args === undefined || args.length === 0 ? executable : `${executable} ${args.join(' ')}`);
  const bareArgs = readStringArray(input.arguments) ?? readStringArray(input.args);
  if (bareArgs !== undefined && bareArgs.length > 0) {
    const prefix = toolName === 'git' ? 'git' : humanizeToolName(toolName);
    return summarizeForLog(`${prefix} ${bareArgs.join(' ')}`);
  }
  return undefined;
}

function pathCollectionSummary(input: Readonly<Record<string, unknown>>): string | undefined {
  if (!Array.isArray(input.files)) return undefined;
  const paths = input.files
    .map((entry) => isRecord(entry) ? firstString(entry, ['path', 'filePath']) : undefined)
    .filter((value): value is string => value !== undefined);
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, 3);
  return summarizeForLog(paths.length <= shown.length ? shown.join(', ') : `${shown.join(', ')} (+${paths.length - shown.length})`);
}

function batchSummary(input: Readonly<Record<string, unknown>>): string | undefined {
  const calls: string[] = [];
  if (Array.isArray(input.calls)) {
    for (const entry of input.calls) {
      if (!isRecord(entry)) continue;
      const tool = firstString(entry, ['tool']);
      if (tool !== undefined) calls.push(tool);
    }
  }
  if (Array.isArray(input.groups)) {
    for (const group of input.groups) {
      if (!isRecord(group) || !Array.isArray(group.calls)) continue;
      for (const entry of group.calls) {
        if (!isRecord(entry)) continue;
        const tool = firstString(entry, ['tool']);
        if (tool !== undefined) calls.push(tool);
      }
    }
  }
  if (calls.length === 0) return undefined;
  const shown = calls.slice(0, 4);
  return summarizeForLog(calls.length <= shown.length ? shown.join(' + ') : `${shown.join(' + ')} (+${calls.length - shown.length})`);
}

function identifierSummary(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, label] of [
    ['processId', 'process'],
    ['task_id', 'task'],
    ['taskId', 'task'],
    ['codexTaskId', 'codex-task'],
    ['checkpointId', 'checkpoint'],
    ['goalId', 'goal'],
    ['recoveryId', 'recovery'],
    ['continuationToken', 'continuation'],
    ['observationId', 'observation'],
    ['markId', 'mark'],
  ] as const) {
    const value = firstString(input, [key]);
    if (value !== undefined) return `${label}=${shortOpaqueId(value)}`;
  }
  return undefined;
}

function operationContextSummary(input: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  const identifier = identifierSummary(input);
  if (identifier !== undefined) parts.push(identifier);
  for (const [key, label] of [
    ['tool', 'tool'],
    ['title', 'title'],
    ['task_name', 'task'],
    ['file_name', 'file'],
    ['folder', 'folder'],
    ['sheet', 'sheet'],
    ['range', 'range'],
    ['tab_id', 'tab'],
    ['display_id', 'display'],
    ['distro', 'distro'],
  ] as const) {
    const value = firstString(input, [key]);
    if (value !== undefined) parts.push(`${label}=${summarizeForLog(value)}`);
    if (parts.length >= 4) break;
  }
  const parameterSummary = safeParameterSummary(input.parameters);
  if (parameterSummary !== undefined && parts.length < 4) parts.push(parameterSummary);
  return parts.join(' ');
}

function safeParameterSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parts: string[] = [];
  for (const key of ['app', 'name', 'title', 'selector', 'role', 'label', 'key', 'button', 'x', 'y', 'width', 'height', 'sheet', 'range', 'folder']) {
    const current = value[key];
    if (typeof current === 'string' && current.trim().length > 0 && !isSensitiveKey(key)) parts.push(`${key}=${summarizeForLog(current)}`);
    else if (typeof current === 'number' || typeof current === 'boolean') parts.push(`${key}=${String(current)}`);
    if (parts.length >= 3) break;
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

function genericPrimitiveSummary(input: Readonly<Record<string, unknown>>): string | undefined {
  const ignored = new Set(['workspaceId', 'userConfirmed', 'dry_run', 'approval', 'request_id', 'metadata', 'timeout_seconds', 'timeoutSeconds', 'timeoutMs', 'content', 'oldText', 'newText', 'text', 'body', 'headers', 'values', 'image_base64', 'environment']);
  const parts: string[] = [];
  for (const key of Object.keys(input).sort()) {
    if (ignored.has(key) || isSensitiveKey(key)) continue;
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) parts.push(`${key}=${summarizeForLog(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${String(value)}`);
    if (parts.length >= 4) break;
  }
  return parts.length === 0 ? undefined : summarizeForLog(parts.join(' '));
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return strings.length === 0 ? undefined : strings;
}

function shortOpaqueId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function goalActivitySummary(toolName: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (!['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'list_goals'].includes(toolName)) return undefined;
  const goalId = firstString(input, ['goalId']);
  if (goalId !== undefined) return `goal=${shortOpaqueId(goalId)}`;
  const goalKey = firstString(input, ['goalKey']);
  const workspaceId = firstString(input, ['workspaceId']);
  if (goalKey !== undefined && workspaceId !== undefined) return summarizeForLog(`goalKey=${goalKey} workspace=${shortOpaqueId(workspaceId)}`);
  if (workspaceId !== undefined) return `workspace=${shortOpaqueId(workspaceId)}`;
  return toolName === 'list_goals' ? 'list durable goals' : humanizeToolName(toolName);
}

function defaultToolSummary(toolName: string): string | undefined {
  switch (toolName) {
    case 'git_status': return 'git status';
    case 'git_log': return 'git log';
    case 'git_diff': return 'git diff';
    case 'workspace_list': return 'list registered workspaces';
    case 'workspace_info': return 'workspace info';
    case 'workspace_snapshot': return 'workspace snapshot';
    case 'process_list': return 'list managed processes';
    case 'codex_status': return 'codex status';
    case 'codex_task_list': return 'list codex tasks';
    case 'mcp_list': return 'list child MCP servers';
    case 'verify_incremental': return 'project typecheck (incremental verification)';
    case 'list_goals': return 'list durable goals';
    default: return undefined;
  }
}

const MAX_LOG_TARGET_CHARS = 4_096;

function summarizeForLog(value: string): string {
  return truncate(redactSensitiveLogText(value), MAX_LOG_TARGET_CHARS);
}

function redactSensitiveLogText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundedTraceValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return truncate(value.trim(), 256);
}

function humanizeToolName(toolName: string): string {
  return toolName.replace(/_/g, ' ');
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|private[_-]?key|authorization|credential)/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
