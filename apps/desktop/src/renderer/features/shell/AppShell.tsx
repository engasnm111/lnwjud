import type { ReactElement, ReactNode } from 'react';
import type { UiLocale, UpdateStatus } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import type { MessageKey } from '../../i18n/messages.js';

export type Screen = 'home' | 'projects' | 'tools' | 'git' | 'worklog' | 'live' | 'settings' | 'doctor';

interface AppShellProps {
  readonly locale: UiLocale;
  readonly appVersion: string;
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

const navItems: ReadonlyArray<{ readonly screen: Screen; readonly key: MessageKey }> = [
  { screen: 'home', key: 'nav.home' },
  { screen: 'projects', key: 'nav.projects' },
  { screen: 'tools', key: 'nav.tools' },
  { screen: 'git', key: 'nav.git' },
  { screen: 'worklog', key: 'nav.workLog' },
  { screen: 'live', key: 'nav.live' },
  { screen: 'settings', key: 'nav.settings' },
  { screen: 'doctor', key: 'nav.doctor' },
];

export function AppShell(props: AppShellProps): ReactElement {
  const t = createTranslator(props.locale);
  return (
    <div className="window-container">
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
              title={props.updateStatus?.message ?? (props.locale === 'th' ? 'กดเพื่อตรวจอัปเดต' : 'Check for updates')}
              aria-label={props.updateStatus?.canInstall === true
                ? (props.locale === 'th' ? `ติดตั้งอัปเดต ${props.updateStatus.availableVersion ?? ''}` : `Install update ${props.updateStatus.availableVersion ?? ''}`)
                : (props.locale === 'th' ? 'ตรวจอัปเดต' : 'Check for updates')}
              aria-busy={props.updateStatus?.phase === 'checking' || props.updateStatus?.phase === 'downloading'}
            >
              {versionBadgeText(props.appVersion, props.updateStatus, props.locale)}
            </button>
          </div>

          <div className="titlebar-center">
            <div className="titlebar-status-indicator">
              <span className={`titlebar-dot ${props.mcpRunning ? 'active' : ''}`}></span>
              <span>{props.mcpRunning ? (props.locale === 'th' ? 'MCP Gateway ออนไลน์' : 'MCP Gateway Active') : (props.locale === 'th' ? 'MCP พร้อมทำงาน' : 'MCP Ready')}</span>
              {props.desktopFullBypassOn ? <strong className="pill-badge danger" role="status">DESKTOP FULL BYPASS ON</strong> : null}
              {props.stdioFullBypassOn ? <strong className="pill-badge danger" role="status">STDIO FULL BYPASS ON</strong> : null}
            </div>
          </div>
        </div>

        <div className="titlebar-actions">
          <div className="locale-switch" role="group" aria-label={t('settings.locale')}>
            <button
              type="button"
              className={props.locale === 'th' ? 'active' : undefined}
              onClick={() => props.onLocaleChange('th')}
            >
              {t('language.th')}
            </button>
            <button
              type="button"
              className={props.locale === 'en' ? 'active' : undefined}
              onClick={() => props.onLocaleChange('en')}
            >
              {t('language.en')}
            </button>
          </div>
        </div>
      </header>

      {/* Main App Body */}
      <div className="app-shell">
        <aside className="sidebar" aria-label="Navigation">
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
            <span>Desktop</span>
            <strong className={props.mcpRunning ? 'status-online' : 'status-offline'}>
              {props.mcpRunning ? t('footer.connected') : t('footer.disconnected')}
            </strong>
          </div>
        </aside>

        <div className="main-pane">
          <main className="main-content">{props.children}</main>
        </div>
      </div>
    </div>
  );
}
function versionBadgeText(appVersion: string, status: UpdateStatus | null, locale: UiLocale): string {
  if (status === null) return `v${appVersion}`;
  const next = status.availableVersion;
  if (status.phase === 'ready' && next !== null) return locale === 'th' ? `อัปเดต v${next}` : `Update v${next}`;
  if (status.phase === 'installing' && next !== null) return locale === 'th' ? `กำลังติดตั้ง v${next}` : `Installing v${next}`;
  if (status.phase === 'downloading') {
    const percent = status.progressPercent === null ? '' : ` ${Math.round(status.progressPercent)}%`;
    return `v${appVersion} ↓${percent}`;
  }
  if (status.phase === 'available' && next !== null) return `v${appVersion} → v${next}`;
  if (status.phase === 'checking') return locale === 'th' ? `v${appVersion} • เช็ก…` : `v${appVersion} • checking…`;
  if (status.phase === 'error') return `v${appVersion} • !`;
  return `v${appVersion}`;
}
