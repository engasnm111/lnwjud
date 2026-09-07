/* global process */
import { startMcpStdio } from '../../dist/stdio.js';

const MODERN_TASK_ID = 'modern-stdio-shell-task';
let taskState = 'running';

function snapshot() {
  return {
    task_id: MODERN_TASK_ID,
    state: taskState,
    started_at: '2026-09-07T05:00:00.000Z',
    deadline_at: '2026-09-07T05:10:00.000Z',
    durable: true,
    truncated: false,
    ...(taskState === 'cancelled' ? { finished_at: '2026-09-07T05:01:00.000Z' } : {}),
  };
}

process.stderr.write('lnwjud-stdio-test-diagnostic\n');
startMcpStdio({
  services: {
    capabilities: {
      async execute(tool, request) {
        if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } };
        if (request.operation === 'run') {
          taskState = 'running';
          return { ok: true, value: snapshot() };
        }
        if (request.task_id !== MODERN_TASK_ID) {
          return { ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } };
        }
        if (request.operation === 'cancel') taskState = 'cancelled';
        return { ok: true, value: snapshot() };
      },
    },
  },
  actor: { clientId: 'stdio-test', clientName: 'stdio-test' },
});
