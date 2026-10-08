import { ActionButton } from '../ui/UiPrimitives.js';
import type { ReactElement } from 'react';

interface SettingSwitchProps {
  readonly checked: boolean;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}

export function SettingSwitch({ checked, label, description, disabled = false, onChange }: SettingSwitchProps): ReactElement {
  return (
    <ActionButton
      type="button"
      className={`setting-switch ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="setting-switch-copy">
        <strong>{label}</strong>
        {description === undefined ? null : <small>{description}</small>}
      </span>
      <span className="setting-switch-track" aria-hidden="true">
        <span className="setting-switch-thumb" />
      </span>
    </ActionButton>
  );
}
