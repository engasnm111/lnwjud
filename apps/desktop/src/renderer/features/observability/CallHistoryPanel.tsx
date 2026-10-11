import { ActionButton, FilterBar } from '../ui/UiPrimitives.js';
import { DiagnosticCopyButton } from '../ui/DiagnosticCopyButton.js';
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
  const goalNames = useMemo(() => new Map(goals.map((goal) => [goal.goalId, goal.goalKey] as const)), [goals]);
  const toolTitles = useMemo(() => new Map(tools.map((tool) => [tool.name, tool.title] as const)), [tools]);
  const toolOptions = useMemo(() => [
    { value: '', label: copy.all },
    ...[...new Map(tools.map((tool) => [tool.name, tool] as const)).values()]
      .map((tool) => ({ value: tool.name, label: `${tool.title} · ${tool.name}` })),
  ], [tools, copy.all]);
  useEffect(() => {
    let live = true;
    setGoalId(''); setToolName(''); setGoals([]); setTools([]);
    if (props.workspaceId) {
      void window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId, view: 'calls' })
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
      <div className="diagnostics-section-header">
        <div className="diagnostics-metrics">
          <div><span>{copy.completed}</span><strong>{page.totals.completedCount}</strong></div>
          <div><span>{copy.incomplete}</span><strong>{page.totals.incompleteCount}</strong></div>
          <div><span>Server p50 / p95</span><strong>{page.totals.serverP50Ms ?? '—'} / {page.totals.serverP95Ms ?? '—'} ms</strong></div>
          <div><span>{copy.coverage}</span><strong>{page.coverage}{page.truncated ? ' · '+copy.truncated : ''}</strong></div>
        </div>
        <DiagnosticCopyButton details={{...page, filters:{workspaceId:props.workspaceId,goalId,toolName,transport}}}
          label={copy.copyAll} copiedLabel={copy.copied} errorLabel={copy.copyError} onError={setError} />
      </div>
      {page.items.length === 0 ? <div className="diagnostics-history-empty" role="status">
        <strong>{copy.noItems}</strong>
        <p>{copy.noTelemetryReason}</p>
        {(goalId || toolName || transport) ? <ActionButton type="button" onClick={() => {
          setGoalId(''); setToolName(''); setTransport(''); setPage(null); setCursor(null);
        }}>{copy.clearFilters}</ActionButton> : null}
        <p className="hint">{copy.liveLogsNote}</p>
      </div> : <div className="diagnostics-history-scroll"><table className="diagnostics-data-table">
        <thead><tr><th>{copy.at}</th><th>{copy.tool}</th><th>{copy.outcome}</th><th>Server ms</th><th>Tunnel ms</th><th>{copy.goal}</th><th>{copy.details}</th></tr></thead>
        <tbody>{page.items.map(item=><tr key={item.correlationKey}>
          <td className="diagnostics-date">{item.completedAt ? new Date(item.completedAt).toLocaleString(copy.dateLocale) : '—'}</td>
          <td className="diagnostics-tool" title={item.toolName}>{toolTitles.get(item.toolName) ?? item.toolName}<small>{item.toolName}</small></td>
          <td><span className={`diagnostics-status diagnostics-status--${item.outcome === 'success' ? 'success' : item.outcome === 'failure' ? 'error' : 'neutral'}`}>{item.outcome}</span></td>
          <td className="diagnostics-number">{item.serverMs ?? '—'}</td>
          <td className="diagnostics-number">{item.tunnelObservedMs ?? '—'}</td>
          <td title={item.goalId ?? ''}>{item.goalId ? goalNames.get(item.goalId) ?? item.goalId.slice(0, 8) : copy.unattributed}</td>
          <td><DiagnosticCopyButton details={item} label={copy.copyDetails} copiedLabel={copy.copied} errorLabel={copy.copyError} onError={setError} /></td>
        </tr>)}</tbody>
      </table></div>}
      {cursor ? <ActionButton type="button" disabled={busy} onClick={()=>{void load(cursor);}}>{copy.next}</ActionButton> : null}
    </> : null}
  </section>;
}
