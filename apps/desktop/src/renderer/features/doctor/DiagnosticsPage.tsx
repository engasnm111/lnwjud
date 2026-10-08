import { ActionButton } from '../ui/UiPrimitives.js';
import { useState, type ReactElement, type ReactNode } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';
import { v580Strings } from '../../i18n/v580-copy.js';
import { CallHistoryPanel } from '../observability/CallHistoryPanel.js';
import { GoalResultsPanel } from '../observability/GoalResultsPanel.js';
import { ResourcePanel } from '../resources/ResourcePanel.js';

type Tab = 'checks' | 'calls' | 'results' | 'resources';
export function DiagnosticsPage(props: {
  readonly locale: UiLocale;
  readonly workspaceId: string | null;
  readonly checks: ReactNode;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('checks');
  const words = v580Strings(props.locale).doctor;
  const items: readonly { id: Tab; label: string }[] = [
    { id:'checks', label: words.checks }, { id:'calls', label: words.calls },
    { id:'results', label: words.results }, { id:'resources', label: words.resources },
  ];
  return <div className="page-content diagnostics-page">
    <h1>Doctor</h1>
    <p className="page-subtitle">{words.title}</p>
    <div className="diagnostics-tabs" role="tablist" aria-label={words.views}>
      {items.map(item=><ActionButton type="button" role="tab" key={item.id}
        aria-selected={tab===item.id} onClick={()=>setTab(item.id)}>
        {item.label}
      </ActionButton>)}
    </div>
    <div role="tabpanel">
      {tab==='checks'?props.checks:null}
      {tab==='calls'?<CallHistoryPanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
      {tab==='results'?<GoalResultsPanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
      {tab==='resources'?<ResourcePanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
    </div>
  </div>;
}
