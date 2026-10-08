import { ActionButton } from '../ui/UiPrimitives.js';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
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
  const tabId = useId();
  const words = v580Strings(props.locale).doctor;
  const items: readonly { id: Tab; label: string }[] = [
    { id:'checks', label: words.checks }, { id:'calls', label: words.calls },
    { id:'results', label: words.results }, { id:'resources', label: words.resources },
  ];
  return <div className="page-content diagnostics-page">
    <h1>Doctor</h1>
    <p className="page-subtitle">{words.title}</p>
    <div className="diagnostics-tabs" role="tablist" aria-label={words.views} aria-orientation="horizontal"
      onKeyDown={(event) => {
        const current = items.findIndex((item) => item.id === tab);
        const next = event.key === 'ArrowRight' ? (current + 1) % items.length
          : event.key === 'ArrowLeft' ? (current + items.length - 1) % items.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        const nextId = items[next]!.id;
        setTab(nextId);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${nextId}"]`)?.focus();
      }}>
      {items.map(item=><ActionButton type="button" role="tab" key={item.id}
        id={`${tabId}-${item.id}`} data-tab={item.id} aria-controls={`${tabId}-panel`}
        tabIndex={tab === item.id ? 0 : -1}
        aria-selected={tab===item.id} onClick={()=>setTab(item.id)}>
        {item.label}
      </ActionButton>)}
    </div>
    <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
      {tab==='checks'?props.checks:null}
      {tab==='calls'?<CallHistoryPanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
      {tab==='results'?<GoalResultsPanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
      {tab==='resources'?<ResourcePanel workspaceId={props.workspaceId} locale={props.locale}/>:null}
    </div>
  </div>;
}
