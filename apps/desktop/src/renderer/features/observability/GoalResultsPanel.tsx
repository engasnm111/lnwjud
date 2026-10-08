import { useEffect, useState, type ReactElement } from 'react';
import type { TaskResultSummary, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';

/** On-demand only: never loads historical Goal results while the view is hidden. */
export function GoalResultsPanel(props: {
  readonly workspaceId: string | null;
  readonly locale: UiLocale;
}): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [result, setResult] = useState<TaskResultSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = v580Strings(props.locale).results;
  useEffect(() => { setResult(null); setError(null); }, [props.workspaceId, goalId]);
  async function load(): Promise<void> {
    if (!props.workspaceId || !goalId.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await window.lnwjud.getTaskResult({ workspaceId: props.workspaceId, goalId: goalId.trim() }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <section className="diagnostics-goal-results">
    <p>{copy.intro}</p>
    <div className="diagnostics-filters">
      <label>Goal ID <input value={goalId} maxLength={128} onChange={e => setGoalId(e.target.value)}/></label>
      <button type="button" disabled={!props.workspaceId || !goalId.trim() || busy} onClick={() => { void load(); }}>
        {busy ? (copy.loading) : (copy.inspect)}
      </button>
    </div>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <div aria-live="polite">
      <p>Goal: {result.goalId} · {copy.status}: {result.status} · {copy.coverage}: {result.evidenceCoverage}</p>
      <p>{copy.revision}: {result.goalRevision} · {copy.checkpoint}: {result.lastCheckpointId ?? 'unknown'}</p>
      <h3>{copy.artifacts} ({result.artifacts.length})</h3>
      {result.artifacts.length === 0 ? <p>{copy.noArtifacts}</p> :
        <div className="diagnostics-history-scroll"><table><thead><tr><th>{copy.file}</th><th>{copy.kind}</th><th>{copy.verification}</th><th>SHA-256</th></tr></thead><tbody>
          {result.artifacts.map((item, i) => <tr key={item.path + i}><td>{item.path}</td><td>{item.kind}</td><td>{item.verification}</td><td><code>{item.sha256 ?? 'unknown'}</code></td></tr>)}
        </tbody></table></div>}
      <h3>{copy.changes} ({result.observedChanges.length})</h3>
      {result.observedChanges.length === 0 ? <p>{copy.noChanges}</p> :
        <div className="diagnostics-history-scroll"><table><thead><tr><th>{copy.at}</th><th>{copy.action}</th><th>{copy.path}</th></tr></thead><tbody>
          {result.observedChanges.map(item => <tr key={item.operationId}><td>{item.observedAt}</td><td>{item.action}</td><td>{item.path}</td></tr>)}
        </tbody></table></div>}
      <h3>{copy.checks} ({result.checks.length})</h3>
      {result.checks.map((item,i)=><p key={item.name+i}>{item.name}: {item.status}</p>)}
      {result.blockers.map((item,i)=><p key={i} role="status">{item}</p>)}
    </div> : null}
  </section>;
}
