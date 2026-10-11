import { ActionButton } from '../ui/UiPrimitives.js';
import { DiagnosticCopyButton } from '../ui/DiagnosticCopyButton.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { DoctorGoalOption, ResourceSnapshot, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';

type ResourceRow = ResourceSnapshot['resources'][number];

/** A Goal is selectable only when it has a real host measurement (zero is a valid measurement). */
export function measurableGoalIds(snapshot: ResourceSnapshot | null): ReadonlySet<string> {
  return new Set((snapshot?.resources ?? [])
    .filter((row) => row.goalId && (row.workingSetBytes !== undefined || row.cpuPercent !== undefined))
    .map((row) => row.goalId!));
}

export function trackedGoalIds(snapshot: ResourceSnapshot | null): ReadonlySet<string> {
  return new Set((snapshot?.resources ?? []).flatMap(row => row.goalId ? [row.goalId] : []));
}

export function ResourcePanel(props: { readonly locale: UiLocale; readonly workspaceId: string | null }): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [goals, setGoals] = useState<readonly DoctorGoalOption[]>([]);
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const copy = v580Strings(props.locale).resources;

  useEffect(() => {
    let active = true;
    setGoals([]); setGoalId(''); setSnapshot(null); setError(null);
    if (props.workspaceId) {
      setLoading(true);
      void Promise.all([
        window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId }),
        window.lnwjud.getResourceSnapshot({ workspaceId: props.workspaceId }),
      ]).then(([availableGoals, measured]) => {
        if (!active) return;
        setGoals(availableGoals); setSnapshot(measured);
      }).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { if (active) setLoading(false); });
    }
    return (): void => { active = false; };
  }, [props.workspaceId]);

  // Poll only while the Resources tab is mounted. Never reuse previous samples
  // as if they were new measurements, and stop polling on workspace switch.
  useEffect(() => {
    const workspaceId = props.workspaceId;
    if (!workspaceId) return;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void window.lnwjud.getResourceSnapshot({ workspaceId })
        .then((next) => { if (active) setSnapshot(next); })
        .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { inFlight = false; });
    }, 15_000);
    return (): void => { active = false; clearInterval(timer); };
  }, [props.workspaceId]);

  useEffect(() => {
    if (goalId && snapshot !== null && !trackedGoalIds(snapshot).has(goalId)) setGoalId('');
  }, [goalId, snapshot]);

  const eligibleIds = trackedGoalIds(snapshot);
  const eligibleGoals = goals.filter((goal) => eligibleIds.has(goal.goalId));
  const selectedGoal = eligibleGoals.find((goal) => goal.goalId === goalId);
  const visibleRows = (snapshot?.resources ?? []).filter((row) => !goalId || row.goalId === goalId);
  const measuredRows = visibleRows.filter((row) => row.workingSetBytes !== undefined || row.cpuPercent !== undefined);
  const memoryTotal = visibleRows.reduce((total, row) => total + (row.workingSetBytes ?? 0), 0);
  const contextMeasured = snapshot ? Object.values(snapshot.context).some((value) => value !== null) : false;

  async function load(): Promise<void> {
    if (!props.workspaceId || loading) return;
    setLoading(true); setError(null);
    try {
      const [availableGoals, result] = await Promise.all([
        window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId }),
        window.lnwjud.getResourceSnapshot({ workspaceId: props.workspaceId }),
      ]);
      setGoals(availableGoals);
      setSnapshot(result);
      if (goalId && !trackedGoalIds(result).has(goalId)) setGoalId('');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }

  async function cancelOwned(row: ResourceRow): Promise<void> {
    if (!props.workspaceId || !row.goalId || !row.taskId || cancelling !== null || !row.canCancel
      || !snapshot?.resources.some((current) => current.goalId === row.goalId
        && current.taskId === row.taskId && current.provider === row.provider && current.canCancel)) return;
    setCancelling(row.taskId); setError(null);
    try {
      const outcome = await window.lnwjud.cancelOwnedGoalTask({
        workspaceId: props.workspaceId, goalId: row.goalId, taskId: row.taskId,
        provider: row.provider as 'process' | 'codex' | 'shell', userConfirmed: true,
      });
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Provider could not verify cancellation');
      setSnapshot(await window.lnwjud.getResourceSnapshot({ workspaceId: props.workspaceId }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setCancelling(null); }
  }

  function measured(value: number | undefined | null, unit: string): string {
    return value === undefined || value === null ? '—' : value.toLocaleString(copy.dateLocale) + ' ' + unit;
  }
  const memory = (value: number | undefined): string =>
    value === undefined ? '—' : (value / 1_048_576).toLocaleString(copy.dateLocale, { maximumFractionDigits: 1 }) + ' MiB';

  return <section className="diagnostics-resources">
    <p>{copy.intro}</p>
    <div className="diagnostics-resources-toolbar">
      {eligibleGoals.length > 0 ? <div className="diagnostics-resources-filter">
        <label>{copy.goal}</label>
        <SearchableSelect label={copy.goal} value={goalId}
          onChange={setGoalId} options={[{ value: '', label: copy.all },
            ...eligibleGoals.map((goal) => ({ value: goal.goalId,
              label: `${goal.goalKey} · ${goal.objective || goal.status} (${goal.goalId.slice(0, 8)})` }))]} />
      </div> : <p className="hint">{loading ? copy.loading : copy.noMeasuredGoals}</p>}
      <div className="diagnostics-inline-actions">
        <ActionButton type="button" disabled={!props.workspaceId || loading} onClick={() => { void load(); }}>
          {loading ? copy.loading : copy.refresh}
        </ActionButton>
        {snapshot ? <DiagnosticCopyButton key={snapshot.sampledAt + goalId}
          details={{...snapshot,resources:visibleRows,selectedGoalId:goalId || null}}
          label={copy.copyAll} copiedLabel={copy.copied} errorLabel={copy.copyError} onError={setError} /> : null}
      </div>
    </div>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {selectedGoal ? <div className="diagnostics-selected-goal">
      <strong>{selectedGoal.goalKey}</strong><span>{selectedGoal.objective}</span>
      <small>{copy.goalStatus}: {selectedGoal.status}</small>
    </div> : null}
    {snapshot ? <div aria-live="polite" className="diagnostics-resources-output">
      <p>{copy.sampled} {new Date(snapshot.sampledAt).toLocaleString(copy.dateLocale)} · {copy.coverage}: {snapshot.coverage} · {snapshot.stale ? copy.stale : copy.sample}</p>
      {snapshot.desktopMain ? <div className="diagnostics-context-counters">
        <strong>{copy.desktopMain}</strong>
        <dl className="diagnostics-resource-summary">
          <div><dt>{copy.memory}</dt><dd>{memory(snapshot.desktopMain.rssBytes)}</dd></div>
          <div><dt>{copy.cpuAverage}</dt><dd>{measured(snapshot.desktopMain.cpuAveragePercent, '%')}</dd></div>
        </dl>
        <p className="hint">{copy.desktopMainNote}</p>
      </div> : null}
      <dl className="diagnostics-resource-summary">
        <div><dt>{copy.measuredTasks}</dt><dd>{measuredRows.length.toLocaleString(copy.dateLocale)}</dd></div>
        <div><dt>{copy.trackedTasks}</dt><dd>{visibleRows.length.toLocaleString(copy.dateLocale)}</dd></div>
        <div><dt>{copy.memory}</dt><dd>{memory(visibleRows.some((row) => row.workingSetBytes !== undefined) ? memoryTotal : undefined)}</dd></div>
        <div><dt>{copy.ownedTasks}</dt><dd>{visibleRows.filter((row) => row.ownership === 'owned').length.toLocaleString(copy.dateLocale)}</dd></div>
      </dl>
      {contextMeasured ? <div className="diagnostics-context-counters">
        <p className="hint">{snapshot.contextScope === 'transport' ? copy.contextTransport : copy.contextWorkspace}</p>
        <dl className="diagnostics-resource-summary">
          <div><dt>{copy.contextSent}</dt><dd>{measured(snapshot.context.contextSentBytes, 'bytes')}</dd></div>
          <div><dt>{copy.contextAvoided}</dt><dd>{measured(snapshot.context.previouslySeenBytesAvoided, 'bytes')}</dd></div>
          <div><dt>{copy.ledger}</dt><dd>{measured(snapshot.context.ledgerHits, 'hits')}</dd></div>
        </dl>
      </div> : <p className="hint">{copy.noCounters}</p>}
      {visibleRows.length === 0 ? <p className="hint">{copy.noTrackedForGoal}</p> :
        <div className="diagnostics-history-scroll"><table className="diagnostics-data-table"><thead><tr>
          <th>{copy.task}</th><th>{copy.provider}</th><th>{copy.owner}</th>
          <th>{copy.memory}</th><th>{copy.cpuAverage}</th><th>{copy.action}</th><th>{copy.details}</th>
        </tr></thead><tbody>{visibleRows.map((row, i) => <tr key={`${row.goalId}-${row.provider}-${row.taskId ?? i}`}>
          <td className="diagnostics-identifier" title={row.taskId ?? ''}>{row.taskId ?? '—'}</td>
          <td>{row.provider}</td>
          <td><span className={`diagnostics-status diagnostics-status--${row.ownership === 'owned' ? 'success' : 'neutral'}`}>
            {row.ownership === 'owned' ? copy.ownerVerified : row.ownership === 'shared' ? copy.ownerShared : copy.ownerUnknown}
          </span></td>
          <td className="diagnostics-number">{memory(row.workingSetBytes)}</td>
          <td className="diagnostics-number">{measured(row.cpuPercent, '%')}</td>
          <td>{row.canCancel && row.goalId && row.taskId && ['process','codex','shell'].includes(row.provider)
            ? <ActionButton type="button" disabled={cancelling !== null} onClick={() => { void cancelOwned(row); }}>
                {cancelling === row.taskId ? copy.cancelling : copy.cancel}
              </ActionButton>
            : <span className="diagnostics-muted" title={copy.cancelUnavailable}>{copy.cancelUnavailable}</span>}</td>
          <td><DiagnosticCopyButton details={{...row, sampledAt:snapshot.sampledAt, workspaceId:snapshot.workspaceId}}
            label={copy.copyDetails} copiedLabel={copy.copied} errorLabel={copy.copyError} onError={setError} /></td>
        </tr>)}</tbody></table></div>}
      <p className="hint">{copy.cpuAverageNote}</p>
      <p className="hint">{copy.note}</p>
    </div> : null}
  </section>;
}
