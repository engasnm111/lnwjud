export function transitionLogFeedFreeze<T>(snapshot: T | null, current: T, freeze: boolean): T | null {
  return freeze ? snapshot ?? current : null;
}

export function activeLogFeed<T>(snapshot: T | null, current: T): T {
  return snapshot ?? current;
}

export interface DetailSearchState {
  readonly generation: number;
  readonly query: string;
  readonly status: 'idle' | 'loading' | 'complete' | 'error';
  readonly matchingIds: ReadonlySet<string>;
}

export type DetailSearchAction =
  | { readonly type: 'reset'; readonly generation: number }
  | { readonly type: 'start'; readonly generation: number; readonly query: string }
  | { readonly type: 'success'; readonly generation: number; readonly query: string; readonly matchingIds: readonly string[] }
  | { readonly type: 'failure'; readonly generation: number; readonly query: string };

const noMatches: ReadonlySet<string> = new Set();

export function createDetailSearchState(): DetailSearchState {
  return { generation: 0, query: '', status: 'idle', matchingIds: noMatches };
}

export function reduceDetailSearchState(state: DetailSearchState, action: DetailSearchAction): DetailSearchState {
  if (action.type === 'reset') {
    return action.generation < state.generation
      ? state
      : { generation: action.generation, query: '', status: 'idle', matchingIds: noMatches };
  }
  const query = normalizeDetailSearchQuery(action.query);
  if (action.type === 'start') {
    return action.generation < state.generation
      ? state
      : { generation: action.generation, query, status: 'loading', matchingIds: noMatches };
  }
  if (action.generation !== state.generation || query !== state.query) return state;
  if (action.type === 'failure') return { ...state, status: 'error', matchingIds: noMatches };
  return { ...state, status: 'complete', matchingIds: new Set(action.matchingIds) };
}

export function activeDetailMatchIds(state: DetailSearchState, query: string): ReadonlySet<string> {
  const normalized = normalizeDetailSearchQuery(query);
  return state.status === 'complete' && normalized.length > 0 && state.query === normalized
    ? state.matchingIds
    : noMatches;
}

export function normalizeDetailSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}
