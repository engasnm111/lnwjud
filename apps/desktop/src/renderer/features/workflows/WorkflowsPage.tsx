import { ActionButton, Surface } from '../ui/UiPrimitives.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { UiLocale, WorkflowDraft, WorkflowTemplate } from '@lnwjud/ipc-contracts';
import { WorkflowInputForm } from './WorkflowInputForm.js';
import { workflowLaunchPrompt } from './workflow-launch-prompt.js';
import { v580Strings, workflowLocalized } from '../../i18n/v580-copy.js';

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
            <strong>{workflowLocalized(props.locale,{th:template.titleTh,en:template.titleEn})}</strong>
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
