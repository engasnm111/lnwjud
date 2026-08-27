import { useEffect, useRef, type ReactElement } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface FirstRunTunnelTipProps {
  readonly locale: UiLocale;
  readonly onStart: () => void;
  readonly onLater: () => void;
}

export function FirstRunTunnelTip(props: FirstRunTunnelTipProps): ReactElement {
  const t = createTranslator(props.locale);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onLater();
    };
    window.addEventListener('keydown', onKeyDown);
    startButtonRef.current?.focus();
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [props.onLater]);

  return (
    <div className="guided-tunnel-backdrop" role="presentation">
      <section
        className="guided-tunnel-tip"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tunnel-tip-title"
      >
        <div className="guided-tunnel-tip-icon" aria-hidden="true">↗</div>
        <div className="guided-tunnel-tip-copy">
          <span className="settings-eyebrow">SECURE MCP TUNNEL</span>
          <h2 id="guided-tunnel-tip-title">{t('guidedTunnel.tipTitle')}</h2>
          <p>{t('guidedTunnel.tipBody')}</p>
          <div className="guided-tunnel-privacy" role="note">🔒 {t('guidedTunnel.privacy')}</div>
        </div>
        <div className="guided-tunnel-tip-actions">
          <button type="button" className="btn-save-gold" ref={startButtonRef} onClick={props.onStart}>
            {t('guidedTunnel.startSetup')}
          </button>
          <button type="button" onClick={props.onLater}>{t('guidedTunnel.later')}</button>
        </div>
      </section>
    </div>
  );
}
