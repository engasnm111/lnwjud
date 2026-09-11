/* global process */
// Regression fixture for the stdin/stdout override added to startMcpStdio: routes
// the real process stdio through intermediary PassThrough streams instead of
// letting StdioServerTransport default to process.stdin/process.stdout directly.
// This is the same shape of indirection the packaged Electron app's relay child
// uses to work around process.stdin being unreadable in Electron's Windows main
// process (electron/electron#21705) — here the indirection is a plain pipe
// instead of an IPC hop, which is enough to prove the override is wired through
// to the transport correctly.
import { PassThrough } from 'node:stream';
import { startMcpStdio } from '../../dist/stdio.js';

const relayStdin = new PassThrough();
const relayStdout = new PassThrough();
process.stdin.pipe(relayStdin);
relayStdout.pipe(process.stdout);

process.stderr.write('lnwjud-stdio-relay-passthrough-diagnostic\n');
startMcpStdio({
  services: {
    capabilities: {
      async execute(tool) {
        if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } };
        return { ok: true, value: { task_id: 'relay-passthrough-task', state: 'running', started_at: '2026-09-11T00:00:00.000Z', deadline_at: '2026-09-11T00:10:00.000Z', durable: true, truncated: false } };
      },
    },
  },
  actor: { clientId: 'stdio-relay-passthrough-test', clientName: 'stdio-relay-passthrough-test' },
  stdin: relayStdin,
  stdout: relayStdout,
});
