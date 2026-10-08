import { ActionButton } from '../ui/UiPrimitives.js';
import type { ReactElement } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface ToolAvailabilitySwitchProps {
  readonly locale: UiLocale;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly blockedLabel?: string | undefined;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

export function ToolAvailabilitySwitch({ locale, checked, disabled = false, busy = false, blockedLabel, label, onChange }: ToolAvailabilitySwitchProps): ReactElement {
  const t = createTranslator(locale);
  const stateLabel = checked ? t('security.enabled') : blockedLabel ?? t('security.disabled');
  const accessibleLabel = `${label}: ${stateLabel}`;

  return (
    <ActionButton
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
    </ActionButton>
  );
}
