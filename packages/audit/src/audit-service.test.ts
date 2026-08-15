import { describe, expect, it } from 'vitest';
import { AuditService, type AuditEvent, type AuditEventRepository } from './audit-service.js';

class MemoryAuditRepository implements AuditEventRepository {
  public readonly events: AuditEvent[] = [];

  public async insert(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

describe('AuditService', () => {
  it('redacts metadata before handing it to persistence', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).record({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'process_start',
      resultCode: 'SUCCESS',
      durationMs: 12,
      metadata: { Authorization: 'Bearer token-123', API_KEY: 'secret-123', safe: 'value' },
    });

    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]?.metadata).toEqual({ Authorization: '[REDACTED]', API_KEY: '[REDACTED]', safe: 'value' });
    expect(JSON.stringify(repository.events[0])).not.toContain('token-123');
    expect(JSON.stringify(repository.events[0])).not.toContain('secret-123');
  });

  it('stores Codex instruction metadata without the instruction text', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).recordCodexRun({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      codexTaskId: 'codex-1',
      instruction: 'do not persist this prompt',
      resultCode: 'STARTED',
      durationMs: 1,
    });

    expect(repository.events[0]?.metadata).toMatchObject({ codexTaskId: 'codex-1', instructionLength: 26 });
    expect(JSON.stringify(repository.events[0])).not.toContain('do not persist this prompt');
  });

  it('records MCP tool activity with phase metadata', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).recordMcpTool({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      toolName: 'read_file',
      callId: 'call-1',
      phase: 'completed',
      targetSummary: 'src\\app.ts',
      resultCode: 'SUCCESS',
      durationMs: 8,
    });

    expect(repository.events[0]).toMatchObject({
      action: 'mcp_tool:read_file',
      targetSummary: 'src\\app.ts',
      resultCode: 'SUCCESS',
      metadata: { toolName: 'read_file', callId: 'call-1', phase: 'completed' },
    });
  });
});
