import { useState, type ReactElement } from 'react';
import { copyTextToClipboard } from '../../clipboard.js';
import { ActionButton } from './UiPrimitives.js';

export function DiagnosticCopyButton(props: {
  readonly details: unknown;
  readonly label: string;
  readonly copiedLabel: string;
  readonly errorLabel: string;
  readonly onError?: (message: string) => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      if (!await copyTextToClipboard(JSON.stringify(props.details, null, 2))) throw new Error(props.errorLabel);
      setCopied(true);
    } catch (cause: unknown) {
      setCopied(false);
      props.onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return <ActionButton type="button" className="diagnostics-copy-action" onClick={() => { void copy(); }}>
    {copied ? props.copiedLabel : props.label}
  </ActionButton>;
}
