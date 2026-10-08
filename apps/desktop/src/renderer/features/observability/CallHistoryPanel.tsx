import { useEffect, useState, type ReactElement } from 'react';
import type { CallHistoryPage, CallHistoryRequest, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';
export function CallHistoryPanel(props: { readonly workspaceId: string | null; readonly locale: UiLocale }): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [toolName, setToolName] = useState('');
  const [transport, setTransport] = useState<NonNullable<CallHistoryRequest['transport']> | ''>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<CallHistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = v580Strings(props.locale).calls;
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
      const result = await window.lnwjud.getCallHistory(query);
      setPage(result);
      setCursor(result.nextCursor);
    } catch(cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="diagnostics-calls">
    <p>{copy.intro}</p>
    <div className="diagnostics-filters">
      <label>{copy.goal} <input value={goalId} onChange={e => setGoalId(e.target.value)} maxLength={128}/></label>
      <label>{copy.tool} <input value={toolName} onChange={e=>setToolName(e.target.value)} maxLength={128}/></label>
      <label>{copy.transport}
        <select value={transport} onChange={e=>setTransport(e.target.value as typeof transport)}>
          <option value="">{copy.all}</option>
          <option value="unknown">{copy.unknown}</option>
          <option value="local_stdio">Local STDIO</option>
          <option value="loopback_http">Loopback HTTP</option>
          <option value="secure_tunnel">Secure Tunnel</option>
          <option value="external_mcp">External MCP</option>
        </select>
      </label>
      <button type="button" disabled={busy || props.workspaceId===null} onClick={()=>{void load();}}>
        {busy ? (copy.loading) : (copy.load)}
      </button>
    </div>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
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
      {cursor ? <button type="button" disabled={busy} onClick={()=>{void load(cursor);}}>{copy.next}</button> : null}
    </> : null}
  </section>;
}
