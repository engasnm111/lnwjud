import { ActionButton, FilterBar } from '../ui/UiPrimitives.js';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { CallHistoryPage, CallHistoryRequest, DoctorGoalOption, ToolCatalogItem, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
export function CallHistoryPanel(props: { readonly workspaceId: string | null; readonly locale: UiLocale }): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [goals, setGoals] = useState<readonly DoctorGoalOption[]>([]);
  const [tools, setTools] = useState<readonly ToolCatalogItem[]>([]);
  const [toolName, setToolName] = useState('');
  const [transport, setTransport] = useState<NonNullable<CallHistoryRequest['transport']> | ''>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<CallHistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = v580Strings(props.locale).calls;
  const goalOptions = useMemo(() => [
    { value: '', label: copy.all },
    ...goals.map((goal) => ({ value: goal.goalId,
      label: `${goal.goalKey} · ${goal.objective || goal.status} (${goal.goalId.slice(0, 8)})` })),
  ], [goals, copy.all]);
  const toolOptions = useMemo(() => [
    { value: '', label: copy.all },
    ...[...new Map(tools.map((tool) => [tool.name, tool] as const)).values()]
      .map((tool) => ({ value: tool.name, label: `${tool.title} · ${tool.name}` })),
  ], [tools, copy.all]);
  useEffect(() => {
    let live = true;
    setGoalId(''); setToolName(''); setGoals([]); setTools([]);
    if (props.workspaceId) {
      void window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId })
        .then((items) => { if (live) setGoals(items); })
        .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
      void window.lnwjud.getToolCatalog({ locale: props.locale })
        .then((catalog) => { if (live) setTools(catalog.items.slice().sort((a, b) => a.title.localeCompare(b.title))); })
        .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return (): void => { live = false; };
  }, [props.workspaceId, props.locale]);
  useEffect(() => { setPage(null); setCursor(null); setError(null); }, [props.workspaceId, goalId, toolName, transport]);
  async function load(nextCursor?: string): Promise<void> {
    if (!props.workspaceId || busy) return;
    setBusy(true);setError(null);
    try {
      const query: CallHistoryRequest = {
        workspaceId: props.workspaceId, limit: 50,
        ...(goalId.trim() ? { goalId: goalId.trim() } : {}),
        ...(toolName.trim() ? { toolName: toolName.trim() } : {}),
        ...(transport ? { transport } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      };
      // Paint the loading state before a potentially expensive audit query reaches the main process.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = await window.lnwjud.getCallHistory(query);
      setPage(result);
      setCursor(result.nextCursor);
    } catch(cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="diagnostics-calls">
    <p>{copy.intro}</p>
    <FilterBar className="diagnostics-filters" aria-busy={busy}>
      <div className="diagnostics-filter-field"><span>{copy.goal}</span>
        <SearchableSelect label={copy.goal} value={goalId} options={goalOptions} onChange={setGoalId} />
      </div>
      <div className="diagnostics-filter-field"><span>{copy.tool}</span>
        <SearchableSelect label={copy.tool} value={toolName} options={toolOptions} onChange={setToolName} />
      </div>
      <div className="diagnostics-filter-field"><span>{copy.transport}</span>
        <SearchableSelect label={copy.transport} value={transport} onChange={value => setTransport(value as typeof transport)}
          options={[{value:'',label:copy.all},{value:'unknown',label:copy.unknown},{value:'local_stdio',label:'Local STDIO'},
            {value:'loopback_http',label:'Loopback HTTP'},{value:'secure_tunnel',label:'Secure Tunnel'},
            {value:'external_mcp',label:'External MCP'}]} />
      </div>
      <ActionButton type="button" disabled={busy || props.workspaceId===null} onClick={()=>{void load();}}>
        {busy ? (copy.loading) : (copy.load)}
      </ActionButton>
    </FilterBar>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
    {busy ? <p role="status" aria-live="polite" className="ui-loading-status">{copy.loading}…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {page ? <>
      <p role="status">{copy.coverage}: {page.coverage}. {copy.truncated}: {String(page.truncated)}</p>
      <p>{copy.completed}: {page.totals.completedCount}. {copy.incomplete}: {page.totals.incompleteCount}.
      Server p50/p95: {page.totals.serverP50Ms ?? 'unknown'} / {page.totals.serverP95Ms ?? 'unknown'} ms
      ({page.totals.serverSampleCount} samples).</p>
      {page.items.length === 0 ? <p>{copy.noItems}</p> : <div className="diagnostics-history-scroll"><table>
        <thead><tr><th>{copy.at}</th><th>Tool</th><th>{copy.outcome}</th><th>Server ms</th><th>Tunnel ms</th><th>Goal</th></tr></thead>
        <tbody>{page.items.map(item=><tr key={item.correlationKey}>
          <td>{item.completedAt ?? '-'}</td><td>{item.toolName}</td><td>{item.outcome}</td>
          <td>{item.serverMs ?? '-'}</td><td>{item.tunnelObservedMs ?? '-'}</td><td>{item.goalId ?? '-'}</td>
        </tr>)}</tbody>
      </table></div>}
      {cursor ? <ActionButton type="button" disabled={busy} onClick={()=>{void load(cursor);}}>{copy.next}</ActionButton> : null}
    </> : null}
  </section>;
}
