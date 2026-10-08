import { appError, err, ok, type CallHistoryPage, type CallHistoryQuery, type CallTimingObservation, type Result } from '@lnwjud/domain';
import type { AuditEventRepository } from '@lnwjud/audit';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import { aggregateCallTimings } from './call-timing-aggregate.js';

export class CallHistoryService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly audit: Pick<AuditEventRepository, 'listCallHistory'>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async history(_actor: FileActor, query: CallHistoryQuery): Promise<Result<CallHistoryPage>> {
    if (!query.workspaceId || !await this.workspaces.get(query.workspaceId)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace is not registered'));
    }
    if ((query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200))
      || (query.since !== undefined && Number.isNaN(Date.parse(query.since)))
      || (query.until !== undefined && Number.isNaN(Date.parse(query.until)))
      || (query.since !== undefined && query.until !== undefined && query.since > query.until)
      || (query.toolName !== undefined && (query.toolName.length === 0 || query.toolName.length > 128))
      || (query.goalId !== undefined && (query.goalId.length === 0 || query.goalId.length > 128))) {
      return err(appError('INVALID_INPUT', 'Invalid call history filters'));
    }
    const sampledAt = this.now().toISOString();
    // This runtime has no trusted per-call transport identity or tunnel span,
    // so non-unknown transport queries must return "unknown", not fabricated zeros.
    if (query.transport !== undefined && query.transport !== 'unknown') {
      const items: CallTimingObservation[] = [];
      return ok({ items, nextCursor: null, sampledAt, coverage: 'unknown', truncated: false, totals: aggregateCallTimings(items) });
    }
    if (!this.audit.listCallHistory) return err(appError('INTERNAL_ERROR', 'Call history storage provider unavailable', true));
    try {
      const page = await this.audit.listCallHistory({
        workspaceId: query.workspaceId, limit: query.limit ?? 50,
        ...(query.goalId === undefined ? {} : { goalId: query.goalId }),
        ...(query.toolName === undefined ? {} : { toolName: query.toolName }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.until === undefined ? {} : { until: query.until }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      const items: CallTimingObservation[] = page.items.map((item) => ({
        correlationKey: item.eventId,
        toolName: item.toolName,
        workspaceId: item.workspaceId,
        goalId: item.goalId,
        transport: 'unknown',
        outcome: item.phase !== 'completed' ? 'incomplete'
          : item.resultCode === 'SUCCESS' ? 'success'
            : item.resultCode === 'CANCELLED' ? 'cancelled' : 'failure',
        serverMs: item.durationMs,
        tunnelObservedMs: null,
        completedAt: item.phase === 'completed' ? item.sampledAt : null,
      }));
      return ok({ items, nextCursor: page.nextCursor, sampledAt, coverage: 'partial',
        truncated: page.nextCursor !== null, totals: aggregateCallTimings(items) });
    } catch {
      return err(appError('INVALID_INPUT', 'Call history query or cursor is invalid'));
    }
  }
}
