/* global process */
import readline from 'node:readline';

const fixtureMode = process.env.LNWJUD_EXTERNAL_MCP_FIXTURE_ERA ?? 'legacy';
const era = fixtureMode === 'modern' ? 'modern' : 'legacy';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message?.method === 'server/discover' && message.id !== undefined) {
    if (era === 'modern') {
      result(message.id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      });
    } else {
      rpcError(message.id, -32601, 'Method not found');
    }
    return;
  }

  if (message?.method === 'initialize' && message.id !== undefined) {
    if (era === 'modern') {
      rpcError(message.id, -32601, 'Modern fixture does not use initialize');
      return;
    }
    const requested = typeof message.params?.protocolVersion === 'string'
      ? message.params.protocolVersion
      : '2025-11-25';
    result(message.id, {
      protocolVersion: requested.startsWith('2025-') ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'lnwjud-external-legacy-fixture', version: '1.0.0' },
    });
    return;
  }

  if (message?.method === 'tools/list' && message.id !== undefined) {
    result(message.id, {
      ...(era === 'modern'
        ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
        : {}),
      tools: fixtureMode === 'schema-error'
        ? [{
          name: 'schema_error_demo',
          description: 'output schema error fixture',
          inputSchema: { type: 'object', additionalProperties: true },
          outputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        }]
        : [{
          name: era === 'modern' ? 'modern_ping' : 'legacy_ping',
          description: `${era} external MCP fixture`,
          inputSchema: { type: 'object', additionalProperties: false },
        }],
    });
    return;
  }

  if (message?.method === 'tools/call' && message.id !== undefined && fixtureMode === 'schema-error') {
    const mode = message.params?.arguments?.mode;
    if (mode === 'error-no-structured') {
      result(message.id, { isError: true, content: [{ type: 'text', text: 'Demo validation failed: invalid input' }] });
    } else if (mode === 'error-invalid-structured') {
      result(message.id, { isError: true, structuredContent: { value: 42 }, content: [{ type: 'text', text: 'Still the child error' }] });
    } else if (mode === 'success-valid') {
      result(message.id, { structuredContent: { value: 'ok' }, content: [] });
    } else if (mode === 'success-invalid') {
      result(message.id, { structuredContent: { value: 42 }, content: [] });
    } else {
      result(message.id, { content: [{ type: 'text', text: 'missing structured content' }] });
    }
    return;
  }

  if (message?.id !== undefined) rpcError(message.id, -32601, 'Method not found');
});
