import { randomUUID } from 'node:crypto';
import {
  activityTargetReference,
  redactActivityTargetDetail,
  Redactor,
  type ActivityTargetDetail,
  type ActivityTargetReference,
} from '@lnwjud/audit';

export interface ActivitySinkEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly phase: 'started' | 'completed';
  readonly resultCode: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly targetDetail?: ActivityTargetReference;
  readonly resultMessage?: string;
  readonly timestamp: string;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly traceState?: string;
  readonly baggage?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}

export interface TraceContext {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly traceState?: string;
  readonly baggage?: string;
}

export interface ToolTelemetrySnapshot {
  readonly calls: number;
  readonly successes: number;
  readonly errors: number;
  readonly cancellations: number;
  readonly active: number;
  readonly averageLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly maxLatencyMs: number;
}

export interface ActivityTelemetrySnapshot {
  readonly calls: number;
  readonly completed: number;
  readonly successes: number;
  readonly errors: number;
  readonly cancellations: number;
  readonly active: number;
  readonly averageLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly maxLatencyMs: number;
  readonly byTool: Readonly<Record<string, ToolTelemetrySnapshot>>;
  readonly batchPartialFailures: number;
  readonly taskLifecycleCalls: number;
  readonly recentErrorClasses: readonly { readonly code: string; readonly count: number }[];
}

export interface ActivitySink {
  record(event: ActivitySinkEvent): Promise<void>;
}

export interface ActivityAuditSink {
  record(event: ActivitySinkEvent, detail?: ActivityTargetDetail): Promise<void>;
}

export type ActivityRecordErrorHandler = (error: unknown, event: ActivitySinkEvent) => void;

export interface InFlightToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly targetDetail: ActivityTargetReference;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly traceState?: string;
  readonly baggage?: string;
  readonly authorizationMode?: 'standard' | 'full_bypass';
}

export class ActivityTracker {
  private readonly inflight = new Map<string, InFlightToolCall>();
  private readonly completedTelemetry: Array<{ readonly toolName: string; readonly resultCode: string; readonly durationMs: number; readonly partialFailure: boolean }> = [];
  private activityRevision = 0;
  private readonly maxTelemetryEntries = 4096;

  public constructor(
    private readonly sink?: ActivitySink,
    private readonly onRecordError?: ActivityRecordErrorHandler,
    private readonly auditSink?: ActivityAuditSink,
  ) {}

  public listInFlight(): readonly InFlightToolCall[] {
    return [...this.inflight.values()];
  }

  public revision(): number {
    return this.activityRevision;
  }

  public telemetrySnapshot(): ActivityTelemetrySnapshot {
    const activeByTool = new Map<string, number>();
    for (const entry of this.inflight.values()) activeByTool.set(entry.toolName, (activeByTool.get(entry.toolName) ?? 0) + 1);
    const completedByTool = new Map<string, Array<{ readonly resultCode: string; readonly durationMs: number }>>();
    const errorCounts = new Map<string, number>();
    for (const entry of this.completedTelemetry) {
      const bucket = completedByTool.get(entry.toolName) ?? [];
      bucket.push({ resultCode: entry.resultCode, durationMs: entry.durationMs });
      completedByTool.set(entry.toolName, bucket);
      if (telemetryOutcome(entry.resultCode) === 'error') errorCounts.set(entry.resultCode, (errorCounts.get(entry.resultCode) ?? 0) + 1);
    }
    const toolNames = [...new Set([...completedByTool.keys(), ...activeByTool.keys()])].sort();
    const byTool: Record<string, ToolTelemetrySnapshot> = {};
    for (const toolName of toolNames) {
      const completed = completedByTool.get(toolName) ?? [];
      const durations = completed.map((entry) => entry.durationMs);
      const successes = completed.filter((entry) => telemetryOutcome(entry.resultCode) === 'success').length;
      const errors = completed.filter((entry) => telemetryOutcome(entry.resultCode) === 'error').length;
      const cancellations = completed.filter((entry) => telemetryOutcome(entry.resultCode) === 'cancelled').length;
      byTool[toolName] = {
        calls: completed.length + (activeByTool.get(toolName) ?? 0),
        successes,
        errors,
        cancellations,
        active: activeByTool.get(toolName) ?? 0,
        averageLatencyMs: average(durations),
        p50LatencyMs: percentile(durations, 0.5),
        p95LatencyMs: percentile(durations, 0.95),
        maxLatencyMs: durations.length === 0 ? 0 : Math.max(...durations),
      };
    }
    const durations = this.completedTelemetry.map((entry) => entry.durationMs);
    const successes = this.completedTelemetry.filter((entry) => telemetryOutcome(entry.resultCode) === 'success').length;
    const errors = this.completedTelemetry.filter((entry) => telemetryOutcome(entry.resultCode) === 'error').length;
    const cancellations = this.completedTelemetry.filter((entry) => telemetryOutcome(entry.resultCode) === 'cancelled').length;
    return {
      calls: this.completedTelemetry.length + this.inflight.size,
      completed: this.completedTelemetry.length,
      successes,
      errors,
      cancellations,
      active: this.inflight.size,
      averageLatencyMs: average(durations),
      p50LatencyMs: percentile(durations, 0.5),
      p95LatencyMs: percentile(durations, 0.95),
      maxLatencyMs: durations.length === 0 ? 0 : Math.max(...durations),
      byTool,
      batchPartialFailures: this.completedTelemetry.filter((entry) => entry.toolName === 'tool_batch' && entry.partialFailure).length,
      taskLifecycleCalls: this.completedTelemetry.filter((entry) => /^(task_|delegate_|agent_swarm_)/.test(entry.toolName)).length,
      recentErrorClasses: [...errorCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 16).map(([code, count]) => ({ code, count })),
    };
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
    const describedTarget = describeToolTarget(toolName, input);
    const targetSummary = describedTarget.summary;
    const targetDetail = activityTargetReference(callId, describedTarget.detail, targetSummary);
    const trace = traceContext ?? readTraceContext(input);
    const entry: InFlightToolCall = {
      callId,
      toolName,
      startedAt: timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      targetDetail,
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
      ...(trace.traceState === undefined ? {} : { traceState: trace.traceState }),
      ...(trace.baggage === undefined ? {} : { baggage: trace.baggage }),
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
      targetDetail,
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
      ...(trace.traceState === undefined ? {} : { traceState: trace.traceState }),
      ...(trace.baggage === undefined ? {} : { baggage: trace.baggage }),
      ...(authorizationMode === undefined ? {} : { authorizationMode }),
    }, describedTarget.detail);
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

  public async end(
    callId: string,
    resultCode: string,
    durationMs: number,
    resultMessage?: string,
    resultDetail?: ActivityTargetDetail,
  ): Promise<void> {
    const existing = this.inflight.get(callId);
    this.inflight.delete(callId);
    this.activityRevision += 1;
    this.completedTelemetry.push({
      toolName: existing?.toolName ?? 'unknown',
      resultCode,
      durationMs: Math.max(0, Number.isFinite(durationMs) ? durationMs : 0),
      partialFailure: existing?.toolName === 'tool_batch' && hasPartialFailure(resultDetail),
    });
    if (this.completedTelemetry.length > this.maxTelemetryEntries) this.completedTelemetry.splice(0, this.completedTelemetry.length - this.maxTelemetryEntries);
    const timestamp = new Date().toISOString();
    const targetDetail = resultDetail === undefined
      ? existing?.targetDetail ?? activityTargetReference(null, undefined, undefined)
      : activityTargetReference(`${callId}:completed`, resultDetail, existing?.targetSummary);
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
      targetDetail,
      ...(existing?.traceId === undefined ? {} : { traceId: existing.traceId }),
      ...(existing?.traceParent === undefined ? {} : { traceParent: existing.traceParent }),
      ...(existing?.traceState === undefined ? {} : { traceState: existing.traceState }),
      ...(existing?.baggage === undefined ? {} : { baggage: existing.baggage }),
      ...(existing?.authorizationMode === undefined ? {} : { authorizationMode: existing.authorizationMode }),
      ...(resultMessage === undefined || resultMessage.length === 0 ? {} : { resultMessage }),
    }, resultDetail);
  }

  private async safeRecord(event: ActivitySinkEvent, detail?: ActivityTargetDetail): Promise<void> {
    const compactRecord = this.sink === undefined ? undefined : (): Promise<void> => this.sink!.record(event);
    const auditRecord = this.auditSink === undefined ? undefined : (): Promise<void> => this.auditSink!.record(event, detail);
    // Publish starts promptly, but do not publish completion/idle until durable audit evidence exists.
    const records = event.phase === 'started' ? [compactRecord, auditRecord] : [auditRecord, compactRecord];
    for (const record of records) {
      if (record === undefined) continue;
      try {
        await record();
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
}

export interface DescribedToolTarget {
  readonly summary?: string;
  readonly detail?: ActivityTargetDetail;
}

export function describeToolTarget(toolName: string, input: unknown): DescribedToolTarget {
  const collectionDetail = isRecord(input) ? collectionTargetDetail(input) : undefined;
  const collectionSummary = collectionDetail === undefined
    ? undefined
    : summarizeForLog(collectionDetail.items.slice(0, 3).join(collectionDetail.kind === 'files' ? ', ' : ' + '));
  const summary = collectionSummary ?? summarizeToolTargetWithoutDetail(toolName, input);
  // File collections already have a lossless dedicated representation. For tool
  // batches, retain the complete sanitized input shape instead of only child tool
  // names so expansion/copy/export includes every child query and argument.
  const detail = collectionDetail?.kind === 'files' ? collectionDetail : diagnosticActivityDetail(input);
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function summarizeToolTarget(toolName: string, input: unknown): string | undefined {
  return describeToolTarget(toolName, input).summary;
}

function summarizeToolTargetWithoutDetail(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return humanizeToolName(toolName);

  const goalTarget = goalActivitySummary(toolName, input);
  if (goalTarget !== undefined) return goalTarget;

  const command = commandSummary(toolName, input);
  if (command !== undefined) return command;

  const sourcePath = firstString(input, ['sourcePath']);
  const destinationPath = firstString(input, ['destinationPath']);
  if (sourcePath !== undefined && destinationPath !== undefined) return summarizeForLog(`${sourcePath} → ${destinationPath}`);

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

  const skillId = firstString(input, ['skillId', 'serverId', 'name']);
  if (skillId !== undefined) return summarizeForLog(skillId);

  const generic = genericPrimitiveSummary(input);
  return defaultToolSummary(toolName) ?? generic ?? humanizeToolName(toolName);
}

function collectionTargetDetail(input: Readonly<Record<string, unknown>>): ActivityTargetDetail | undefined {
  if (Array.isArray(input.files)) {
    const items = input.files
      .map((entry) => typeof entry === 'string' ? entry : isRecord(entry) ? firstString(entry, ['path', 'filePath']) : undefined)
      .filter((value): value is string => value !== undefined);
    if (items.length > 0) return redactActivityTargetDetail({ kind: 'files', items }, new Redactor());
  }
  const items: string[] = [];
  if (Array.isArray(input.calls)) {
    for (const entry of input.calls) {
      if (!isRecord(entry)) continue;
      const tool = firstString(entry, ['tool']);
      if (tool !== undefined) items.push(tool);
    }
  }
  if (Array.isArray(input.groups)) {
    for (const group of input.groups) {
      if (!isRecord(group) || !Array.isArray(group.calls)) continue;
      for (const entry of group.calls) {
        if (!isRecord(entry)) continue;
        const tool = firstString(entry, ['tool']);
        if (tool !== undefined) items.push(tool);
      }
    }
  }
  return items.length === 0 ? undefined : redactActivityTargetDetail({ kind: 'tools', items }, new Redactor());
}

export function describeStructuredResultDetail(value: unknown): ActivityTargetDetail | undefined {
  return diagnosticActivityDetail(value);
}

function diagnosticActivityDetail(value: unknown): ActivityTargetDetail | undefined {
  if (value === undefined) return undefined;
  const sanitized = new Redactor().redact(value);
  const items: string[] = [];
  appendDiagnosticValue(sanitized, '', items, 0);
  return items.length === 0
    ? undefined
    : redactActivityTargetDetail({ kind: 'details', items }, new Redactor());
}

function appendDiagnosticValue(value: unknown, path: string, items: string[], depth: number): void {
  if (items.length >= 2_000) return;
  if (depth > 16) {
    items.push(`${path || 'value'}=[maximum diagnostic depth reached]`);
    return;
  }
  if (value === null) {
    items.push(`${path || 'value'}=null`);
    return;
  }
  if (typeof value === 'string') {
    items.push(`${path || 'value'}=${value}`);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    items.push(`${path || 'value'}=${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      items.push(`${path || 'value'}=[]`);
      return;
    }
    value.forEach((entry, index) => appendDiagnosticValue(entry, `${path}[${index}]`, items, depth + 1));
    return;
  }
  if (!isRecord(value)) {
    items.push(`${path || 'value'}=${String(value)}`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    items.push(`${path || 'value'}={}`);
    return;
  }
  for (const [key, entry] of entries) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (isOpaqueDiagnosticPayloadKey(key)) {
      items.push(`${childPath}=${diagnosticPayloadDescriptor(entry)}`);
      continue;
    }
    appendDiagnosticValue(entry, childPath, items, depth + 1);
    if (items.length >= 2_000) break;
  }
}

function isOpaqueDiagnosticPayloadKey(key: string): boolean {
  // Binary/base64 payloads are not human-readable diagnostic text. Ordinary text,
  // request bodies, edit content, values and environment entries are retained after
  // secret redaction so Copy/Export can reproduce what the tool actually received.
  return /^(image_base64|audio_base64|file_base64|binary_base64)$/i.test(key);
}

function diagnosticPayloadDescriptor(value: unknown): string {
  if (typeof value === 'string') return `[binary payload omitted from activity log; ${value.length} chars]`;
  if (Array.isArray(value)) return `[binary payload omitted from activity log; ${value.length} items]`;
  if (isRecord(value)) return `[binary payload omitted from activity log; ${Object.keys(value).length} fields]`;
  return '[binary payload omitted from activity log]';
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
  const traceState = boundedTraceValue(input.tracestate ?? input.traceState ?? metadata?.tracestate ?? metadata?.traceState);
  const baggage = boundedBaggage(input.baggage ?? metadata?.baggage);
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(traceParent === undefined ? {} : { traceParent }),
    ...(traceState === undefined ? {} : { traceState }),
    ...(baggage === undefined ? {} : { baggage }),
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
    if (value !== undefined) return `${label}=${value}`;
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

function goalActivitySummary(toolName: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (!['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'list_goals'].includes(toolName)) return undefined;
  const goalId = firstString(input, ['goalId']);
  if (goalId !== undefined) return `goal=${goalId}`;
  const goalKey = firstString(input, ['goalKey']);
  const workspaceId = firstString(input, ['workspaceId']);
  if (goalKey !== undefined && workspaceId !== undefined) return summarizeForLog(`goalKey=${goalKey} workspace=${workspaceId}`);
  if (workspaceId !== undefined) return `workspace=${workspaceId}`;
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

function summarizeForLog(value: string): string {
  // Activity summaries are diagnostic evidence. Redact secrets, but never shorten
  // ordinary identifiers/arguments here; the renderer can wrap long values.
  return redactSensitiveLogText(value);
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

function boundedBaggage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const redacted = value
    .split(',')
    .slice(0, 32)
    .map((member) => {
      const [rawKey, ...rest] = member.trim().split('=');
      if (rawKey === undefined || rest.length === 0) return undefined;
      const key = rawKey.trim();
      if (key.length === 0) return undefined;
      if (isSensitiveKey(key)) return `${key}=[redacted]`;
      return `${key}=${redactSensitiveLogText(rest.join('=').trim())}`;
    })
    .filter((member): member is string => member !== undefined)
    .join(',');
  return redacted.length === 0 ? undefined : truncate(redacted, 1024);
}

function hasPartialFailure(detail: ActivityTargetDetail | undefined): boolean {
  if (detail === undefined) return false;
  const serialized = JSON.stringify(detail);
  return /(?:isError|failed|error|ok)[^\n]{0,64}(?:true|false|ERROR|failed)/i.test(serialized)
    && /(?:isError\W*true|ok\W*false|failed|error)/i.test(serialized);
}

function telemetryOutcome(resultCode: string): 'success' | 'error' | 'cancelled' {
  const normalized = resultCode.toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'OK' || normalized === 'COMPLETED') return 'success';
  if (/CANCEL|ABORT|TIMEOUT|TERMINAT/.test(normalized)) return 'cancelled';
  return 'error';
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
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
