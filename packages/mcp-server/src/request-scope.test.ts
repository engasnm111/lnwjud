import { describe, expect, it } from 'vitest';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@lnwjud/capabilities';
import { actorForRequestScope, createHttpRequestScope, createProtocolHttpRequestScope, createStdioRequestScope, withCapabilityOwnerMetadata } from './request-scope.js';

describe('MCP request scope', () => {
  it('keeps protocol HTTP sessions stable and distinct', () => {
    const first = createProtocolHttpRequestScope('protocol-a');
    const reconnect = createProtocolHttpRequestScope('protocol-a');
    const other = createProtocolHttpRequestScope('protocol-b');
    expect(reconnect.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it('uses one explicit synthetic STDIO identity for a serving lifetime', () => {
    expect(createStdioRequestScope('stdio-a')).toMatchObject({ sessionId: 'stdio-a', transport: 'stdio' });
  });

  it('uses a stable endpoint fallback only when HTTP has no protocol session', () => {
    const request = new Request('http://127.0.0.1/mcp');
    expect(createHttpRequestScope({ request, fallbackSessionId: 'endpoint-a' }).sessionId).toBe('endpoint-a');
  });

  it('captures bounded W3C trace headers and redacts sensitive baggage members', () => {
    const request = new Request('http://127.0.0.1/mcp', { headers: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=opaque',
      baggage: 'tenant=acme,api_key=super-secret,region=apac',
    } });
    expect(createHttpRequestScope({ request, fallbackSessionId: 'endpoint-a' })).toMatchObject({
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      traceState: 'vendor=opaque',
      baggage: 'tenant=acme,api_key=[redacted],region=apac',
    });
  });

  it('overwrites spoofed task ownership metadata with the trusted scoped actor', () => {
    const actor = actorForRequestScope({ clientId: 'client-1', clientName: 'test' }, createStdioRequestScope('session-a'));
    const input = withCapabilityOwnerMetadata({ workspaceId: 'ws-1', metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'attacker', sessionId: 'spoofed' } } }, actor);
    expect(input).toMatchObject({ metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId: 'session-a', workspaceId: 'ws-1' } } });
  });
});
