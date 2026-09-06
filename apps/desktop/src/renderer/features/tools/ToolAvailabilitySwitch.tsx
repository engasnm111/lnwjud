import type { ReactElement } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';

interface ToolAvailabilitySwitchProps {
  readonly locale: UiLocale;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

export function ToolAvailabilitySwitch({ locale, checked, disabled = false, busy = false, label, onChange }: ToolAvailabilitySwitchProps): ReactElement {
  const stateLabel = checked ? (locale === 'th' ? 'เปิด' : 'Enabled') : (locale === 'th' ? 'ปิด' : 'Disabled');
  const accessibleLabel = locale === 'th' ? `${label}: ${stateLabel}` : `${label}: ${stateLabel}`;

  return (
    <button
      type="button"
      className={`tool-availability-switch ${checked ? 'is-on' : 'is-off'}${busy ? ' is-busy' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={accessibleLabel}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="tool-availability-switch-state">{stateLabel}</span>
      <span className="tool-availability-switch-track" aria-hidden="true">
        <span className="tool-availability-switch-thumb" />
      </span>
    </button>
  );
}
