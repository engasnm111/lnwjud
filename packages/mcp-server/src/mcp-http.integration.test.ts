import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ok } from '@lnwjud/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityTracker } from './activity-tracker.js';
import { ToolRegistry } from './tool-registry.js';
import { LNWJUD_MCP_IDENTITY_PATH, startMcpHttp, type McpHttpServerHandle } from './http.js';

const expectedAdvertisedToolCount = new ToolRegistry({}, { clientId: 'count-test', clientName: 'count-test' }).list().length;

describe('MCP localhost HTTP transport', () => {
  let handle: McpHttpServerHandle;
  let workspaceListCalls: number;
  let workspaceListImpl: () => Promise<ReturnType<typeof ok<readonly { id: string; kind: string }[]>>>;
  let activityTracker: ActivityTracker;

  beforeEach(async () => {
    workspaceListCalls = 0;
    activityTracker = new ActivityTracker();
    workspaceListImpl = async (): Promise<ReturnType<typeof ok<readonly { id: string; kind: string }[]>>> => ok([{ id: 'workspace-1', kind: 'project' }]);
    handle = await startMcpHttp({
      port: 0,
      services: {
        workspaceInfo: {
          async info() { return ok({ id: 'workspace-1' }); },
          async list() {
            workspaceListCalls += 1;
            return workspaceListImpl();
          },
        },
      },
      actor: { clientId: 'http-test', clientName: 'http-test' },
      activityTracker,
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('binds the server to the loopback address and serves v2026-07-28 tools', async () => {
    expect(handle.address.host).toBe('127.0.0.1');
    expect(handle.address.port).toBeGreaterThan(0);
    expect(handle.endpoint.pathname).toBe('/mcp');

    const client = new Client(
      { name: 'lnwjud-http-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const first = await client.listTools();
      const second = await client.listTools();

      expect(first.tools.map((tool) => tool.name)).toHaveLength(expectedAdvertisedToolCount);
      expect(first.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);
      expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
    } finally {
      await client.close();
    }
  });

  it('advertises outcome-driven continuation without an elapsed-time cutoff', async () => {
    const client = new Client({ name: 'continuity-policy-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const instructions = client.getInstructions();

      expect(instructions).toContain('until the requested outcome is complete');
      expect(instructions).toContain('because elapsed time has passed');
      expect(instructions).not.toMatch(/\b(?:22|25|60)\s*minutes?\b/i);
    } finally {
      await client.close();
    }
  });

  it('keeps one legacy 2025 session alive across sequential production tool calls', async () => {
    const client = new Client({ name: 'codex-compatible-http-test-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);

      expect(transport.sessionId).toEqual(expect.any(String));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toHaveLength(expectedAdvertisedToolCount);
      expect(tools.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);

      const first = await client.callTool({ name: 'workspace_list', arguments: {} });
      const second = await client.callTool({ name: 'workspace_list', arguments: {} });
      const third = await client.callTool({ name: 'workspace_list', arguments: {} });

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(third.isError).not.toBe(true);
      expect(workspaceListCalls).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('keeps a legacy session usable after the client transport disconnects and reconnects', async () => {
    const firstClient = new Client({ name: 'disconnecting-client', version: '0.1.0' });
    const firstTransport = new StreamableHTTPClientTransport(handle.endpoint);
    await firstClient.connect(firstTransport);

    const sessionId = firstTransport.sessionId;
    const protocolVersion = firstTransport.protocolVersion;
    expect(sessionId).toEqual(expect.any(String));
    expect((await firstClient.callTool({ name: 'workspace_list', arguments: {} })).isError).not.toBe(true);

    await firstClient.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const reconnectTransport = new StreamableHTTPClientTransport(handle.endpoint, {
      sessionId,
      protocolVersion,
    });
    await reconnectTransport.start();
    try {
      const response = new Promise<unknown>((resolve, reject): void => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for reconnect tool response')), 2_000);
        reconnectTransport.onerror = reject;
        reconnectTransport.onmessage = (message): void => {
          if ('id' in message && message.id === 71) {
            clearTimeout(timeout);
            resolve(message);
          }
        };
      });
      await reconnectTransport.send({
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/call',
        params: { name: 'workspace_list', arguments: {} },
      });
      const message = await response;
      expect(message).toMatchObject({ jsonrpc: '2.0', id: 71 });
      expect(workspaceListCalls).toBe(2);
    } finally {
      await reconnectTransport.close();
    }
  });

  it('releases an aborted standalone SSE stream so the same session can reconnect', async () => {
    const client = new Client({ name: 'sse-disconnect-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    await client.connect(transport);

    const sessionId = transport.sessionId;
    const protocolVersion = transport.protocolVersion;
    expect(sessionId).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 25));
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const controller = new AbortController();
    try {
      const reopened = fetch(handle.endpoint, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': sessionId!,
          ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
        },
        signal: controller.signal,
      });
      const response = await Promise.race([
        reopened,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE reconnect did not receive headers')), 1_000)),
      ]);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      controller.abort();
    }
  });

  it('keeps concurrent calls isolated and activity accounting balanced', async () => {
    let concurrentStarts = 0;
    let releaseCalls!: () => void;
    let observeBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { observeBoth = resolve; });
    const release = new Promise<void>((resolve) => { releaseCalls = resolve; });
    workspaceListImpl = async (): Promise<ReturnType<typeof ok<readonly { id: string; kind: string }[]>>> => {
      concurrentStarts += 1;
      if (concurrentStarts === 2) observeBoth();
      await release;
      return ok([{ id: 'workspace-1', kind: 'project' }]);
    };

    const client = new Client({ name: 'concurrent-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    try {
      await client.connect(transport);
      const first = client.callTool({ name: 'workspace_list', arguments: {} });
      const second = client.callTool({ name: 'workspace_list', arguments: {} });
      await bothStarted;

      expect(activityTracker.listInFlight()).toHaveLength(2);
      expect(activityTracker.revision()).toBe(2);

      releaseCalls();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(activityTracker.listInFlight()).toHaveLength(0);
      expect(activityTracker.revision()).toBe(4);
      expect(workspaceListCalls).toBe(2);
    } finally {
      releaseCalls?.();
      await client.close();
    }
  });

  it('keeps a Set-of-Marks observation alive across modern HTTP request-scoped server instances', async () => {
    await handle.close();
    const png = { format: 'png', mime_type: 'image/png', data_base64: 'cG5n', width: 640, height: 480, origin_x: 0, origin_y: 0 };
    handle = await startMcpHttp({
      port: 0,
      services: {
        capabilities: {
          async execute(tool, input) {
            const request = input as Record<string, unknown>;
            if (tool === 'accessibility' && request.action === 'observe') {
              return ok({ elements: [{ element: { name: 'Save', automation_id: 'save', enabled: true, offscreen: false, bounds: { x: 20, y: 30, width: 100, height: 40 } } }] });
            }
            if (tool === 'accessibility' && request.action === 'find_element') return ok({ element: { name: 'Save', automation_id: 'save', bounds: { x: 20, y: 30, width: 100, height: 40 } } });
            if (tool === 'accessibility' && request.action === 'click') return ok({ clicked: true });
            if (tool === 'vision') return ok(png);
            return ok({});
          },
        },
      },
      actor: { clientId: 'som-http-test', clientName: 'som-http-test' },
      hostMutationApprovalProvider: async () => true,
    });

    const client = new Client(
      { name: 'som-modern-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    try {
      await client.connect(transport);
      const captured = await client.callTool({ name: 'vision_annotated_capture', arguments: { workspaceId: 'workspace-1' } });
      expect(captured.isError).not.toBe(true);
      const observationId = captured.structuredContent?.observationId;
      const observationHash = captured.structuredContent?.observationHash;
      expect(observationId).toEqual(expect.any(String));
      expect(observationHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));

      const clicked = await client.callTool({
        name: 'ui_target_action',
        arguments: { workspaceId: 'workspace-1', observationId, observationHash, markId: 'm1', action: 'click', userConfirmed: true },
      });
      expect(clicked.isError, JSON.stringify(clicked)).not.toBe(true);
      expect(clicked.structuredContent).toMatchObject({ clicked: true });
    } finally {
      await client.close();
    }
  });

  it('serves a loopback identity document that Doctor can distinguish from an unrelated listener', async () => {
    const identityUrl = new URL(LNWJUD_MCP_IDENTITY_PATH, handle.endpoint);
    const response = await fetch(identityUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-lnwjud-service')).toBe('desktop-mcp');
    await expect(response.json()).resolves.toMatchObject({ product: 'lnwjud', service: 'desktop-mcp', protocol: 1 });
  });

  it('does not poison a legacy session after one protocol-level tool error', async () => {
    const client = new Client({ name: 'error-recovery-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    try {
      await client.connect(transport);
      await expect(client.callTool({ name: 'definitely_not_a_real_tool', arguments: {} })).rejects.toThrow();

      const recovered = await client.callTool({ name: 'workspace_list', arguments: {} });
      expect(recovered.isError).not.toBe(true);
      expect(workspaceListCalls).toBe(1);
    } finally {
      await client.close();
    }
  });
});
