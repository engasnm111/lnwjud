import { useEffect, useState, type ReactElement } from 'react';
import type { ResourceSnapshot, UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';

export function ResourcePanel(props: { readonly locale: UiLocale; readonly workspaceId: string | null }): ReactElement {
  const [goalId, setGoalId] = useState('');
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const copy = v580Strings(props.locale).resources;
  useEffect(()=>{setSnapshot(null);setError(null)},[props.workspaceId,goalId]);
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
    <label>{copy.goal} <input maxLength={128} value={goalId} onChange={e=>setGoalId(e.target.value)}/></label>
    <button type="button" disabled={!props.workspaceId || loading} onClick={()=>{void load()}}>{loading?(copy.loading):(copy.refresh)}</button>
    {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p>:null}
    {error?<p role="alert">{error}</p>:null}
    {snapshot?<div aria-live="polite">
      <p>{copy.sampled} {snapshot.sampledAt}. Coverage {snapshot.coverage}. {snapshot.stale?(copy.stale):(copy.sample)}.</p>
      <dl>
        <dt>{copy.contextSent}</dt><dd>{measured(snapshot.context.contextSentBytes,'bytes')}</dd>
        <dt>{copy.contextAvoided}</dt><dd>{measured(snapshot.context.previouslySeenBytesAvoided,'bytes')}</dd>
        <dt>{copy.ledger}</dt><dd>{measured(snapshot.context.ledgerHits,'hits')}</dd>
      </dl>
      {snapshot.resources.length===0?<p>{copy.noItems}</p>:
        <table><thead><tr><th>{copy.task}</th><th>{copy.provider}</th><th>{copy.owner}</th><th>Working set</th><th>CPU</th><th>{copy.action}</th></tr></thead>
          <tbody>{snapshot.resources.map((row,i)=><tr key={row.taskId??i}>
            <td>{row.taskId??'-'}</td><td>{row.provider}</td><td>{row.ownership}</td>
            <td>{measured(row.workingSetBytes,'bytes')}</td><td>{measured(row.cpuPercent,'%')}</td>
            <td>{row.canCancel && row.taskId && ['process','codex','shell'].includes(row.provider)
              ? <button type="button" disabled={cancelling !== null} onClick={()=>{void cancelOwned(row.taskId!,row.provider)}}>
                {cancelling === row.taskId ? (copy.cancelling):(copy.cancel)}
              </button> : '—'}</td>
          </tr>)}</tbody>
        </table>}
      <p>{copy.note}</p>
    </div>:null}
  </section>
}
