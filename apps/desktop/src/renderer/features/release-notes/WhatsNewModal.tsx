import { ActionButton } from '../ui/UiPrimitives.js';
import { useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { releaseNotesForSeries } from './release-notes.js';

interface WhatsNewModalProps {
  readonly locale: UiLocale;
  readonly version: string;
  readonly onClose: () => void;
}

const badgeKeys = {
  new: 'whatsNew.badge.new',
  improved: 'whatsNew.badge.improved',
  fixed: 'whatsNew.badge.fixed',
} as const;

export function WhatsNewModal({ locale, version, onClose }: WhatsNewModalProps): ReactElement {
  const t = createTranslator(locale);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        titleRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === titleRef.current || !(active instanceof Node) || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === titleRef.current || !(active instanceof Node) || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  const notes = releaseNotesForSeries(version);
  const modal = (
    <div className="tool-modal-backdrop whats-new-backdrop" role="presentation" onMouseDown={(event): void => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="tool-modal whats-new-modal" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <header className="tool-modal-header">
          <div className="tool-modal-title-copy">
            <p className="eyebrow">{t('whatsNew.eyebrow')}</p>
            <h2 ref={titleRef} tabIndex={-1} id="whats-new-title">{t('whatsNew.title', { version })}</h2>
          </div>
          <ActionButton className="tool-modal-close" type="button" onClick={onClose} aria-label={t('whatsNew.close')}>×</ActionButton>
        </header>
        <div className="tool-modal-scroll whats-new-scroll">
          {notes.length === 0 ? (
            <section className="whats-new-empty" role="status">
              <h3>{t('whatsNew.emptyTitle')}</h3>
              <p>{t('whatsNew.emptyBody', { version })}</p>
            </section>
          ) : notes.map((note) => (
            <section className="whats-new-version" key={note.version} aria-label={`v${note.version}`}>
              <h3 className="whats-new-version-title">v{note.version}</h3>
              {note.categories.filter((category) => category.items.length > 0).map((category) => (
                <section className="whats-new-category" key={category.id}>
                  <h4>{t(category.titleKey)}</h4>
                  <div className="whats-new-items">
                    {category.items.map((item) => (
                      <article className="whats-new-item" key={item.id}>
                        <div className="whats-new-item-heading">
                          <strong>{t(item.titleKey)}</strong>
                          {item.badge === undefined ? null : <span className={`whats-new-badge ${item.badge}`}>{t(badgeKeys[item.badge])}</span>}
                        </div>
                        <p>{t(item.descriptionKey)}</p>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </section>
          ))}
        </div>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
