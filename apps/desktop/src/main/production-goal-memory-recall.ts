/** Production-only scoped Hindsight recall. No project selection from MCP caller input.
 * Every read requires one new native Host approval; it never falls back to Staging.
 */
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import type { HostProjectScope } from './production-goal-memory-core.js';

const PROD_BACKEND = 'http://127.0.0.1:8888';
const BANK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProductionRecallInput { readonly query: string; readonly limit: number }
export interface ProductionRecallOptions {
  readonly getSelectedScope: () => Promise<HostProjectScope | null>;
  readonly getAuthorizedBank: (workspaceId: string) => string | null | Promise<string | null>;
  readonly requestApproval: (request: HostMutationApprovalRequest) => boolean | Promise<boolean>;
  /** Pure test hook only; Production uses Node's fetch to fixed 127.0.0.1:8888. */
  readonly fetchImpl?: typeof fetch;
}

function identicalScope(left: HostProjectScope | null, right: HostProjectScope): boolean {
  return left !== null && left.workspaceId === right.workspaceId
    && left.realRootPath === right.realRootPath;
}
function safeText(value: unknown, maxLength = 1500): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/** A Host-owned, permission-gated service. No in-memory authorization reuse. */
export function createProductionGoalMemoryRecall(options: ProductionRecallOptions): {
  readonly recall: (input: ProductionRecallInput) => Promise<Result<unknown>>;
} {
  if (typeof options.getSelectedScope !== 'function' || typeof options.getAuthorizedBank !== 'function'
    || typeof options.requestApproval !== 'function') throw new Error('Trusted recall authority missing');
  const request = options.fetchImpl ?? fetch;
  return {
    async recall(input: ProductionRecallInput): Promise<Result<unknown>> {
      if (!input || typeof input.query !== 'string' || input.query.trim().length < 1
        || input.query.length > 400 || !Number.isInteger(input.limit)
        || input.limit < 1 || input.limit > 10) {
        return err(appError('INVALID_INPUT', 'Invalid scoped recall request'));
      }
      try {
        const scope = await options.getSelectedScope();
        if (scope === null || !UUID.test(scope.workspaceId) || !scope.realRootPath) {
          return err(appError('PERMISSION_DENIED', 'No trusted selected workspace'));
        }
        const bank = await options.getAuthorizedBank(scope.workspaceId);
        if (typeof bank !== 'string' || !BANK_ID.test(bank)) {
          return err(appError('PERMISSION_DENIED', 'No authorized Production bank for selected workspace'));
        }
        const approved = await options.requestApproval({
          toolName: 'project_memory_recall', mutationKind: 'read',
          workspaceId: scope.workspaceId, workspaceRoot: scope.realRootPath,
          reason: 'One scoped memory read from the existing Hindsight Production bank',
          summary: `bank=${bank}\nworkspace=${scope.workspaceId}\nread=1\nquery=${input.query.slice(0, 180)}`,
        });
        if (approved !== true) return err(appError('PERMISSION_DENIED', 'One-use native read consent denied'));
        const second = await options.getSelectedScope();
        if (!identicalScope(second, scope) || await options.getAuthorizedBank(scope.workspaceId) !== bank) {
          return err(appError('PERMISSION_DENIED', 'Workspace or bank changed after consent'));
        }
        const response = await request(`${PROD_BACKEND}/v1/default/banks/${bank}/memories/recall`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: input.query, budget: 'low', max_tokens: 2048 }),
        });
        if (!response.ok) return err(appError('INTERNAL_ERROR', 'Production recall backend unavailable'));
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null || !('results' in body)
          || !Array.isArray(body.results)) {
          return err(appError('INTERNAL_ERROR', 'Invalid Production recall response'));
        }
        const results = body.results.slice(0, input.limit).map((raw: unknown) => {
          const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
          return { id: safeText(item.id, 128), text: safeText(item.text, 2200),
            type: safeText(item.type, 64), context: safeText(item.context, 600) };
        });
        const last = await options.getSelectedScope();
        if (!identicalScope(last, scope) || await options.getAuthorizedBank(scope.workspaceId) !== bank) {
          return err(appError('PERMISSION_DENIED', 'Workspace or bank changed during recall'));
        }
        return ok({ workspaceId: scope.workspaceId, bankId: bank, results,
          resultCount: results.length, source: 'hindsight-production' });
      } catch {
        return err(appError('INTERNAL_ERROR', 'Production recall unavailable; no fallback used'));
      }
    },
  };
}
