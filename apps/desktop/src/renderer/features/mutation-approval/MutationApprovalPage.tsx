import { ActionButton } from '../ui/UiPrimitives.js';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MutationApprovalPrompt } from '@lnwjud/ipc-contracts';

export function MutationApprovalPage(): ReactElement {
  const [prompt, setPrompt] = useState<MutationApprovalPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const respond = useCallback(async (approved: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await window.lnwjud.resolveMutationApprovalPrompt({ approved });
      if (!result.accepted) window.close();
    } catch {
      window.close();
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getMutationApprovalPrompt().then((result) => {
      if (disposed) return;
      if (result === null) {
        window.close();
        return;
      }
      setPrompt(result);
    }).catch(() => {
      if (!disposed) window.close();
    });
    return (): void => { disposed = true; };
  }, []);

  useEffect(() => {
    if (prompt !== null) cancelButtonRef.current?.focus();
  }, [prompt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void respond(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => { window.removeEventListener('keydown', onKeyDown); };
  }, [respond]);

  return (
    <main className="mutation-approval-window" aria-busy={prompt === null}>
      {prompt === null ? (
        <div className="mutation-approval-loading" role="status">Loading approval details…</div>
      ) : (
        <section className="mutation-approval-card" role="alertdialog" aria-modal="true" aria-labelledby="mutation-approval-title" aria-describedby="mutation-approval-message">
          <header className="mutation-approval-header">
            <span className="mutation-approval-icon" aria-hidden="true">!</span>
            <h1 id="mutation-approval-title">{prompt.title}</h1>
          </header>
          <p id="mutation-approval-message" className="mutation-approval-message">{prompt.message}</p>
          <div className="mutation-approval-detail" tabIndex={0}>
            <pre dir="auto">{prompt.detail}</pre>
          </div>
          <footer className="mutation-approval-actions">
            <ActionButton ref={cancelButtonRef} type="button" disabled={busy} onClick={() => { void respond(false); }}>
              {prompt.buttons[0]}
            </ActionButton>
            <ActionButton className="mutation-approval-confirm" type="button" disabled={busy} onClick={() => { void respond(true); }}>
              {prompt.buttons[1]}
            </ActionButton>
          </footer>
        </section>
      )}
    </main>
  );
}
