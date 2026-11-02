import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProcessTreeTerminator } from '@lnwjud/process';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultMcpClientFactory } from './mcp-session-manager.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/external-mcp-server.mjs', import.meta.url));

describe('default MCP POSIX process cleanup', () => {
  it.skipIf(process.platform !== 'linux')('passes the SDK child handle to process-group cleanup', async () => {
    const terminator = createProcessTreeTerminator('linux');
    const stop = vi.fn(terminator.stop.bind(terminator));
    const session = await createDefaultMcpClientFactory({ stop }).connect({
      command: process.execPath,
      args: [fixturePath],
      env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'modern' },
    });

    try {
      await expect(session.listTools()).resolves.toEqual([expect.objectContaining({ name: 'modern_ping' })]);
    } finally {
      await session.close();
    }

    expect(stop).toHaveBeenCalled();
    for (const [child, pid] of stop.mock.calls) {
      expect(child).toBeInstanceOf(ChildProcess);
      expect(child.pid).toBe(pid);
    }
  });
});
