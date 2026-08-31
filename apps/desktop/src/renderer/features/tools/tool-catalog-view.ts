import type { ToolCatalogItem, ToolCategory, ToolDeclaredPermission, ToolOrigin, ToolProfileDecision, ToolReadinessStatus } from '@lnwjud/ipc-contracts';

export interface ToolCatalogFilters {
  readonly origin: ToolOrigin;
  readonly query: string;
  readonly readiness: ToolReadinessStatus | 'all';
  readonly category: ToolCategory | 'all';
  readonly permission: ToolDeclaredPermission | 'all';
  readonly profileDecision: ToolProfileDecision | 'all';
}

const STATUS_RANK: Readonly<Record<ToolReadinessStatus, number>> = {
  blocked: 0,
  needs_setup: 1,
  unknown: 2,
  unsupported: 3,
  disabled: 4,
  ready: 5,
};

export function filterAndSortTools(items: readonly ToolCatalogItem[], filters: ToolCatalogFilters): readonly ToolCatalogItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items
    .filter((item) => item.origin === filters.origin)
    .filter((item) => filters.readiness === 'all' || item.readiness === filters.readiness)
    .filter((item) => filters.category === 'all' || item.category === filters.category)
    .filter((item) => filters.permission === 'all' || item.declaredPermission === filters.permission)
    .filter((item) => filters.profileDecision === 'all' || item.profileDecision === filters.profileDecision)
    .filter((item) => query.length === 0 || [item.name, item.title, item.shortDescription, item.longDescription, ...item.searchText]
      .some((value) => value.toLocaleLowerCase().includes(query)))
    .sort((left, right) => STATUS_RANK[left.readiness] - STATUS_RANK[right.readiness] || left.title.localeCompare(right.title));
}

export function catalogStatusCounts(items: readonly ToolCatalogItem[]): Readonly<Record<ToolReadinessStatus, number>> {
  const counts: Record<ToolReadinessStatus, number> = { ready: 0, needs_setup: 0, blocked: 0, disabled: 0, unsupported: 0, unknown: 0 };
  for (const item of items) counts[item.readiness] += 1;
  return counts;
}
