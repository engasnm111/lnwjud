import type { CallToolResult } from '@modelcontextprotocol/server';

export interface RunBudgetContext {
  readonly sessionId?: string;
  readonly http?: { readonly req?: Request };
  readonly mcpReq?: {
    readonly id?: string | number;
  };
}

/**
 * Compatibility boundary for the former elapsed-time budget behavior.
 *
 * A run is outcome-driven: wall-clock time must never rewrite a successful
 * tool result or inject handoff/background instructions. The class remains in
 * the dispatch path so that this invariant has direct regression coverage.
 */
export class RunBudgetGuard {
  public begin(context: RunBudgetContext | undefined): void {
    void context;
    // Intentionally no elapsed-time state.
  }

  public finish(context: RunBudgetContext | undefined, result: CallToolResult): CallToolResult {
    void context;
    return result;
  }
}
