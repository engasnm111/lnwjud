import { ActionButton, Surface } from '../ui/UiPrimitives.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { UiLocale, WorkflowDraft, WorkflowTemplate, WorkflowTemplateId } from '@lnwjud/ipc-contracts';
import { WorkflowInputForm } from './WorkflowInputForm.js';
import { workflowLaunchPrompt } from './workflow-launch-prompt.js';
import { v580Strings, workflowLocalized } from '../../i18n/v580-copy.js';

function WorkflowCardIcon(props: { readonly id: WorkflowTemplateId }): ReactElement {
  const shapes: Record<WorkflowTemplateId, ReactElement> = {
    'project-check': <><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h4M8 12h8M8 16h5"/></>,
    'code-review': <><path d="M12 2 3 6v6c0 5.5 3.9 8.5 9 10 5.1-1.5 9-4.5 9-10V6z"/><path d="m8 12 3 3 5-6"/></>,
    'release-readiness': <><path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></>,
    'connection-check': <><path d="M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></>,
    'data-audit': <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 10v10"/></>,
    'template-report': <><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9 12h7M9 16h5"/></>,
  };
  return <span className="workflow-card-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" focusable="false">{shapes[props.id]}</svg>
  </span>;
}

export function WorkflowsPage(props: { readonly workspaceId: string | null; readonly workspacePath: string | null; readonly locale: UiLocale }): ReactElement {
  const [templates, setTemplates] = useState<readonly WorkflowTemplate[]>([]);
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageError, setMessageError] = useState(false);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const copy = v580Strings(props.locale).workflows;
  useEffect(() => {
    let live = true;
    setTemplates([]); setSelected(null); setDraft(null); setInputs({}); setMessage(null); setMessageError(false); setInvalidFields(new Set());
    setLoadingTemplates(props.workspaceId !== null);
    if (props.workspaceId !== null) {
      void window.lnwjud.listWorkflowTemplates({ workspaceId: props.workspaceId })
        .then((items) => { if (live) setTemplates(items); })
        .catch((error: unknown) => { if (live) { setMessage(error instanceof Error ? error.message : String(error)); setMessageError(true); } })
        .finally(() => { if (live) setLoadingTemplates(false); });
    }
    return (): void => { live = false; };
  }, [props.workspaceId]);
  function choose(template: WorkflowTemplate): void {
    setSelected(template);
    setDraft(null);
    setMessage(null);
    setInvalidFields(new Set());
    const initial: Record<string, string> = {};
    for (const field of template.inputFields) {
      if (field.type === 'enum' && field.options?.length) initial[field.key] = field.options[0]!;
      if ((field.key === 'projectPath' || field.key === 'repoPath') && props.workspacePath) initial[field.key] = props.workspacePath;
    }
    setInputs(initial);
  }
  async function prepare(): Promise<void> {
    if (!props.workspaceId || !selected || busy) return;
    const missing = selected.inputFields.filter((field) => field.required && !(inputs[field.key] ?? '').trim());
    if (missing.length > 0) {
      setInvalidFields(new Set(missing.map((field) => field.key)));
      const first = `workflow-${missing[0]!.key}`;
      requestAnimationFrame(() => {
        const control = document.getElementById(first);
        control?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        control?.focus();
      });
      return;
    }
    setInvalidFields(new Set());
    setBusy(true); setDraft(null); setMessage(null);
    try {
      const result = await window.lnwjud.prepareWorkflow({ workspaceId: props.workspaceId, templateId: selected.id, inputs });
      setDraft(result);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    } finally { setBusy(false); }
  }
  async function copyPrompt(): Promise<void> {
    if (!draft || !selected || draft.readiness !== 'ready') return;
    try {
      await navigator.clipboard.writeText(workflowLaunchPrompt(draft, selected));
      setMessage(copy.copied);
      setMessageError(false);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); setMessageError(true); }
  }
  return (
    <div className="page-content workflows-page">
      <h1>{copy.title}</h1>
      <p>{copy.intro}</p>
      {!props.workspaceId ? <p role="status">{copy.noWorkspace}</p> : null}
      {loadingTemplates ? <p className="ui-loading-status" role="status" aria-live="polite">{copy.loadingTemplates}…</p> : null}
      {props.workspaceId && !loadingTemplates && templates.length === 0 && !message ? <p role="status">{copy.noTemplates}</p> : null}
      <div className="workflow-cards" aria-busy={loadingTemplates}>
        {templates.map((template) => (
          <ActionButton type="button" key={template.id} className={selected?.id === template.id ? 'workflow-card selected' : 'workflow-card'} onClick={() => choose(template)}>
            <div className="workflow-card-heading">
              <WorkflowCardIcon id={template.id} />
              <strong>{workflowLocalized(props.locale,{th:template.titleTh,en:template.titleEn})}</strong>
            </div>
            <span>{workflowLocalized(props.locale,{th:template.descriptionTh,en:template.descriptionEn})}</span>
            <small>{template.readOnly ? (copy.readOnly) : (copy.output)}</small>
          </ActionButton>
        ))}
      </div>
      {selected ? (
        <Surface as="section" className="workflow-config" aria-label={copy.inputLabel}>
          <h2>{workflowLocalized(props.locale,{th:selected.titleTh,en:selected.titleEn})}</h2>
          <WorkflowInputForm template={selected} locale={props.locale} values={inputs} disabled={busy}
            invalidKeys={invalidFields}
            onChange={(values) => { setInputs(values); setDraft(null); setMessage(null);
              setInvalidFields((current) => new Set([...current].filter((key) => !(values[key] ?? '').trim())));
            }}/>
          <ActionButton type="button" className="workflow-primary-action" onClick={() => { void prepare(); }} disabled={busy || !props.workspaceId}>
            {busy ? (copy.working) : (copy.prepare)}
          </ActionButton>
        </Surface>
      ) : null}
      {busy ? <p role="status" className="ui-loading-status" aria-live="polite">{copy.working}…</p> : null}
      {draft ? (
        <Surface as="section" className="workflow-preview" aria-live="polite">
          <h2>{copy.preview}</h2>
          <p>{draft.readiness === 'ready' ? (copy.ready)
            : (copy.notReady)}</p>
          {draft.blockers.length ? <ul>{draft.blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
          <ol>{draft.steps.map((step) => <li key={step.id}>{step.title}</li>)}</ol>
          <p>{copy.acceptance}: {draft.acceptance.map((entry) => entry.title).join('; ')}</p>
          <ActionButton type="button" className="workflow-primary-action" disabled={draft.readiness !== 'ready'} onClick={() => { void copyPrompt(); }}>
            {copy.copy}
          </ActionButton>
        </Surface>
      ) : null}
      {message ? messageError ? <div role="alert" className="workflow-operation-error">
        <strong>{copy.operationFailed}</strong>
        <details><summary>{copy.technicalDetails}</summary><code>{message}</code></details>
      </div> : <p role="status">{message}</p> : null}
    </div>
  );
}
