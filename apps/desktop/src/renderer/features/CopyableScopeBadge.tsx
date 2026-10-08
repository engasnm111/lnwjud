import { ActionButton } from './ui/UiPrimitives.js';
import { useState, type ReactElement } from 'react';
import { copyTextToClipboard } from '../clipboard.js';

type ScopeKind = 'workspace' | 'session';
type ScopeCopier = (value: string) => Promise<boolean>;

interface CopyableScopeBadgeProps {
  readonly kind: ScopeKind;
  readonly value: string;
  readonly displayLabel: string;
}

export async function copyCanonicalScopeId(value: string, copy: ScopeCopier = copyTextToClipboard): Promise<boolean> {
  return copy(value);
}

export function CopyableScopeBadge(props: CopyableScopeBadgeProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!(await copyCanonicalScopeId(props.value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  const label = props.kind === 'workspace' ? 'Workspace ID' : 'Session ID';
  return (
    <ActionButton
      type="button"
      className={`scope-badge ${props.kind} copyable`}
      title={props.value}
      aria-label={`Copy ${label}: ${props.value}`}
      onClick={() => { void copy(); }}
    >
      <span className="scope-badge-label">{props.displayLabel}</span>
      <span className="scope-badge-feedback" aria-live="polite">{copied ? '✓' : ''}</span>
    </ActionButton>
  );
}
