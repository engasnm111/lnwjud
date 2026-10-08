import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import type { DashboardSnapshot, UiLocale, UpdateStatus } from '@lnwjud/ipc-contracts';
import { createTranslator, type Translator } from '../../i18n/index.js';
import type { MessageKey } from '../../i18n/messages.js';
import { WhatsNewModal } from '../release-notes/WhatsNewModal.js';

export type Screen = 'home' | 'projects' | 'tools' | 'git' | 'worklog' | 'live' | 'settings' | 'doctor' | 'workflows';

interface AppShellProps {
  readonly locale: UiLocale;
  readonly appVersion: string;
  readonly hostPlatform: DashboardSnapshot['hostPlatform'];
  readonly mcpRunning: boolean;
  readonly desktopFullBypassOn: boolean;
  readonly stdioFullBypassOn: boolean;
  readonly updateStatus: UpdateStatus | null;
  readonly screen: Screen;
  readonly onNavigate: (screen: Screen) => void;
  readonly onLocaleChange: (locale: UiLocale) => void;
  readonly onUpdateAction: () => void;
  readonly children: ReactNode;
}

const localeItems: ReadonlyArray<{ readonly locale: UiLocale; readonly key: MessageKey }> = [
  { locale: 'th', key: 'language.th' },
  { locale: 'en', key: 'language.en' },
];

const navItems: ReadonlyArray<{ readonly screen: Screen; readonly key: MessageKey }> = [
  { screen: 'home', key: 'nav.home' },
  { screen: 'projects', key: 'nav.projects' },
  { screen: 'workflows', key: 'nav.workflows' },
  { screen: 'tools', key: 'nav.tools' },
  { screen: 'git', key: 'nav.git' },
  { screen: 'worklog', key: 'nav.workLog' },
  { screen: 'live', key: 'nav.live' },
  { screen: 'settings', key: 'nav.settings' },
  { screen: 'doctor', key: 'nav.doctor' },
];

export function AppShell(props: AppShellProps): ReactElement {
  const t = createTranslator(props.locale);
  const platformLabel = desktopPlatformLabel();
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const closeWhatsNew = useCallback(() => setWhatsNewOpen(false), []);
  return (
    <div className="window-container" data-host-platform={props.hostPlatform}>
      {/* Modern Luxury Dark Gold Titlebar */}
      <header className="custom-titlebar">
        <div className="titlebar-drag-region">
          <div className="titlebar-brand">
            <img src="./favicon.ico" alt="lnwjud logo" className="titlebar-logo" />
            <span className="titlebar-title">{t('brand')}</span>
            <button
              type="button"
              className={`titlebar-version update-${props.updateStatus?.phase ?? 'idle'}`}
              onClick={props.onUpdateAction}
              title={props.updateStatus?.message ?? t('shell.checkUpdatesTitle')}
              aria-label={props.updateStatus?.canInstall === true
                ? t('shell.installUpdate', { version: props.updateStatus.availableVersion ?? '' })
                : t('shell.checkUpdates')}
              aria-busy={props.updateStatus?.phase === 'checking' || props.updateStatus?.phase === 'downloading'}
            >
              {versionBadgeText(props.appVersion, props.updateStatus, t)}
            </button>
            <button
              type="button"
              className="titlebar-whats-new"
              onClick={() => setWhatsNewOpen(true)}
              title={t('whatsNew.tooltip')}
              aria-label={t('whatsNew.tooltip')}
            >
              ?
            </button>
          </div>

          <div className="titlebar-center">
            <div className="titlebar-status-indicator">
              <span className={`titlebar-dot ${props.mcpRunning ? 'active' : ''}`}></span>
              <span>{props.mcpRunning ? t('shell.mcpActive') : t('shell.mcpReady')}</span>
              {props.desktopFullBypassOn ? <strong className="pill-badge danger" role="status">{t('userConfig.desktopBypassOn')}</strong> : null}
              {props.stdioFullBypassOn ? <strong className="pill-badge danger" role="status">{t('userConfig.stdioBypassOn')}</strong> : null}
            </div>
          </div>
        </div>

        <div className="titlebar-actions">
          <div className="locale-switch" role="group" aria-label={t('settings.locale')}>
            {localeItems.map((item) => (
              <button
                key={item.locale}
                type="button"
                className={props.locale === item.locale ? 'active' : undefined}
                onClick={() => props.onLocaleChange(item.locale)}
              >
                {t(item.key)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main App Body */}
      <div className="app-shell">
        <aside className="sidebar" aria-label={t('shell.navigation')}>
          <div className="sidebar-brand">
            <strong>{t('brand')}</strong>
            <span>v{props.appVersion}</span>
          </div>
          <nav className="sidebar-nav">
            {navItems.map((item) => (
              <button
                key={item.screen}
                type="button"
                className={props.screen === item.screen ? 'nav-item active' : 'nav-item'}
                onClick={() => props.onNavigate(item.screen)}
              >
                {t(item.key)}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span>Desktop Agent · {platformLabel}</span>
            <strong className={props.mcpRunning ? 'status-online' : 'status-offline'}>
              {props.mcpRunning ? t('footer.connected') : t('footer.disconnected')}
            </strong>
          </div>
        </aside>

        <div className="main-pane">
          <main className="main-content">{props.children}</main>
        </div>
      </div>
      {whatsNewOpen ? <WhatsNewModal locale={props.locale} version={props.appVersion} onClose={closeWhatsNew} /> : null}
    </div>
  );
}
function desktopPlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'Desktop';
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (platform.includes('win')) return 'Windows';
  if (platform.includes('mac')) return 'macOS';
  if (platform.includes('linux')) return 'Linux';
  return 'Desktop';
}

function versionBadgeText(appVersion: string, status: UpdateStatus | null, t: Translator): string {
  if (status === null) return `v${appVersion}`;
  const next = status.availableVersion;
  if (status.phase === 'ready' && next !== null) return t('shell.updateReady', { version: next });
  if (status.phase === 'installing' && next !== null) return t('shell.updateInstalling', { version: next });
  if (status.phase === 'downloading') {
    const percent = status.progressPercent === null ? '' : ` ${Math.round(status.progressPercent)}%`;
    return `v${appVersion} ↓${percent}`;
  }
  if (status.phase === 'available' && next !== null) return `v${appVersion} → v${next}`;
  if (status.phase === 'checking') return t('shell.updateChecking', { version: appVersion });
  if (status.phase === 'error') return `v${appVersion} • !`;
  return `v${appVersion}`;
}
