import { ActionButton } from '../ui/UiPrimitives.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { DoctorGoalOption, ResourceSnapshot, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';

export function ResourcePanel(props: { readonly locale: UiLocale; readonly workspaceId: string | null }): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [goals, setGoals] = useState<readonly DoctorGoalOption[]>([]);
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const copy = v580Strings(props.locale).resources;
  const selectedGoal = goals.find((goal) => goal.goalId === goalId);
  const contextMeasured = snapshot ? Object.values(snapshot.context).some((value) => value !== null) : false;
  useEffect(() => {
    let active = true;
    setGoals([]); setGoalId(''); setSnapshot(null); setError(null);
    if (props.workspaceId) void window.lnwjud.getDoctorGoals({ workspaceId: props.workspaceId })
      .then((items) => { if (active) setGoals(items); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return (): void => { active = false; };
  }, [props.workspaceId]);
  useEffect(() => { setSnapshot(null); }, [goalId]);
  async function load():Promise<void>{
    if(!props.workspaceId || loading)return;
    setLoading(true);setError(null);
    try{
      const result=await window.lnwjud.getResourceSnapshot({
        workspaceId:props.workspaceId,
        ...(goalId.trim()?{goalId:goalId.trim()}:{}),
      });
      setSnapshot(result);
    }catch(cause:unknown){setError(cause instanceof Error?cause.message:String(cause))}
    finally{setLoading(false)}
  }
  async function cancelOwned(taskId:string,provider:string):Promise<void>{
    if (!props.workspaceId || !goalId.trim() || cancelling !== null || !snapshot?.resources.some(
      row => row.taskId === taskId && row.provider === provider && row.canCancel,
    )) return;
    setCancelling(taskId); setError(null);
    try {
      const outcome = await window.lnwjud.cancelOwnedGoalTask({
        workspaceId:props.workspaceId, goalId:goalId.trim(), taskId,
        provider: provider as 'process'|'codex'|'shell', userConfirmed:true,
      });
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Provider could not verify cancellation');
      setSnapshot(null);
    } catch (cause:unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCancelling(null); }
  }
  function measured(value:number|undefined|null,unit:string):string{
    return value===undefined||value===null?'unknown':value.toLocaleString()+' '+unit;
  }
  return <section className="diagnostics-resources">
    <p>{copy.intro}</p>
    <div className="diagnostics-resources-filter">
      <label>{copy.goal}</label>
      <SearchableSelect label={copy.goal} value={goalId} onChange={setGoalId}
        options={[{ value: '', label: copy.all }, ...goals.map((goal) => ({ value: goal.goalId,
          label: `${goal.goalKey} · ${goal.objective || goal.status} (${goal.goalId.slice(0, 8)})` }))]} />
    </div>
    <ActionButton type="button" disabled={!props.workspaceId || loading} onClick={()=>{void load()}}>{loading?(copy.loading):(copy.refresh)}</ActionButton>
    {loading ? <p role="status" aria-live="polite" className="ui-loading-status">{copy.loading}…</p> : null}
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p>:null}
    {error?<p role="alert">{error}</p>:null}
    {selectedGoal ? <div className="diagnostics-selected-goal">
      <strong>{selectedGoal.goalKey}</strong><span>{selectedGoal.objective}</span>
      <small>{copy.goalStatus}: {selectedGoal.status}</small>
    </div> : <p className="hint">{copy.selectGoalNote}</p>}
    {snapshot?<div aria-live="polite">
      <p>{copy.sampled} {new Date(snapshot.sampledAt).toLocaleString(copy.dateLocale)} · {copy.coverage}: {snapshot.coverage} · {snapshot.stale?(copy.stale):(copy.sample)}</p>
      <p role="status">{copy.attributedTasks}: {snapshot.resources.length} · {copy.ownedTasks}: {snapshot.resources.filter(row => row.ownership === 'owned').length}</p>
      {contextMeasured ? <dl>
        <dt>{copy.contextSent}</dt><dd>{measured(snapshot.context.contextSentBytes,'bytes')}</dd>
        <dt>{copy.contextAvoided}</dt><dd>{measured(snapshot.context.previouslySeenBytesAvoided,'bytes')}</dd>
        <dt>{copy.ledger}</dt><dd>{measured(snapshot.context.ledgerHits,'hits')}</dd>
      </dl> : <p className="hint">{copy.noCounters}</p>}
      {snapshot.resources.length===0?<p className="hint">{goalId
        ? copy.noTrackedForGoal
        : copy.selectToInspect}</p>:
        <table><thead><tr><th>{copy.task}</th><th>{copy.provider}</th><th>{copy.owner}</th><th>{copy.memory}</th><th>{copy.cpu}</th><th>{copy.action}</th></tr></thead>
          <tbody>{snapshot.resources.map((row,i)=><tr key={row.taskId??i}>
            <td>{row.taskId??'-'}</td><td>{row.provider}</td><td>{row.ownership}</td>
            <td>{measured(row.workingSetBytes,'bytes')}</td><td>{measured(row.cpuPercent,'%')}</td>
            <td>{row.canCancel && row.taskId && ['process','codex','shell'].includes(row.provider)
              ? <ActionButton type="button" disabled={cancelling !== null} onClick={()=>{void cancelOwned(row.taskId!,row.provider)}}>
                {cancelling === row.taskId ? (copy.cancelling):(copy.cancel)}
              </ActionButton> : '—'}</td>
          </tr>)}</tbody>
        </table>}
      <p className="hint">{copy.unknownNote}</p>
      <p>{copy.note}</p>
    </div>:null}
  </section>
}
