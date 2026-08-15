import { useState, type ReactElement } from 'react';
import type { DashboardSnapshot, PermissionProfileName, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface SettingsPageProps {
  readonly locale: UiLocale;
  readonly dashboard: DashboardSnapshot;
  readonly onLocaleChange: (locale: UiLocale) => Promise<void>;
  readonly onPermissionProfileChange: (profile: PermissionProfileName) => Promise<void>;
  readonly onUnrestrictedChange: (enabled: boolean) => Promise<boolean>;
  readonly onSaveTunnelApiKey: (apiKey: string) => Promise<void>;
  readonly onSetTunnelClientPath: (clientPath: string) => Promise<void>;
}

export function SettingsPage(props: SettingsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [apiKey, setApiKey] = useState('');
  const [clientPath, setClientPath] = useState(props.dashboard.tunnel.clientPath ?? '');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [unrestrictedMessage, setUnrestrictedMessage] = useState<string | null>(null);

  return (
    <div className="page-content">
      <h1>{t('settings.title')}</h1>
      <section className="panel">
        <label className="field-label" htmlFor="locale-select">{t('settings.locale')}</label>
        <select
          id="locale-select"
          value={props.locale}
          onChange={(event) => { void props.onLocaleChange(event.target.value as UiLocale); }}
        >
          <option value="th">{t('language.th')}</option>
          <option value="en">{t('language.en')}</option>
        </select>
      </section>
      <section className="panel">
        <label className="field-label" htmlFor="permission-profile">{t('settings.permissions')}</label>
        <select
          id="permission-profile"
          aria-label="Permission profile"
          value={props.dashboard.permissionProfile}
          onChange={(event) => { void props.onPermissionProfileChange(event.target.value as PermissionProfileName); }}
        >
          <option value="safe">Safe</option>
          <option value="balanced">Balanced</option>
          <option value="full">Full</option>
          <option value="custom">Custom</option>
        </select>
        <p data-testid="permission-profile">{props.dashboard.permissionProfile}</p>
      </section>
      <section className="panel">
        <label className="field-label" htmlFor="unrestricted-mode">{t('settings.unrestricted')}</label>
        <div className="form-row">
          <input
            id="unrestricted-mode"
            type="checkbox"
            checked={props.dashboard.unrestricted}
            onChange={(event) => {
              void props.onUnrestrictedChange(event.target.checked).then((restartRequired) => {
                setUnrestrictedMessage(restartRequired ? t('settings.restartRequired') : null);
              });
            }}
          />
          <span data-testid="unrestricted-state">{props.dashboard.unrestricted ? 'ON' : 'OFF'}</span>
        </div>
        <p className="hint">{t('settings.unrestrictedHint')}</p>
        {unrestrictedMessage === null ? null : <p className="hint" role="status">{unrestrictedMessage}</p>}
      </section>
      <section className="panel">
        <label className="field-label" htmlFor="tunnel-key">{t('settings.tunnelKey')}</label>
        <div className="form-row">
          <input
            id="tunnel-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => {
              void props.onSaveTunnelApiKey(apiKey).then(() => {
                setApiKey('');
                setSavedMessage('OK');
              });
            }}
          >
            {t('settings.saveKey')}
          </button>
        </div>
        <p className="hint">
          {props.dashboard.tunnel.hasApiKey ? '••••••••' : t('tunnel.needKey')}
        </p>
        <label className="field-label" htmlFor="tunnel-client-path">{t('settings.clientPath')}</label>
        <div className="form-row">
          <input
            id="tunnel-client-path"
            value={clientPath}
            onChange={(event) => setClientPath(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              void props.onSetTunnelClientPath(clientPath).then(() => setSavedMessage('OK'));
            }}
          >
            {t('settings.savePath')}
          </button>
        </div>
        {savedMessage === null ? null : <p role="status">{savedMessage}</p>}
      </section>
    </div>
  );
}
