import { ActionButton, FormInput, FormField } from '../ui/UiPrimitives.js';
import { useState, type ReactElement } from 'react';
import type { UiLocale, WorkflowTemplate } from '@lnwjud/ipc-contracts';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { v580Strings, workflowLocalized } from '../../i18n/v580-copy.js';

export function WorkflowInputForm(props: {
  readonly template: WorkflowTemplate;
  readonly locale: UiLocale;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Record<string, string>) => void;
  readonly disabled: boolean;
  readonly invalidKeys?: ReadonlySet<string>;
}): ReactElement {
  const copy = v580Strings(props.locale).workflows;
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browseLabel = copy.browse;
  async function browse(key: string): Promise<void> {
    if (browsing !== null) return;
    setBrowsing(key);
    setError(null);
    try {
      const result = await window.lnwjud.chooseWorkflowDataFile();
      if (result.filePath !== null) props.onChange({ ...props.values, [key]: result.filePath });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowsing(null);
    }
  }
  return (
    <div className="workflow-input-fields">
      {props.template.inputFields.map((field) => {
        const label = workflowLocalized(props.locale,{ th:field.labelTh, en:field.labelEn });
        const isFile = field.key === 'inputPath' || field.key === 'templatePath' || field.key === 'mappingPath';
        const invalid = props.invalidKeys?.has(field.key) ?? false;
        const errorId = `workflow-${field.key}-error`;
        return <FormField id={`workflow-${field.key}`} label={label} required={field.required} className="workflow-field" key={field.key}>
          {field.type === 'enum' ? (
            <SearchableSelect id={`workflow-${field.key}`} value={props.values[field.key] ?? ''} disabled={props.disabled}
              label={label} placeholder={copy.select} invalid={invalid} describedBy={invalid ? errorId : undefined}
              options={[{ value:'', label:copy.select }, ...(field.options ?? []).map((value) => ({ value, label:value }))]}
              onChange={(value) => props.onChange({ ...props.values, [field.key]:value })}/>
          ) : (
            <div className="workflow-field-control">
              <FormInput id={`workflow-${field.key}`} type="text" disabled={props.disabled} autoComplete="off"
                aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
                value={props.values[field.key] ?? ''}
                onChange={(event) => props.onChange({ ...props.values, [field.key]: event.target.value })}
                placeholder={field.type === 'path' || field.type === 'mapping_file' ? copy.path : field.key} />
              {isFile ? <ActionButton type="button" className="ui-browse-button" disabled={props.disabled || browsing !== null}
                onClick={() => { void browse(field.key); }}>{browsing === field.key ? '…' : browseLabel}</ActionButton> : null}
            </div>
          )}
          {invalid ? <p id={errorId} className="field-validation-message" role="alert">{copy.required}</p> : null}
        </FormField>;
      })}
      {error ? <p role="alert" className="workflow-field-error">{error}</p> : null}
    </div>
  );
}
