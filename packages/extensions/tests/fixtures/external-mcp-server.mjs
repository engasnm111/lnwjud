/* global process */
import readline from 'node:readline';

const era = process.env.LNWJUD_EXTERNAL_MCP_FIXTURE_ERA === 'modern' ? 'modern' : 'legacy';
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
      tools: [{
        name: era === 'modern' ? 'modern_ping' : 'legacy_ping',
        description: `${era} external MCP fixture`,
        inputSchema: { type: 'object', additionalProperties: false },
      }],
    });
    return;
  }

  if (message?.id !== undefined) rpcError(message.id, -32601, 'Method not found');
});
