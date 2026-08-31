import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LogHub } from '../src/main/log-hub.js';
import {
  buildIncidentReport, selectRelevantProcesses,
  classifyIncident,
  collectRelevantListeners,
  collectRelevantProcessTree,
  exportIncidentReport,
  pairMcpCalls,
  parsePosixListenerRows,
  parsePosixProcessRows,
  parseTunnelCorrelations,
  type IncidentEvidence,
} from '../src/main/incident-report.js';

const healthyTunnel = { state: 'running' as const, source: 'desktop' as const, message: null, health: { state: 'live' as const, message: 'tunnel health endpoint live' } };
const timestamp = (sequence: number): string => new Date(Date.UTC(2026, 7, 20, 0, 0, sequence)).toISOString();
type StartedLine = { readonly id: number; readonly source: 'mcp'; readonly text: string; readonly timestamp: string; readonly correlation: { readonly kind: 'mcp'; readonly phase: 'started'; readonly callId: string; readonly toolName: string; readonly resultCode: null } };
type CompletedLine = { readonly id: number; readonly source: 'mcp'; readonly text: string; readonly timestamp: string; readonly correlation: { readonly kind: 'mcp'; readonly phase: 'completed'; readonly callId: string; readonly toolName: string; resultCode: 'SUCCESS' | 'FAILED' } };
const started = (callId: string, toolName = 'read_file', sequence = 1): StartedLine => ({ id: sequence, source: 'mcp', text: 'display text only', timestamp: timestamp(sequence), correlation: { kind: 'mcp', phase: 'started', callId, toolName, resultCode: null } });
const completed = (callId: string, resultCode: 'SUCCESS' | 'FAILED' = 'SUCCESS', toolName = 'read_file', sequence = 2): CompletedLine => ({ id: sequence, source: 'mcp', text: 'display text only', timestamp: timestamp(sequence), correlation: { kind: 'mcp', phase: 'completed', callId, toolName, resultCode } });

function tunnelLines(...texts: readonly string[]): IncidentEvidence['logLines'] {
  const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
  for (const text of texts) hub.feed('tunnel', 'info', text);
  return hub.snapshot().lines;
}

function evidence(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    triggeredByUser: true,
    appVersion: '4.0.1',
    tunnelClientVersion: '1.2.3',
    tunnel: healthyTunnel,
    updaterEvents: [],
    logLines: [],
    ...overrides,
  };
}

describe('incident classification', () => {
  it.each([
    ['local_tool_failed', evidence({ logLines: [started('a'), completed('a', 'FAILED')] })],
    ['tunnel_disconnected', evidence({ logLines: tunnelLines('stdio command exited') })],
    ['remote_turn_stopped', evidence({ logLines: [started('a'), completed('a')] })],
    ['healthy_or_inconclusive', evidence({ triggeredByUser: false, logLines: [started('a'), completed('a')] })],
  ] as const)('returns %s only from supported evidence', (classification, input) => {
    expect(classifyIncident(input).classification).toBe(classification);
  });

  it('gives local failure precedence over a conflicting tunnel disconnect', () => {
    const result = classifyIncident(evidence({ logLines: [
      ...tunnelLines('connection max TTL reached'),
      started('a', 'write_file'), completed('a', 'FAILED', 'write_file'),
    ] }));
    expect(result).toMatchObject({ classification: 'local_tool_failed' });
  });

  it('does not call idle or periodic status a remote failure', () => {
    expect(classifyIncident(evidence({ logLines: [{ source: 'tunnel', text: 'periodic status: connected', timestamp: '2026-08-20T00:00:00.000Z' }] })).classification)
      .toBe('healthy_or_inconclusive');
  });

  it('requires an explicitly live tunnel, not local MCP or text keywords', () => {
    expect(classifyIncident(evidence({ logLines: [started('a', 'success_error_tool'), completed('a', 'SUCCESS', 'success_error_tool')], tunnel: { ...healthyTunnel, health: { state: 'unavailable', message: 'local MCP is live' } } })).classification).toBe('healthy_or_inconclusive');
    expect(classifyIncident(evidence({ logLines: [started('a'), completed('a')], tunnel: { ...healthyTunnel, state: 'starting', health: { state: 'live', message: 'live' } } })).classification).toBe('healthy_or_inconclusive');
    expect(classifyIncident(evidence({ logLines: [started('a'), completed('a')], tunnel: { ...healthyTunnel, state: 'stopped', health: { state: 'live', message: 'live' } } })).classification).toBe('tunnel_disconnected');
  });

  it('treats missing, new, or conflicting terminal result codes as unknown', () => {
    const unknown = completed('a', 'SUCCESS');
    unknown.correlation.resultCode = 'UNKNOWN_CODE' as never;
    expect(classifyIncident(evidence({ logLines: [started('a', 'tool_success_error'), unknown] })).classification).toBe('healthy_or_inconclusive');
    expect(classifyIncident(evidence({ logLines: [started('b'), { ...completed('b'), correlation: { ...completed('b').correlation, resultCode: null } }] })).classification).toBe('healthy_or_inconclusive');
  });

  it.each([
    'ttl: REACHED!',
    'connection TTL expired.',
    'maximum ttl was exceeded',
    'STDIO-command EXITED.',
    'stdio process terminated?',
    'STDIO MCP was closed',
    'stdio MCP command exited.',
    'STDIO.MCP_process: TERMINATED!',
    'tunnel-client is SHUTTING-DOWN!',
    'control_plane connection: stopped',
    'WebSocket connection disconnected.',
  ])('recognizes protocol-scoped tunnel lifecycle failure %s', (text) => {
    expect(classifyIncident(evidence({ logLines: tunnelLines(text) })).classification).toBe('tunnel_disconnected');
  });

  it.each(['previous task stopped cleanly', 'shutdown documentation loaded'])('does not classify generic display text as tunnel lifecycle evidence: %s', (text) => {
    const logLines = tunnelLines(text);
    expect(logLines[0]?.correlation).toMatchObject({ kind: 'tunnel', lifecycle: 'other' });
    expect(classifyIncident(evidence({ logLines })).classification).toBe('healthy_or_inconclusive');
  });

  it.each(['stdio MCP command exited.', 'STDIO.MCP_process: TERMINATED!'])('blocks remote attribution from multi-qualifier stdio lifecycle evidence: %s', (text) => {
    const logLines = [started('successful', 'read_file', 1), completed('successful', 'SUCCESS', 'read_file', 2), ...tunnelLines(text)];
    expect(classifyIncident(evidence({ logLines })).classification).toBe('tunnel_disconnected');
  });

  it.each(['previous task stopped cleanly', 'shutdown documentation loaded'])('leaves a successful remote attribution eligible after unrelated generic text: %s', (text) => {
    const tunnelLogLines = tunnelLines(text);
    const logLines = [started('successful', 'read_file', 1), completed('successful', 'SUCCESS', 'read_file', 2), ...tunnelLogLines];
    expect(tunnelLogLines[0]?.correlation).toMatchObject({ kind: 'tunnel', lifecycle: 'other' });
    expect(classifyIncident(evidence({ logLines })).classification).toBe('remote_turn_stopped');
  });

  it('uses normalized categories rather than raw tunnel display keywords', () => {
    expect(classifyIncident(evidence({ logLines: [{ source: 'tunnel', text: 'tunnel disconnected', timestamp: timestamp(1) }] })).classification)
      .toBe('healthy_or_inconclusive');
  });

  it.each([
    ['SUCCESS then FAILED', 'SUCCESS', 'FAILED'],
    ['FAILED then SUCCESS', 'FAILED', 'SUCCESS'],
  ] as const)('treats distinct conflicting terminal evidence as inconclusive: %s', (_label, first, second) => {
    const calls = pairMcpCalls([started('same', 'read_file', 1), completed('same', first, 'read_file', 2), completed('same', second, 'read_file', 3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'same', completionState: 'conflict', resultCode: 'UNKNOWN', incomplete: true });
    expect(classifyIncident(evidence({ logLines: [started('same', 'read_file', 1), completed('same', first, 'read_file', 2), completed('same', second, 'read_file', 3)] })).classification)
      .toBe('healthy_or_inconclusive');
  });

  it('dedupes an exact repeated terminal delivery without creating conflict', () => {
    const terminal = completed('same', 'SUCCESS', 'read_file', 2);
    const logLines = [started('same', 'read_file', 1), terminal, terminal];
    expect(pairMcpCalls(logLines)).toEqual([
      expect.objectContaining({ callId: 'same', completionState: 'success', resultCode: 'SUCCESS', incomplete: false }),
    ]);
    expect(classifyIncident(evidence({ logLines })).classification).toBe('remote_turn_stopped');
  });

  it('uses a newer start as the boundary for a reused callId', () => {
    const logLines = [
      started('same', 'read_file', 1), completed('same', 'SUCCESS', 'read_file', 2),
      started('same', 'write_file', 3), completed('same', 'FAILED', 'write_file', 4),
    ];
    expect(pairMcpCalls(logLines).map((call) => [call.toolName, call.completionState])).toEqual([
      ['read_file', 'success'],
      ['write_file', 'failure'],
    ]);
    expect(classifyIncident(evidence({ logLines })).classification).toBe('local_tool_failed');
  });

  it('does not let an old disconnect win after explicit reconnect, later success, and current live health', () => {
    const logLines: IncidentEvidence['logLines'] = [
      { id: 1, source: 'tunnel', text: 'transport stopped', timestamp: timestamp(1), correlation: { kind: 'tunnel', lifecycle: 'transport_stopped' } },
      { id: 2, source: 'tunnel', text: 'transport connected', timestamp: timestamp(2), correlation: { kind: 'tunnel', lifecycle: 'transport_live' } },
      started('recovered', 'read_file', 3),
      completed('recovered', 'SUCCESS', 'read_file', 4),
    ];
    expect(classifyIncident(evidence({ logLines }))).toMatchObject({ classification: 'remote_turn_stopped' });
  });

  it('keeps a current disconnect after a later successful call ahead of remote attribution', () => {
    const logLines: IncidentEvidence['logLines'] = [
      started('successful', 'read_file', 1), completed('successful', 'SUCCESS', 'read_file', 2),
      { id: 3, source: 'tunnel', text: 'transport stopped', timestamp: timestamp(3), correlation: { kind: 'tunnel', lifecycle: 'transport_stopped' } },
    ];
    expect(classifyIncident(evidence({ logLines }))).toMatchObject({ classification: 'tunnel_disconnected' });
  });

  it('remains conservative when recovery lacks a later successful terminal call', () => {
    const logLines: IncidentEvidence['logLines'] = [
      { id: 1, source: 'tunnel', text: 'ttl expired', timestamp: timestamp(1), correlation: { kind: 'tunnel', lifecycle: 'ttl_expired' } },
      { id: 2, source: 'tunnel', text: 'transport connected', timestamp: timestamp(2), correlation: { kind: 'tunnel', lifecycle: 'transport_live' } },
    ];
    expect(classifyIncident(evidence({ logLines }))).toMatchObject({ classification: 'tunnel_disconnected' });
  });
});

describe('incident correlation and privacy', () => {
  it('pairs interleaved MCP calls and retains orphan starts and completions', () => {
    const calls = pairMcpCalls([
      started('a', 'read_file', 1), completed('b', 'SUCCESS', 'read_file', 2), completed('a', 'SUCCESS', 'read_file', 3), started('c', 'read_file', 4),
    ]);
    expect(calls.map((call) => call.callId)).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([
      expect.objectContaining({ callId: 'a', incomplete: false, resultCode: 'SUCCESS', sourceSequence: 1, startedAt: timestamp(1), completedAt: timestamp(3) }),
      expect.objectContaining({ callId: 'b', incomplete: true, completionWithoutStart: true, sourceSequence: 2, startedAt: null, completedAt: timestamp(2) }),
      expect.objectContaining({ callId: 'c', incomplete: true, startedWithoutCompletion: true, sourceSequence: 4, startedAt: timestamp(4), completedAt: null }),
    ]);
  });

  it('keeps repeated callId occurrences separate in chronological queues', () => {
    const calls = pairMcpCalls([started('same', 'read_file', 1), started('same', 'write_file', 2), completed('same', 'SUCCESS', 'read_file', 3), completed('same', 'SUCCESS', 'write_file', 4), completed('orphan', 'SUCCESS', 'read_file', 5)]);
    expect(calls.filter((call) => call.callId === 'same')).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({ callId: 'orphan', completionWithoutStart: true });
  });

  it('pairs raw call identities before redacting their exported values', () => {
    const calls = pairMcpCalls([
      started('token=first-marker', 'read_file', 1),
      started('token=second-marker', 'write_file', 2),
      completed('token=second-marker', 'FAILED', 'write_file', 3),
      completed('token=first-marker', 'SUCCESS', 'read_file', 4),
    ]);
    expect(calls.map((call) => [call.toolName, call.completionState])).toEqual([
      ['read_file', 'success'],
      ['write_file', 'failure'],
    ]);
    expect(JSON.stringify(calls)).not.toContain('first-marker');
    expect(JSON.stringify(calls)).not.toContain('second-marker');
  });

  it('keeps reused IDs and both orphan directions chronological through LogHub and report building', async () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog([
      { id: 'event-1', timestamp: timestamp(1), callId: 'same', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null },
      { id: 'event-2', timestamp: timestamp(2), callId: 'other', kind: 'task', toolName: 'search', resultCode: 'STARTED', targetSummary: null },
      { id: 'event-3', timestamp: timestamp(3), callId: 'same', kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null },
      { id: 'event-4', timestamp: timestamp(4), callId: 'orphan-completion', kind: 'error', toolName: 'write_file', resultCode: 'FAILED', targetSummary: null },
      { id: 'event-5', timestamp: timestamp(5), callId: 'same', kind: 'task', toolName: 'write_file', resultCode: 'STARTED', targetSummary: null },
      { id: 'event-6', timestamp: timestamp(6), callId: 'same', kind: 'result', toolName: 'write_file', resultCode: 'SUCCESS', targetSummary: null },
      { id: 'event-7', timestamp: timestamp(7), callId: 'orphan-start', kind: 'task', toolName: 'shell', resultCode: 'STARTED', targetSummary: null },
    ].reverse(), []);

    const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
    expect(report.mcpCalls.map((call) => call.callId)).toEqual(['same', 'other', 'orphan-completion', 'same', 'orphan-start']);
    expect(report.mcpCalls).toEqual([
      expect.objectContaining({ callId: 'same', toolName: 'read_file', completionState: 'success' }),
      expect.objectContaining({ callId: 'other', startedWithoutCompletion: true }),
      expect.objectContaining({ callId: 'orphan-completion', completionWithoutStart: true, completionState: 'failure' }),
      expect.objectContaining({ callId: 'same', toolName: 'write_file', completionState: 'success' }),
      expect.objectContaining({ callId: 'orphan-start', startedWithoutCompletion: true }),
    ]);
  });

  it.each(['INVALID_INPUT', 'INTERNAL_ERROR', 'EXECUTABLE_NOT_FOUND'])(
    'treats known MCP terminal %s as a completed local failure through LogHub',
    async (resultCode) => {
      const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
      hub.syncWorkLog([
        { id: `${resultCode}-start`, timestamp: timestamp(1), callId: 'failed-call', kind: 'task', toolName: 'search_text', resultCode: 'STARTED', targetSummary: null },
        { id: `${resultCode}-completion`, timestamp: timestamp(2), callId: 'failed-call', kind: 'error', toolName: 'search_text', resultCode, targetSummary: null },
      ], []);

      const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
      expect(report.classification).toBe('local_tool_failed');
      expect(report.mcpCalls).toEqual([
        expect.objectContaining({
          callId: 'failed-call',
          resultCode: 'FAILED',
          completionState: 'failure',
          incomplete: false,
          startedWithoutCompletion: false,
          completionWithoutStart: false,
        }),
      ]);
    },
  );

  it('retains distinct in-flight occurrences reusing a callId through the real LogHub path', async () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog([], [{ callId: 'reused', toolName: 'read_file', targetSummary: null, startedAt: timestamp(1) }]);
    hub.syncWorkLog([{ id: 'finish-1', timestamp: timestamp(2), callId: 'reused', kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null }], []);
    hub.syncWorkLog([], [{ callId: 'reused', toolName: 'write_file', targetSummary: null, startedAt: timestamp(3) }]);
    hub.syncWorkLog([{ id: 'finish-2', timestamp: timestamp(4), callId: 'reused', kind: 'error', toolName: 'write_file', resultCode: 'FAILED', targetSummary: null }], []);

    const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
    expect(report.mcpCalls).toEqual([
      expect.objectContaining({ callId: 'reused', toolName: 'read_file', completionState: 'success', startedAt: timestamp(1) }),
      expect.objectContaining({ callId: 'reused', toolName: 'write_file', completionState: 'failure', startedAt: timestamp(3) }),
    ]);
  });

  it('dedupes exact delivery and the same start observed through in-flight and work-log views', async () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const inFlight = { callId: 'same-event', toolName: 'read_file', targetSummary: null, startedAt: timestamp(1) };
    hub.syncWorkLog([], [inFlight]);
    hub.syncWorkLog([], [inFlight]);
    hub.syncWorkLog([{ id: 'audit-start', timestamp: timestamp(1), callId: 'same-event', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null }], []);

    const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
    expect(report.mcpCalls).toEqual([
      expect.objectContaining({ callId: 'same-event', startedWithoutCompletion: true, startedAt: timestamp(1) }),
    ]);
  });

  it('places historical work-log completions before a newer in-flight reused-ID start', async () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog(
      [{ id: 'old-completion', timestamp: timestamp(2), callId: 'reused', kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null }],
      [{ callId: 'reused', toolName: 'write_file', targetSummary: null, startedAt: timestamp(3) }],
    );

    const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
    expect(report.mcpCalls).toEqual([
      expect.objectContaining({ callId: 'reused', toolName: 'read_file', completionWithoutStart: true, completedAt: timestamp(2) }),
      expect.objectContaining({ callId: 'reused', toolName: 'write_file', startedWithoutCompletion: true, startedAt: timestamp(3) }),
    ]);
  });

  it('places an earlier in-flight start before an unrelated later completion', async () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog(
      [{ id: 'completion-b', timestamp: timestamp(2), callId: 'b', kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null }],
      [{ callId: 'a', toolName: 'write_file', targetSummary: null, startedAt: timestamp(1) }],
    );

    const report = await buildIncidentReport(evidence({ logLines: hub.snapshot().lines }));
    expect(report.mcpCalls.map((call) => call.callId)).toEqual(['a', 'b']);
    expect(report.mcpCalls[0]).toMatchObject({ startedWithoutCompletion: true });
    expect(report.mcpCalls[1]).toMatchObject({ completionWithoutStart: true });
  });

  it('exports the normalized bounded lifecycle category with tunnel tail evidence', async () => {
    const report = await buildIncidentReport(evidence({ logLines: tunnelLines('stdio process stopped.') }));
    expect(report.tunnelLogTail).toEqual([
      expect.objectContaining({ lifecycle: 'stdio_stopped' }),
    ]);
    expect(report.tunnelLogTail[0]).not.toHaveProperty('text');
  });

  it('parses bounded tunnel instance and request ids despite malformed lines', () => {
    expect(parseTunnelCorrelations([
      { source: 'tunnel', text: 'bad { json', timestamp: '2026-08-20T00:00:00.000Z' },
      { source: 'tunnel', text: 'structured only', timestamp: '2026-08-20T00:00:01.000Z', correlation: { kind: 'tunnel' as const, instanceId: 'inst-123', requestId: 'req-456' } },
    ])).toEqual({ instanceIds: ['inst-123'], requestIds: ['req-456'] });
  });

  it('bounds and redacts report text including representative secrets', async () => {
    const report = await buildIncidentReport(evidence({
      logLines: Array.from({ length: 260 }, (_, index) => ({ source: 'tunnel' as const, timestamp: '2026-08-20T00:00:00.000Z', text: `api_key=sk-live-secret-${index} Authorization: Bearer abc.def.ghi\nAuthorization: Basic dXNlcjpwYXNz https://x/?token=very-secret {"apiKey":"json-secret"} X-Api-Key: newline-secret ${'x'.repeat(900)}` })),
      collectProcessTree: async () => [{ pid: 20, parentPid: 10, executable: 'tunnel-client.exe', commandLine: 'tunnel-client.exe --api-key sk-nope --profile lnwjud' }],
      collectListeners: async () => [{ pid: 20, address: '127.0.0.1', port: 7777, owner: 'tunnel-client.exe --token leaked' }],
    }));
    const serialized = JSON.stringify(report);
    expect(report.tunnelLogTail.length).toBeLessThanOrEqual(200);
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('sk-nope');
    expect(serialized).not.toContain('--api-key');
    expect(serialized).not.toContain('--token');
    for (const secret of ['Basic dXNlcjpwYXNz', 'Bearer abc.def.ghi', 'token=very-secret', '"apiKey":"json-secret"', 'X-Api-Key: newline-secret', 'newline-secret']) expect(serialized).not.toContain(secret);
  });

  it('filters process evidence to trusted roots and descendants before applying the export bound', () => {
    const unrelated = Array.from({ length: 205 }, (_, index) => ({ pid: index + 1, parentPid: null, executable: 'other.exe' }));
    const rootPid = 9001;
    const selected = selectRelevantProcesses([...unrelated, { pid: rootPid, parentPid: null, executable: 'tunnel-client.exe' }, { pid: 9002, parentPid: rootPid, executable: 'node.exe' }], [rootPid]);
    expect(selected).toEqual([{ pid: rootPid, parentPid: null, executable: 'tunnel-client.exe' }, { pid: 9002, parentPid: rootPid, executable: 'node.exe' }]);
  });

  it('uses only explicitly trusted PIDs and reports a reason when none are available', async () => {
    let collectedWith: readonly number[] = [];
    const report = await buildIncidentReport(evidence({
      relevantPids: [21, 22, 21],
      logLines: [{ source: 'tunnel', text: 'untrusted pid', timestamp: timestamp(1), correlation: { kind: 'tunnel', lifecycle: 'other', pid: 9999 } }],
      collectProcessTree: async (pids) => { collectedWith = pids; return [{ pid: 21, parentPid: null, executable: 'tunnel-client.exe' }, { pid: 23, parentPid: 21, executable: 'node.exe' }]; },
      collectListeners: async (pids) => pids.map((pid) => ({ pid, address: '127.0.0.1', port: 0, owner: 'must-never-export --token marker_owner' })),
    }));
    expect(collectedWith).toEqual([21, 22]);
    expect(report.processTree).toMatchObject({ available: true, entries: [{ pid: 21 }, { pid: 23 }] });
    expect(report.tcpListeners.entries.map((entry) => entry.pid)).toEqual([21, 22, 23]);
    expect(JSON.stringify(report)).not.toContain('marker_owner');
    expect(report.tcpListeners.entries[0]).not.toHaveProperty('owner');

    const unavailable = await buildIncidentReport(evidence({ relevantPids: [], relevantPidUnavailableReason: 'no_verified_tunnel_pid', collectProcessTree: async () => { throw new Error('must not collect'); }, collectListeners: async () => { throw new Error('must not collect'); } }));
    expect(unavailable.processTree).toEqual({ available: false, entries: [], error: 'no_verified_tunnel_pid' });
    expect(unavailable.tcpListeners).toEqual({ available: false, entries: [], error: 'no_verified_tunnel_pid' });
  });

  it('never exports the free-form tunnel status message', async () => {
    const marker = 'free_form_tunnel_message_must_not_export';
    const report = await buildIncidentReport(evidence({ tunnel: { ...healthyTunnel, message: marker } }));
    expect(report.tunnel).not.toHaveProperty('message');
    expect(JSON.stringify(report)).not.toContain(marker);
  });

  it('structurally excludes raw command, environment, owner, and tunnel text fields', async () => {
    const marker = 'unique_structural_secret_marker';
    const report = await buildIncidentReport(evidence({
      relevantPids: [20],
      updaterEvents: [`error:${marker}`, `update-downloaded:1.2.3`],
      logLines: [{ source: 'tunnel', timestamp: timestamp(1), text: `commandLine --api-key ${marker}`, correlation: { kind: 'tunnel', lifecycle: 'other', instanceId: 'safe-instance' } }],
      collectProcessTree: async () => [{ pid: 20, parentPid: null, executable: 'tunnel-client.exe', commandLine: `--token=${marker}`, environment: { CONTROL_PLANE_API_KEY: marker } } as never],
      collectListeners: async () => [{ pid: 20, address: '127.0.0.1', port: 18444, owner: `Bearer ${marker}` }],
    }));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toMatch(/"(?:commandLine|environment|owner|text)"/);
    expect(report.updaterEventTail).toEqual([{ category: 'error' }, { category: 'update-downloaded', version: '1.2.3' }]);
  });

  it('redacts CLI, prefixed environment, quoted, and arbitrary authorization credential forms', async () => {
    const markers = Array.from({ length: 10 }, (_, index) => `unique_cli_marker_${index}`);
    const credentialForms = [
      `--api-key ${markers[0]}`,
      `--token=${markers[1]}`,
      `--client-secret "${markers[2]}"`,
      `CONTROL_PLANE_API_KEY=${markers[3]}`,
      `MY_REFRESH_TOKEN='${markers[4]}'`,
      `UPSTREAM_ACCESS_TOKEN=${markers[5]}`,
      `OIDC_ID_TOKEN=${markers[6]}`,
      `SERVICE_CLIENT_SECRET=${markers[7]}`,
      `Authorization: Digest ${markers[8]}`,
      `Authorization=Custom-Scheme ${markers[9]}`,
    ];
    const report = await buildIncidentReport(evidence({ updaterEvents: credentialForms, tunnel: { ...healthyTunnel, message: credentialForms.join('; ') } }));
    const serialized = JSON.stringify(report);
    for (const marker of markers) expect(serialized).not.toContain(marker);
  });

  it('redacts every supported credential spelling and serialization context', async () => {
    const cases = [
      ['access_token', 'assignment'], ['access-token', 'header'], ['accessToken', 'json'],
      ['refresh_token', 'query'], ['refreshToken', 'assignment'], ['id_token', 'header'], ['idToken', 'json'],
      ['auth_token', 'query'], ['authToken', 'assignment'], ['api_key', 'header'], ['apiKey', 'json'],
      ['client_secret', 'query'], ['clientSecret', 'assignment'], ['password', 'json'], ['token', 'header'], ['secret', 'query'],
      ['xApiKey', 'json'], ['XApiKey', 'assignment'], ['xApiKey', 'header'], ['XApiKey', 'query'],
    ] as const;
    const markers = cases.map(([key], index) => `marker_${index}_${key.replace(/[^a-z]/gi, '')}`);
    const lines = cases.map(([key, context], index) => {
      const marker = markers[index]!;
      if (context === 'json') return `{"${key}":"${marker}"}`;
      if (context === 'query') return `https://example.invalid/?safe=1&${key}=${marker}&next=1`;
      if (context === 'header') return `safe: yes\r\n${key}: ${marker}\r\nnext: okay`;
      return `${key} = ${marker}`;
    });
    lines.push('Authorization: Basic marker_basic_value', 'authorization: Bearer marker_bearer_value');

    const report = await buildIncidentReport(evidence({ updaterEvents: lines }));
    const serialized = JSON.stringify(report);
    for (const marker of [...markers, 'marker_basic_value', 'marker_bearer_value']) expect(serialized).not.toContain(marker);
  });

  it('applies bounded redaction to every report string before serialization', async () => {
    const markers = {
      app: 'marker_app', version: 'marker_version', reason: 'marker_reason', updater: 'marker_updater',
      state: 'marker_state', source: 'marker_source', tunnel: 'marker_tunnel', health: 'marker_health',
      instance: 'marker_instance', request: 'marker_request', call: 'marker_call', tool: 'marker_tool',
      tail: 'marker_tail', process: 'marker_process', processError: 'marker_process_error', listenerError: 'marker_listener_error',
    } as const;
    const report = await buildIncidentReport(evidence({
      appVersion: `password=${markers.app}`,
      tunnelClientVersion: `access_token=${markers.version}`,
      tunnelClientVersionReason: `refreshToken=${markers.reason}`,
      updaterEvents: [`id-token=${markers.updater}`],
      tunnel: {
        state: `token=${markers.state}` as never,
        source: `secret=${markers.source}` as never,
        message: `Authorization: Basic ${markers.tunnel}`,
        health: { state: 'unknown', message: `clientSecret=${markers.health}` },
      },
      logLines: [
        { id: 1, source: 'tunnel', timestamp: `authToken=${markers.tail}`, text: `api-key=${markers.tail}`, correlation: { kind: 'tunnel', lifecycle: 'other', instanceId: `token=${markers.instance}`, requestId: `secret=${markers.request}` } },
        { id: 2, source: 'mcp', timestamp: timestamp(2), text: 'display', correlation: { kind: 'mcp', phase: 'started', callId: `accessToken=${markers.call}`, toolName: `client_secret=${markers.tool}`, resultCode: null } },
      ],
      collectProcessTree: async () => [{ pid: 20, parentPid: null, executable: `password=${markers.process}` }],
      collectListeners: async () => { throw new Error(`token=${markers.listenerError}`); },
    }));
    const withProcessError = await buildIncidentReport(evidence({
      collectProcessTree: async () => { throw new Error(`secret=${markers.processError}`); },
    }));

    const serialized = JSON.stringify([report, withProcessError]);
    for (const marker of Object.values(markers)) expect(serialized).not.toContain(marker);
    for (const value of allStrings([report, withProcessError])) expect(value.length).toBeLessThanOrEqual(512);
  });

  it('keeps a usable report when read-only collectors fail', async () => {
    const report = await buildIncidentReport(evidence({
      relevantPids: [20],
      collectProcessTree: async () => { throw new Error('access denied'); },
      collectListeners: async () => { throw new Error('netstat denied'); },
    }));
    expect(report.processTree).toEqual(expect.objectContaining({ available: false, error: 'access denied' }));
    expect(report.tcpListeners).toEqual(expect.objectContaining({ available: false, error: 'netstat denied' }));
  });
});

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(allStrings);
}

describe('incident export workflow', () => {
  it('returns a typed cancelled result without writing when the user cancels', async () => {
    const result = await exportIncidentReport(evidence(), {
      choosePath: async () => null,
      writeAtomically: async () => { throw new Error('must not write'); },
    });
    expect(result).toEqual({ exported: false, cancelled: true, classification: 'healthy_or_inconclusive', capturedAt: null });
  });

  it('writes bounded JSON after a user chooses a path', async () => {
    let saved = '';
    const result = await exportIncidentReport(evidence(), {
      choosePath: async () => 'C:/tmp/incident.json',
      writeAtomically: async (_path, content) => { saved = content; },
    });
    expect(result).toMatchObject({ exported: true, cancelled: false, classification: 'healthy_or_inconclusive', capturedAt: expect.any(String) });
    expect(JSON.parse(saved)).toMatchObject({ schemaVersion: 1, classification: 'healthy_or_inconclusive' });
  });
});

describe.skipIf(process.platform !== 'darwin')('incident collectors on posix', () => {
  it('parses ps process rows into the incident process shape', () => {
    const fixture = [
      '   PID  PPID COMM',
      '     1     0 /sbin/launchd',
      '   482     1 /Applications/lnwjud.app/Contents/MacOS/lnwjud',
      '   512   482 /Applications/lnwjud.app/Contents/Frameworks/lnwjud Helper (Renderer).app/Contents/MacOS/lnwjud Helper (Renderer)',
      '  bad-line',
      '  7000  abc /usr/bin/no-parent',
    ].join('\n');

    expect(parsePosixProcessRows(fixture)).toEqual([
      { pid: 1, parentPid: null, executable: '/sbin/launchd' },
      { pid: 482, parentPid: 1, executable: '/Applications/lnwjud.app/Contents/MacOS/lnwjud' },
      { pid: 512, parentPid: 482, executable: '/Applications/lnwjud.app/Contents/Frameworks/lnwjud Helper (Renderer).app/Contents/MacOS/lnwjud Helper (Renderer)' },
    ]);
  });

  it('parses lsof listening rows into the incident listener shape for the trusted pids only', () => {
    const fixture = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'node    48200 ar677   38u  IPv4  0x1f8a5c2e1a3b      0t0  TCP *:9223 (LISTEN)',
      'node    48200 ar677   39u  IPv6  0x1f8a5c2e1a3c      0t0  TCP [::1]:9443 (LISTEN)',
      'ssh     51500 ar677   12u  IPv4  0x1f8a5c2e1a3d      0t0  TCP 127.0.0.1:52101 (LISTEN)',
      'node    99999 ar677   40u  IPv4  0x1f8a5c2e1a3e      0t0  TCP *:9999 (LISTEN)',
    ].join('\n');

    expect(parsePosixListenerRows(fixture, [48200, 51500])).toEqual([
      { pid: 48200, address: '*', port: 9223 },
      { pid: 48200, address: '::1', port: 9443 },
      { pid: 51500, address: '127.0.0.1', port: 52101 },
    ]);
  });

  it('collects a live process tree containing the calling process via ps', async () => {
    const entries = await collectRelevantProcessTree([process.pid]);
    const own = entries.find((entry) => entry.pid === process.pid);
    expect(own).toBeDefined();
    expect(own?.executable).toBeTruthy();
  });

  it('collects a live tcp listener via lsof for a bound port', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const entries = await collectRelevantListeners([process.pid]);
      expect(entries).toContainEqual(expect.objectContaining({ pid: process.pid, port }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
