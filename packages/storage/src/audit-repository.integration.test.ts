import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@lnwjud/audit';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteAuditRepository', () => {
  it('pairs started/completed calls by workspace and session with goal attribution, missing timings and stable keyset pages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-call-history-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    try {
    const at = (n: number): string => new Date(Date.parse('2026-10-08T00:00:00.000Z') + n * 1000).toISOString();
    const record = (id: string, callId: string, phase: 'started' | 'completed', tick: number, props: Partial<AuditEvent> = {}): Promise<void> =>
      repository.insert({
        id, timestamp: at(tick), actorId: 'client', actorName: 'Tester',
        workspaceId: 'ws-a', sessionId: 'sess-a',
        action: 'mcp_tool:read_file', resultCode: phase === 'started' ? 'STARTED' : 'SUCCESS',
        durationMs: phase === 'started' ? 0 : 11,
        metadata: { callId, toolName: 'read_file', phase, ...(phase === 'completed' ? { goalId: 'goal-verified' } : {}) },
        ...props,
      });
    await record('start-1','call-1','started',1);
    await record('done-1','call-1','completed',5);
    await record('start-2','call-2','started',3);
    await record('done-3','call-3','completed',2, { resultCode: 'CONFLICT', durationMs: 0 });
    await record('other-workspace','call-1','completed',6,{ workspaceId: 'ws-b', sessionId:'sess-b' });
    await record('other-session','call-1','completed',7,{ sessionId:'sess-b' });
    const first = await repository.listCallHistory({ workspaceId: 'ws-a', limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({ eventId:'other-session', callId:'call-1', goalId:'goal-verified', durationMs:11, startedAt:null })]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await repository.listCallHistory({ workspaceId: 'ws-a', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toEqual([
      expect.objectContaining({ eventId:'done-1', callId:'call-1', phase:'completed', durationMs:11, startedAt:at(1) }),
      expect.objectContaining({ callId:'call-2', phase:'started', durationMs:null }),
    ]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const third = await repository.listCallHistory({ workspaceId:'ws-a', limit:2, cursor: second.nextCursor! });
    expect(third.items).toEqual([expect.objectContaining({ callId:'call-3', phase:'completed', durationMs:0, startedAt:null })]);
    expect(third.nextCursor).toBeNull();
    const filtered = await repository.listCallHistory({ workspaceId:'ws-a', goalId:'goal-verified', limit:10 });
    expect(filtered.items.map((item)=>item.callId)).toEqual(['call-1','call-1','call-3']);
    await expect(repository.listCallHistory({ workspaceId:'ws-a', limit:10,cursor:'bad!cursor' })).rejects.toThrow('Invalid audit cursor');
    } finally { database.close(); }
  });


  it('persists sanitized audit metadata through the audit migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-audit-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const event: AuditEvent = {
      id: 'event-1',
      timestamp: new Date(0).toISOString(),
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'read_file',
      resultCode: 'SUCCESS',
      durationMs: 4,
      metadata: { path: 'src/index.ts' },
    };

    await repository.insert(event);

    await expect(repository.list(10)).resolves.toEqual([event]);
    database.close();
  });

  it('round-trips session scope and applies workspace/session filters before LIMIT', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-audit-scope-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);

    const targetEvents: AuditEvent[] = [
      scopedEvent('target-1', '2026-08-20T00:00:01.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-2', '2026-08-20T00:00:02.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-b', '2026-08-20T00:00:03.000Z', 'workspace-target', 'session-b'),
    ];
    for (const event of targetEvents) await repository.insert(event);
    for (let index = 0; index < 25; index += 1) {
      await repository.insert(scopedEvent(
        `noise-${index}`,
        `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
        'workspace-noise',
        'session-noise',
      ));
    }

    await expect(repository.listScoped({
      actionPrefix: 'mcp_tool:',
      workspaceId: 'workspace-target',
      sessionId: 'session-a',
    }, 2)).resolves.toEqual([targetEvents[1], targetEvents[0]]);
    await expect(repository.listScoped({ workspaceId: 'workspace-target', sessionId: 'session-b' }, 10))
      .resolves.toEqual([targetEvents[2]]);
    database.close();
  }, 20_000);

  it('lists historical activity sessions independently of the 500-row event window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-audit-session-catalog-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    database.connection.exec('BEGIN');
    try {
      await repository.insert(scopedEvent('old-session-event', '2026-08-20T00:00:00.000Z', 'workspace-old', 'session-old'));
      for (let index = 0; index < 520; index += 1) {
        await repository.insert(scopedEvent(
          `noise-${index}`,
          new Date(base + index * 1_000).toISOString(),
          'workspace-new',
          'session-new',
        ));
      }
      database.connection.exec('COMMIT');
    } catch (error) {
      database.connection.exec('ROLLBACK');
      throw error;
    }

    const sessions = await repository.listActivitySessions('mcp_tool:');
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-old', workspaceId: 'workspace-old', startedAt: '2026-08-20T00:00:00.000Z' }),
      expect.objectContaining({ sessionId: 'session-new', workspaceId: 'workspace-new' }),
    ]));
    database.close();
  }, 20_000);

  it('preserves legacy null session scope during migration and can query it explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-audit-legacy-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const legacy: AuditEvent = {
      id: 'legacy-event', timestamp: '2026-08-20T00:00:00.000Z', actorId: 'legacy', actorName: 'legacy',
      action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: {},
    };
    const scoped = scopedEvent('scoped-event', '2026-08-20T00:00:01.000Z', 'workspace-1', 'session-1');
    await repository.insert(legacy);
    await repository.insert(scoped);

    await expect(repository.listScoped({ workspaceId: null, sessionId: null }, 10)).resolves.toEqual([legacy]);
    database.close();
  });

  it('batch-searches retained target detail by call id, event id, and completed reference', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-audit-detail-search-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const base = {
      actorId: 'client-1', actorName: 'test', action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
    } as const;
    await repository.insert({
      ...base,
      id: 'started-a',
      timestamp: '2026-08-20T00:00:00.000Z',
      metadata: {
        callId: 'call-a', phase: 'started', toolName: 'read_file',
        activityTargetDetail: { kind: 'files', items: ['visible.ts', 'hidden-needle.ts'] },
      },
    });
    await repository.insert({
      ...base,
      id: 'completed-a',
      timestamp: '2026-08-20T00:00:01.000Z',
      metadata: {
        callId: 'call-a', phase: 'completed', toolName: 'read_file',
        activityTargetDetail: { kind: 'details', items: ['completed-needle'] },
      },
    });

    await expect(repository.activityTargetDetailsMatching(
      ['call-a', 'started-a', 'call-a:completed', 'missing-ref'],
      'needle',
    )).resolves.toEqual(new Set(['call-a', 'started-a', 'call-a:completed']));
    await expect(repository.activityTargetDetailsMatching(['call-a'], 'absent')).resolves.toEqual(new Set());
    database.close();
  });

});


function scopedEvent(id: string, timestamp: string, workspaceId: string, sessionId: string): AuditEvent {
  return {
    id, timestamp, actorId: 'client-1', actorName: 'test', workspaceId, sessionId,
    action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: { callId: id },
  };
}
