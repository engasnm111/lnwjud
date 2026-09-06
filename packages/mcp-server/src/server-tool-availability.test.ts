import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@lnwjud/application';
import type { ToolAvailabilitySnapshot } from '@lnwjud/shared';
import { createMcpServer } from './server.js';
import type { McpApplicationServices } from './tool-registry.js';

const actor: FileActor = {
  clientId: 'tool-availability-test-client',
  clientName: 'tool-availability-test',
  sessionId: 'tool-availability-test-session',
};

describe('MCP server live tool availability', () => {
  it('updates one connected client live and debounces tools/list_changed notifications', async () => {
    let snapshot: ToolAvailabilitySnapshot = { version: 1, generation: 0, overrides: {} };
    const listeners = new Set<(next: ToolAvailabilitySnapshot) => void>();
    let unsubscribeCount = 0;

    const server = createMcpServer({
      services: {} as McpApplicationServices,
      actor,
      toolAvailabilitySnapshotProvider: () => snapshot,
      toolAvailabilitySubscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) unsubscribeCount += 1;
        };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tool-availability-test-client', version: '1.0.0' });
    let toolListChangedNotifications = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      toolListChangedNotifications += 1;
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const initial = await client.listTools();
      expect(initial.tools.map((tool) => tool.name)).toContain('read_file');
      expect(initial.tools.map((tool) => tool.name)).not.toContain('codex_run');

      snapshot = {
        version: 1,
        generation: 1,
        overrides: { read_file: 'disabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      snapshot = {
        version: 1,
        generation: 2,
        overrides: { read_file: 'disabled', codex_run: 'enabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      await vi.waitFor(() => {
        expect(toolListChangedNotifications).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(toolListChangedNotifications).toBe(1);

      const updated = await client.listTools();
      expect(updated.tools.map((tool) => tool.name)).not.toContain('read_file');
      expect(updated.tools.map((tool) => tool.name)).toContain('codex_run');
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }

    expect(unsubscribeCount).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
