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
}): ReactElement {
  const copy = v580Strings(props.locale).workflows;
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browseLabel = props.locale === 'th' ? 'เลือกไฟล์…' : 'Browse…';
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
        return <div className="workflow-field" key={field.key}>
          <label htmlFor={`workflow-${field.key}`}>{label}{field.required ? ' *' : ''}</label>
          {field.type === 'enum' ? (
            <SearchableSelect value={props.values[field.key] ?? ''} disabled={props.disabled}
              label={label} placeholder={copy.select}
              options={[{ value:'', label:copy.select }, ...(field.options ?? []).map((value) => ({ value, label:value }))]}
              onChange={(value) => props.onChange({ ...props.values, [field.key]:value })}/>
          ) : (
            <div className="workflow-field-control">
              <input id={`workflow-${field.key}`} type="text" disabled={props.disabled} autoComplete="off"
                value={props.values[field.key] ?? ''}
                onChange={(event) => props.onChange({ ...props.values, [field.key]: event.target.value })}
                placeholder={field.type === 'path' || field.type === 'mapping_file' ? copy.path : field.key} />
              {isFile ? <button type="button" className="ui-browse-button" disabled={props.disabled || browsing !== null}
                onClick={() => { void browse(field.key); }}>{browsing === field.key ? '…' : browseLabel}</button> : null}
            </div>
          )}
        </div>;
      })}
      {error ? <p role="alert" className="workflow-field-error">{error}</p> : null}
    </div>
  );
}
