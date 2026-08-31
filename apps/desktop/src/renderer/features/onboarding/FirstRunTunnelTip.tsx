import { useEffect, useRef, type ReactElement } from 'react';
import type { PermissionProfileName, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface FirstRunTunnelTipProps {
  readonly locale: UiLocale;
  readonly permissionProfile: PermissionProfileName;
  readonly onPermissionProfileChange: (profile: PermissionProfileName) => void;
  readonly onStart: () => void;
  readonly onLater: () => void;
}

export function FirstRunTunnelTip(props: FirstRunTunnelTipProps): ReactElement {
  const t = createTranslator(props.locale);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const onLaterRef = useRef(props.onLater);
  onLaterRef.current = props.onLater;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onLaterRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    startButtonRef.current?.focus();
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

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
          <label className="setting-field" htmlFor="first-run-permission-profile">
            <span className="field-label">{props.locale === 'th' ? 'สิทธิ์ที่ AI ใช้กับ Desktop / Secure Tunnel' : 'AI permissions for Desktop / Secure Tunnel'}</span>
            <select
              id="first-run-permission-profile"
              className="settings-select"
              value={props.permissionProfile}
              onChange={(event) => props.onPermissionProfileChange(event.target.value as PermissionProfileName)}
            >
              <option value="safe">Safe</option>
              <option value="balanced">Balanced</option>
              <option value="full">Full</option>
              <option value="custom">Custom</option>
            </select>
            <span className="hint">{props.locale === 'th'
              ? 'ค่าเริ่มต้น Balanced เหมาะกับการใช้งานครั้งแรก; Full ยังไม่เปิด Full Bypass จนกว่าคุณจะยืนยันแยกใน Settings'
              : 'Balanced is the first-run default. Full does not enable Full Bypass unless you separately acknowledge it in Settings.'}</span>
          </label>
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
