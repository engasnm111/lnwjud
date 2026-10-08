import type { ReactElement } from 'react';
import type { UiLocale, WorkflowTemplate } from '@lnwjud/ipc-contracts';
import { v580Strings, workflowLocalized } from '../../i18n/v580-copy.js';
export function WorkflowInputForm(props: {
  readonly template: WorkflowTemplate;
  readonly locale: UiLocale;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Record<string, string>) => void;
  readonly disabled: boolean;
}): ReactElement {
  const copy = v580Strings(props.locale).workflows;
  return (
    <div className="workflow-input-fields">
      {props.template.inputFields.map((field) => (
        <label className="workflow-field" key={field.key}>
          <span>{workflowLocalized(props.locale,{th:field.labelTh,en:field.labelEn})}{field.required ? ' *' : ''}</span>
          {field.type === 'enum' ? (
            <select disabled={props.disabled} value={props.values[field.key] ?? ''} onChange={(event) => props.onChange({ ...props.values, [field.key]: event.target.value })}>
              <option value="">{copy.select}</option>
              {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input
              type="text"
              disabled={props.disabled}
              autoComplete="off"
              value={props.values[field.key] ?? ''}
              onChange={(event) => props.onChange({ ...props.values, [field.key]: event.target.value })}
              placeholder={field.type === 'path' || field.type === 'mapping_file'
                ? copy.path
                : field.key}
            />
          )}
        </label>
      ))}
    </div>
  );
}
