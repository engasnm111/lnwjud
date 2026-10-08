import { ActionButton, FilterBar } from '../ui/UiPrimitives.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DoctorGoalOption, TaskResultSummary, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';

/** On demand: only inspect an explicitly selected Goal, never infer success from status. */
export function GoalResultsPanel(props: {
  readonly workspaceId: string | null;
  readonly locale: UiLocale;
}): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [goals, setGoals] = useState<readonly DoctorGoalOption[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [result, setResult] = useState<TaskResultSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const copy = v580Strings(props.locale).results;
  const selectedGoal = goals.find((goal) => goal.goalId === goalId);
  const options = useMemo(() => [
    { value: '', label: copy.selectGoalPrompt },
    ...goals.map((goal) => ({ value: goal.goalId,
      label: `${goal.goalKey} · ${goal.objective || goal.status} (${goal.goalId.slice(0, 8)})` })),
  ], [goals, copy.selectGoalPrompt]);

  useEffect(() => {
    let active = true;
    requestId.current += 1;
    setGoalId(''); setGoals([]); setResult(null); setError(null);
    setGoalsLoading(Boolean(props.workspaceId));
    if (!props.workspaceId) return (): void => { active = false; };
    void window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId, view: 'results' })
      .then((items): void => { if (active) setGoals(items); })
      .catch((cause: unknown): void => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally((): void => { if (active) setGoalsLoading(false); });
    return (): void => { active = false; };
  }, [props.workspaceId]);

  useEffect(() => {
    requestId.current += 1;
    setResult(null); setError(null); setBusy(false);
  }, [props.workspaceId, goalId]);

  async function load(): Promise<void> {
    if (!props.workspaceId || !goalId || busy) return;
    const request = ++requestId.current;
    setBusy(true); setError(null);
    try {
      const received = await window.lnwjud.getTaskResult({ workspaceId: props.workspaceId, goalId });
      if (request === requestId.current) setResult(received);
    } catch (cause: unknown) {
      if (request === requestId.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestId.current) setBusy(false);
    }
  }
  const verified = result?.artifacts.filter((file) => file.verification === 'verified').length ?? 0;
  const failed = result?.artifacts.filter((file) => file.verification === 'failed').length ?? 0;
  const checked = result?.checks.filter((check) => check.status === 'passed').length ?? 0;
  const failingChecks = result?.checks.filter((check) => check.status === 'failed' || check.status === 'blocked').length ?? 0;

  return <section className="diagnostics-goal-results">
    <p>{copy.intro}</p>
    <FilterBar className="diagnostics-filters diagnostics-result-filters">
      <div className="diagnostics-filter-field">
        <span>{copy.selectGoal}</span>
        <SearchableSelect label={copy.searchGoal}
          value={goalId} options={options} onChange={setGoalId}
          disabled={!props.workspaceId || goalsLoading || goals.length === 0}
          placeholder={goalsLoading ? copy.loadingGoals : copy.chooseGoal} />
      </div>
      <ActionButton type="button" disabled={!props.workspaceId || !goalId || busy} onClick={() => { void load(); }}>
        {busy ? copy.loading : copy.inspect}
      </ActionButton>
    </FilterBar>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
    {goalsLoading ? <p role="status" className="ui-loading-status">{copy.loading}…</p> : null}
    {props.workspaceId && !goalsLoading && goals.length === 0
      ? <p role="status">{copy.noGoals}</p> : null}
    {error ? <p role="alert" className="workflow-field-error">{error}</p> : null}
    {selectedGoal ? <div className="diagnostics-selected-goal">
      <strong>{selectedGoal.goalKey}</strong>
      <span>{selectedGoal.objective}</span>
      <small>{copy.updated}: {new Date(selectedGoal.updatedAt).toLocaleString(copy.dateLocale)}</small>
    </div> : null}
    {goalId && !result && !busy && !error ? <p role="status" className="hint">
      {copy.inspectHint}
    </p> : null}
    {busy ? <p role="status" className="ui-loading-status">{copy.loading}…</p> : null}
    {result ? <div className="diagnostics-result-detail" aria-live="polite">
      <div className="diagnostics-evidence-summary">
        <div><small>{copy.status}</small><strong>{result.status}</strong></div>
        <div><small>{copy.coverage}</small><strong>{result.evidenceCoverage}</strong></div>
        <div><small>{copy.revision}</small><strong>{result.goalRevision}</strong></div>
        <div><small>{copy.verifiedFiles}</small><strong>{verified} / {result.artifacts.length}</strong></div>
        <div><small>{copy.passedChecks}</small><strong>{checked} / {result.checks.length}</strong></div>
      </div>
      <p className="hint">{copy.notCert}</p>
      {failed > 0 || failingChecks > 0 ? <p role="alert" className="workflow-field-error">
        {copy.failingVerification}
      </p> : null}
      {result.progress ? <div className="diagnostics-result-section">
        <h3>{copy.progressTitle}</h3>
        <dl className="diagnostics-progress-overview">
          <dt>{copy.phase}</dt><dd>{result.progress.currentPhase || copy.unknown}</dd>
          <dt>{copy.updated}</dt><dd>{result.progress.updatedAt
            ? new Date(result.progress.updatedAt).toLocaleString(copy.dateLocale) : '-'}</dd>
          <dt>{copy.nextAction}</dt><dd>{result.progress.nextAction || '-'}</dd>
          <dt>{copy.checkpointSummary}</dt>
          <dd>{result.progress.lastCheckpointSummary || copy.noSummary}</dd>
          {result.progress.terminalSummary ? <>
            <dt>{copy.terminalSummary}</dt>
            <dd>{result.progress.terminalSummary}</dd>
          </> : null}
        </dl>
        {result.progress.steps.length ? <ul className="diagnostics-result-checks">
          {result.progress.steps.map((step) => <li key={step.id}>
            <span><strong>{step.title}</strong>{step.summary ? <small>{step.summary}</small> : null}</span>
            <span className="diagnostics-step-status">{step.status}</span>
          </li>)}
        </ul> : <p className="hint">{copy.noPlanSteps}</p>}
      </div> : null}
      <div className="diagnostics-result-section">
        <h3>{copy.artifacts} ({result.artifacts.length})</h3>
        {result.artifacts.length === 0 ? <p className="hint">{copy.noArtifacts}</p>
          : <div className="diagnostics-history-scroll"><table><thead><tr>
            <th>{copy.file}</th><th>{copy.kind}</th><th>{copy.verification}</th><th>SHA-256</th>
          </tr></thead><tbody>{result.artifacts.map((item,i) => <tr key={item.path+i}>
            <td>{item.path}</td><td>{item.kind}</td><td>{item.verification}</td>
            <td><code title={item.sha256 ?? ''}>{item.sha256 ?? 'unknown'}</code></td>
          </tr>)}</tbody></table></div>}
      </div>
      <div className="diagnostics-result-section">
        <h3>{copy.changes} ({result.observedChanges.length})</h3>
        {result.observedChanges.length === 0 ? <p className="hint">{copy.noChanges}</p>
          : <div className="diagnostics-history-scroll"><table><thead><tr>
            <th>{copy.at}</th><th>{copy.action}</th><th>{copy.path}</th>
          </tr></thead><tbody>{result.observedChanges.map((item) => <tr key={item.operationId}>
            <td>{new Date(item.observedAt).toLocaleString(copy.dateLocale)}</td>
            <td>{item.action}</td><td>{item.path}</td>
          </tr>)}</tbody></table></div>}
      </div>
      <div className="diagnostics-result-section">
        <h3>{copy.checks} ({result.checks.length})</h3>
        {result.checks.length === 0 ? <p className="hint">
          {copy.noChecks}
        </p> : <ul className="diagnostics-result-checks">{result.checks.map((item,i) =>
          <li key={item.name+i}><span>{item.name}</span><strong>{item.status}</strong></li>)}</ul>}
      </div>
      <div className="diagnostics-result-section">
        <h3>{copy.blockersTitle} ({result.blockers.length})</h3>
        {result.blockers.length ? <ul>{result.blockers.map((item,i) => <li key={i}>{item}</li>)}</ul>
          : <p className="hint">{copy.noBlockers}</p>}
        <p className="hint">{copy.checkpoint}: {result.lastCheckpointId ?? copy.unavailable}</p>
      </div>
    </div> : null}
  </section>;
}
