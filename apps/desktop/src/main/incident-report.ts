import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LogLine, TunnelLifecycleCategory, TunnelStatus } from '@lnwjud/ipc-contracts';

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 200;
const MAX_TEXT = 512;
const MAX_IDS = 50;
const SENSITIVE_KEY = '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|x[_-]?api[_-]?key|api[_-]?key|client[_-]?secret|authorization|password|token|secret)';
const AUTHORIZATION_VALUE = /\bauthorization\s*[:=]\s*[a-z][a-z0-9._~-]*\s+[^\r\n,;]+/gi;
const JSON_SECRET_VALUE = new RegExp(`("${SENSITIVE_KEY}"\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|[^,}\\]\\r\\n]*)`, 'gi');
const ASSIGNED_SECRET_VALUE = new RegExp(`(^|[?&\\s;,{])(${SENSITIVE_KEY})(\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\r\\n,;&}\\]]+)`, 'gi');
const PREFIXED_ENV_SECRET_VALUE = /(^|[?&\s;,{])([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:access_token|refresh_token|id_token|auth_token|x_api_key|api_key|client_secret|password|token|secret))(\s*=\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,;&}\]]+)/gi;
const CLI_SECRET_VALUE = /(^|\s)(--(?:api-key|token|access-token|refresh-token|id-token|auth-token|client-secret))(?:\s*=\s*|\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi;
const KNOWN_SECRET_PREFIX = /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g;

export type IncidentClassification = 'local_tool_failed' | 'tunnel_disconnected' | 'remote_turn_stopped' | 'healthy_or_inconclusive';
export type TunnelHealthState = 'live' | 'unhealthy' | 'unavailable' | 'unknown';
export interface IncidentHealth { readonly state: TunnelHealthState; readonly message: string | null; }
type IncidentLine = Pick<LogLine, 'source' | 'text' | 'timestamp' | 'correlation'> & { readonly id?: number };
export interface IncidentEvidence { readonly triggeredByUser: boolean; readonly appVersion: string; readonly tunnelClientVersion: string | null; readonly tunnelClientVersionReason?: string | null; readonly tunnel: Pick<TunnelStatus, 'state' | 'source'> & { readonly message?: string | null; readonly health: IncidentHealth }; readonly updaterEvents: readonly string[]; readonly logLines: readonly IncidentLine[]; readonly relevantPids?: readonly number[]; readonly relevantPidUnavailableReason?: string; readonly collectProcessTree?: (pids: readonly number[]) => Promise<readonly IncidentProcess[]>; readonly collectListeners?: (pids: readonly number[]) => Promise<readonly IncidentListener[]>; }
export interface IncidentProcess { readonly pid: number; readonly parentPid: number | null; readonly executable: string; }
export interface IncidentListener { readonly pid: number; readonly address: string; readonly port: number; readonly owner?: string; }
export type IncidentCompletionState = 'success' | 'failure' | 'unknown' | 'conflict';
export interface IncidentCall { readonly callId: string; readonly toolName: string | null; readonly resultCode: 'SUCCESS' | 'FAILED' | 'FATAL' | 'UNKNOWN' | null; readonly completionState: IncidentCompletionState; readonly incomplete: boolean; readonly startedWithoutCompletion: boolean; readonly completionWithoutStart: boolean; readonly sourceSequence: number; readonly lastEvidenceSequence: number; readonly startedAt: string | null; readonly completedAt: string | null; }
export interface IncidentReport { readonly schemaVersion: 1; readonly capturedAt: string; readonly appVersion: string; readonly tunnelClientVersion: string | null; readonly tunnelClientVersionReason: string | null; readonly classification: IncidentClassification; readonly classificationReasons: readonly string[]; readonly updaterEventTail: readonly { readonly category: 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded' | 'error'; readonly version?: string }[]; readonly tunnel: { readonly state: TunnelStatus['state']; readonly source: TunnelStatus['source']; readonly instanceIds: readonly string[]; readonly requestIds: readonly string[]; readonly health: IncidentHealth; }; readonly mcpCalls: readonly IncidentCall[]; readonly tunnelLogTail: readonly { readonly timestamp: string; readonly lifecycle: TunnelLifecycleCategory; readonly instanceId?: string; readonly requestId?: string }[]; readonly processTree: { readonly available: boolean; readonly entries: readonly { readonly pid: number; readonly parentPid: number | null; readonly executable: string }[]; readonly error?: string; }; readonly tcpListeners: { readonly available: boolean; readonly entries: readonly { readonly pid: number; readonly address: string; readonly port: number }[]; readonly error?: string; }; }

export function classifyIncident(evidence: Pick<IncidentEvidence, 'triggeredByUser' | 'tunnel' | 'logLines'>): { readonly classification: IncidentClassification; readonly reasons: readonly string[] } {
  const latestCall = pairMcpCalls(evidence.logLines).reduce<IncidentCall | undefined>((latest, call) => latest === undefined || call.lastEvidenceSequence >= latest.lastEvidenceSequence ? call : latest, undefined);
  if (latestCall?.completionState === 'failure' && !latestCall.incomplete) return { classification: 'local_tool_failed', reasons: ['latest_structured_mcp_terminal_failed'] };
  let latestFailure = -1;
  let latestRecovery = -1;
  for (const [index, line] of evidence.logLines.entries()) {
    if (line.source !== 'tunnel' || line.correlation?.kind !== 'tunnel') continue;
    const sequence = sourceSequence(line, index);
    if (line.correlation.lifecycle === 'transport_live') latestRecovery = Math.max(latestRecovery, sequence);
    else if (line.correlation.lifecycle !== undefined && line.correlation.lifecycle !== 'other') latestFailure = Math.max(latestFailure, sequence);
  }
  const currentlyFailed = evidence.tunnel.state === 'stopped' || evidence.tunnel.state === 'error' || evidence.tunnel.health.state === 'unhealthy';
  const explicitlyRecovered = latestFailure >= 0
    && latestRecovery > latestFailure
    && latestCall?.completionState === 'success'
    && !latestCall.incomplete
    && latestCall.lastEvidenceSequence > latestFailure
    && evidence.tunnel.state === 'running'
    && evidence.tunnel.health.state === 'live';
  if (currentlyFailed || (latestFailure >= 0 && !explicitlyRecovered)) return { classification: 'tunnel_disconnected', reasons: ['explicit_tunnel_disconnect_evidence'] };
  if (evidence.triggeredByUser && latestCall?.completionState === 'success' && !latestCall.incomplete && evidence.tunnel.state === 'running' && evidence.tunnel.health.state === 'live') return { classification: 'remote_turn_stopped', reasons: ['manual_capture_after_structured_success_with_live_tunnel'] };
  return { classification: 'healthy_or_inconclusive', reasons: [evidence.tunnel.state === 'starting' ? 'tunnel_starting' : evidence.tunnel.health.state === 'unavailable' ? 'tunnel_health_unavailable' : 'insufficient_non_conflicting_evidence'] };
}

export function pairMcpCalls(lines: readonly IncidentLine[]): readonly IncidentCall[] {
  const calls: MutableIncidentCall[] = [];
  const pending = new Map<string, number[]>();
  const lastClosed = new Map<string, number>();
  const seenEvents = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const correlation = line.correlation;
    if (correlation?.kind !== 'mcp') continue;
    const identity = mcpEvidenceIdentity(line, correlation);
    if (seenEvents.has(identity)) continue;
    seenEvents.add(identity);
    const rawCallId = correlation.callId;
    const callId = safe(rawCallId);
    const sequence = sourceSequence(line, index);
    const eventTimestamp = safe(line.timestamp);
    if (correlation.phase === 'started') {
      const callIndex = calls.push({
        callId,
        toolName: safe(correlation.toolName),
        resultCode: null,
        completionState: 'unknown',
        incomplete: true,
        startedWithoutCompletion: true,
        completionWithoutStart: false,
        sourceSequence: sequence,
        lastEvidenceSequence: sequence,
        startedAt: eventTimestamp,
        completedAt: null,
      }) - 1;
      const queue = pending.get(rawCallId) ?? [];
      queue.push(callIndex);
      pending.set(rawCallId, queue);
      continue;
    }

    const queue = pending.get(rawCallId);
    const callIndex = queue?.shift();
    if (queue !== undefined && queue.length === 0) pending.delete(rawCallId);
    if (callIndex !== undefined) {
      const call = calls[callIndex]!;
      const result = completionResult(correlation.resultCode);
      call.resultCode = result.resultCode;
      call.completionState = result.completionState;
      call.incomplete = result.completionState === 'unknown';
      call.startedWithoutCompletion = false;
      call.lastEvidenceSequence = sequence;
      call.completedAt = eventTimestamp;
      lastClosed.set(rawCallId, callIndex);
      continue;
    }

    const closedIndex = lastClosed.get(rawCallId);
    if (closedIndex !== undefined) {
      const closed = calls[closedIndex]!;
      closed.resultCode = 'UNKNOWN';
      closed.completionState = 'conflict';
      closed.incomplete = true;
      closed.lastEvidenceSequence = sequence;
      continue;
    }

    const result = completionResult(correlation.resultCode);
    calls.push({
      callId,
      toolName: safe(correlation.toolName),
      resultCode: result.resultCode,
      completionState: result.completionState,
      incomplete: true,
      startedWithoutCompletion: false,
      completionWithoutStart: true,
      sourceSequence: sequence,
      lastEvidenceSequence: sequence,
      startedAt: null,
      completedAt: eventTimestamp,
    });
  }
  return calls.slice(-MAX_ENTRIES);
}

interface MutableIncidentCall {
  callId: string;
  toolName: string | null;
  resultCode: IncidentCall['resultCode'];
  completionState: IncidentCompletionState;
  incomplete: boolean;
  startedWithoutCompletion: boolean;
  completionWithoutStart: boolean;
  sourceSequence: number;
  lastEvidenceSequence: number;
  startedAt: string | null;
  completedAt: string | null;
}

export function parseTunnelCorrelations(lines: readonly IncidentLine[]): { readonly instanceIds: readonly string[]; readonly requestIds: readonly string[] } {
  const instanceIds = new Set<string>(); const requestIds = new Set<string>();
  for (const line of lines.slice(-MAX_ENTRIES)) { if (line.source !== 'tunnel') continue; if (line.correlation?.kind === 'tunnel') { if (line.correlation.instanceId !== undefined) instanceIds.add(safe(line.correlation.instanceId)); if (line.correlation.requestId !== undefined) requestIds.add(safe(line.correlation.requestId)); } for (const match of line.text.matchAll(/\b(?:instance[_-]?id|instance)[=:]([A-Za-z0-9._:-]{1,128})/ig)) instanceIds.add(safe(match[1]!)); for (const match of line.text.matchAll(/\b(?:request[_-]?id|request)[=:]([A-Za-z0-9._:-]{1,128})/ig)) requestIds.add(safe(match[1]!)); }
  return { instanceIds: [...instanceIds].slice(-MAX_IDS), requestIds: [...requestIds].slice(-MAX_IDS) };
}

export async function buildIncidentReport(evidence: IncidentEvidence): Promise<IncidentReport> {
  const classification = classifyIncident(evidence);
  const pids = trustedPids(evidence.relevantPids ?? []);
  const unavailableReason = evidence.relevantPidUnavailableReason ?? 'no_trustworthy_tunnel_pid';
  const processTree = await collectProcesses(evidence.collectProcessTree, pids, unavailableReason);
  const listenerPids = trustedPids([...pids, ...processTree.entries.map((entry) => entry.pid)]);
  const tcpListeners = await collectListeners(evidence.collectListeners, listenerPids, unavailableReason);
  const correlations = parseTunnelCorrelations(evidence.logLines);
  const report: IncidentReport = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    appVersion: evidence.appVersion,
    tunnelClientVersion: evidence.tunnelClientVersion,
    tunnelClientVersionReason: evidence.tunnelClientVersionReason ?? null,
    classification: classification.classification,
    classificationReasons: classification.reasons,
    updaterEventTail: normalizeUpdaterEvents(evidence.updaterEvents),
    tunnel: { state: evidence.tunnel.state, source: evidence.tunnel.source, ...correlations, health: { state: evidence.tunnel.health.state, message: evidence.tunnel.health.message } },
    mcpCalls: pairMcpCalls(evidence.logLines),
    tunnelLogTail: evidence.logLines.filter((line) => line.source === 'tunnel').slice(-MAX_ENTRIES).map((line) => {
      const tunnelCorrelation = line.correlation?.kind === 'tunnel' ? line.correlation : undefined;
      return {
        timestamp: line.timestamp,
        lifecycle: tunnelCorrelation?.lifecycle ?? 'other',
        ...(tunnelCorrelation?.instanceId === undefined ? {} : { instanceId: tunnelCorrelation.instanceId }),
        ...(tunnelCorrelation?.requestId === undefined ? {} : { requestId: tunnelCorrelation.requestId }),
      };
    }),
    processTree,
    tcpListeners,
  };
  return sanitizeStrings(report);
}
export interface IncidentExportOptions { readonly choosePath: () => Promise<string | null>; readonly writeAtomically: (filePath: string, content: string) => Promise<void>; }
export async function exportIncidentReport(evidence: IncidentEvidence, options: IncidentExportOptions): Promise<{ readonly exported: boolean; readonly cancelled: boolean; readonly classification: IncidentClassification; readonly capturedAt: string | null }> { const report = await buildIncidentReport(evidence); const filePath = await options.choosePath(); if (filePath === null) return { exported: false, cancelled: true, classification: report.classification, capturedAt: null }; await options.writeAtomically(filePath, JSON.stringify(report, null, 2) + '\n'); return { exported: true, cancelled: false, classification: report.classification, capturedAt: report.capturedAt }; }
export async function atomicWrite(filePath: string, content: string): Promise<void> { const temp = `${filePath}.${randomUUID()}.tmp`; try { await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' }); await rename(temp, filePath); } catch (error) { await unlink(temp).catch(() => undefined); throw error; } }
export async function collectRelevantProcessTree(pids: readonly number[]): Promise<readonly IncidentProcess[]> {
  const roots = trustedPids(pids);
  if (roots.length === 0) return [];
  // Query only non-sensitive identity/parent/name fields. Descendant expansion
  // happens locally and remains anchored to the verified root PIDs.
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid,ppid,comm'], { timeout: 3_000, encoding: 'utf8' });
    return selectRelevantProcesses(parsePosixProcessRows(stdout), roots);
  }
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 3_000, encoding: 'utf8' });
  const rows = parseRows(stdout, null).map((row) => ({ pid: number(row.ProcessId), parentPid: nullableNumber(row.ParentProcessId), executable: safe(typeof row.Name === 'string' ? row.Name : 'unknown') }))
    .filter((entry) => entry.pid > 0);
  return selectRelevantProcesses(rows, roots);
}

/**
 * Parses `ps -Ao pid,ppid,comm` output into the incident process shape.
 * Non-numeric rows (the header, garbled lines) are skipped rather than
 * failing the whole collection.
 */
export function parsePosixProcessRows(raw: string): readonly IncidentProcess[] {
  const rows: IncidentProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({ pid, parentPid: Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : null, executable: safe(match[3]!) });
  }
  return rows;
}
export function selectRelevantProcesses(entries: readonly IncidentProcess[], rootPids: readonly number[]): readonly IncidentProcess[] {
  const included = new Set(trustedPids(rootPids));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (included.has(entry.pid) || entry.parentPid === null || !included.has(entry.parentPid)) continue;
      included.add(entry.pid);
      changed = true;
    }
  }
  return entries.filter((entry) => included.has(entry.pid)).slice(0, MAX_ENTRIES);
}
export async function collectRelevantListeners(pids: readonly number[]): Promise<readonly IncidentListener[]> {
  if (pids.length === 0) return [];
  if (process.platform !== 'win32') {
    let stdout = '';
    try {
      stdout = (await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 3_000, encoding: 'utf8' })).stdout;
    } catch (error: unknown) {
      // lsof exits 1 when nothing matches the selection — that is "no
      // listeners", not a collection failure (mirrors the pgrep rule).
      const exitCode = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
      if (exitCode !== '1') throw error;
    }
    return parsePosixListenerRows(stdout, pids);
  }
  const clause = pids.map((pid) => `$_.OwningProcess -eq ${pid}`).join(' -or ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { ${clause} } | Select-Object OwningProcess,LocalAddress,LocalPort | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 3_000, encoding: 'utf8' });
  return parseRows(stdout).map((row) => ({ pid: number(row.OwningProcess), address: safe(typeof row.LocalAddress === 'string' ? row.LocalAddress : 'unknown'), port: number(row.LocalPort) }));
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN` output into the incident listener
 * shape, keeping only rows owned by one of the trusted pids.
 */
export function parsePosixListenerRows(raw: string, allowedPids: readonly number[]): readonly IncidentListener[] {
  const allowed = new Set(allowedPids);
  const listeners: IncidentListener[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    // Row shape: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (STATE)
    if (tokens.length < 9 || tokens[tokens.length - 1] !== '(LISTEN)') continue;
    const pid = Number(tokens[1]);
    if (!Number.isSafeInteger(pid) || !allowed.has(pid)) continue;
    const name = tokens[tokens.length - 2] ?? '';
    const separator = name.lastIndexOf(':');
    const port = separator <= 0 ? Number.NaN : Number(name.slice(separator + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const address = name.slice(0, separator).replace(/^\[/, '').replace(/\]$/, '');
    listeners.push({ pid, address: safe(address), port });
  }
  return listeners;
}

async function collectProcesses(collector: IncidentEvidence['collectProcessTree'], pids: readonly number[], noPidReason: string): Promise<IncidentReport['processTree']> {
  if (pids.length === 0) return { available: false, entries: [], error: safe(noPidReason) };
  if (collector === undefined) return { available: false, entries: [], error: 'collector_unavailable' };
  try { return { available: true, entries: (await collector(pids)).slice(0, MAX_ENTRIES).map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, executable: safe(entry.executable) })) }; }
  catch (error) { return { available: false, entries: [], error: safe(error instanceof Error ? error.message : String(error)) }; }
}
async function collectListeners(collector: IncidentEvidence['collectListeners'], pids: readonly number[], noPidReason: string): Promise<IncidentReport['tcpListeners']> {
  if (pids.length === 0) return { available: false, entries: [], error: safe(noPidReason) };
  if (collector === undefined) return { available: false, entries: [], error: 'collector_unavailable' };
  try { return { available: true, entries: (await collector(pids)).slice(0, MAX_ENTRIES).map((entry) => ({ pid: entry.pid, address: safe(entry.address), port: entry.port })) }; }
  catch (error) { return { available: false, entries: [], error: safe(error instanceof Error ? error.message : String(error)) }; }
}

function trustedPids(values: readonly number[]): number[] {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647))].slice(0, MAX_IDS);
}

function normalizeUpdaterEvents(events: readonly string[]): IncidentReport['updaterEventTail'] {
  const normalized: Array<IncidentReport['updaterEventTail'][number]> = [];
  for (const event of events.slice(-MAX_ENTRIES)) {
    const match = /^(checking-for-update|update-available|update-not-available|update-downloaded|error)(?::([^\r\n]{1,128}))?$/.exec(event);
    if (match === null) continue;
    const category = match[1] as IncidentReport['updaterEventTail'][number]['category'];
    const detail = match[2];
    if (category !== 'error' && detail !== undefined && /^[0-9A-Za-z._+-]{1,64}$/.test(detail)) normalized.push({ category, version: detail });
    else normalized.push({ category });
  }
  return normalized;
}
function safe(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE, 'authorization=[REDACTED]')
    .replace(CLI_SECRET_VALUE, (_match, prefix: string, flag: string) => `${prefix}${flag} [REDACTED]`)
    .replace(PREFIXED_ENV_SECRET_VALUE, (_match, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}[REDACTED]`)
    .replace(JSON_SECRET_VALUE, '$1"[REDACTED]"')
    .replace(ASSIGNED_SECRET_VALUE, (_match, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}[REDACTED]`)
    .replace(KNOWN_SECRET_PREFIX, '[REDACTED]')
    .slice(0, MAX_TEXT);
}

function sanitizeStrings<T>(value: T): T {
  if (typeof value === 'string') return safe(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeStrings(entry)) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeStrings(entry)])) as T;
}

function completionResult(resultCode: IncidentCall['resultCode']): { readonly resultCode: Exclude<IncidentCall['resultCode'], null>; readonly completionState: Exclude<IncidentCompletionState, 'conflict'> } {
  if (resultCode === 'SUCCESS') return { resultCode, completionState: 'success' };
  if (resultCode === 'FAILED' || resultCode === 'FATAL') return { resultCode, completionState: 'failure' };
  return { resultCode: 'UNKNOWN', completionState: 'unknown' };
}

function sourceSequence(line: IncidentLine, index: number): number {
  return typeof line.id === 'number' && Number.isSafeInteger(line.id) && line.id >= 0 ? line.id : index + 1;
}

function mcpEvidenceIdentity(line: IncidentLine, correlation: Extract<NonNullable<IncidentLine['correlation']>, { readonly kind: 'mcp' }>): string {
  const sourceId = typeof line.id === 'number' && Number.isSafeInteger(line.id) ? `id:${line.id}` : `event:${line.timestamp}:${line.text}`;
  return `${sourceId}:${correlation.phase}:${correlation.callId}:${correlation.toolName}:${String(correlation.resultCode)}`;
}
function parseRows(raw: string, limit: number | null = MAX_ENTRIES): Record<string, unknown>[] { try { const parsed: unknown = JSON.parse(raw || '[]'); const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null); return limit === null ? rows : rows.slice(0, limit); } catch { return []; } }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function nullableNumber(value: unknown): number | null { const parsed = number(value); return parsed > 0 ? parsed : null; }
