import { useState, type ReactElement } from 'react';
import type { LogLine, LogSource, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { LogStreamPanel } from './LogStreamPanel.js';

interface LiveLogsPageProps {
  readonly locale: UiLocale;
  readonly lines: readonly LogLine[];
  readonly tunnelLogPath: string | null;
  readonly tunnelLogExists: boolean;
  readonly onClear: (source: LogSource) => Promise<void>;
  readonly onExport: (source: LogSource) => Promise<void>;
  readonly onPopOut: () => Promise<void>;
}

type LogTab = LogSource;

export function LiveLogsPage(props: LiveLogsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [tab, setTab] = useState<LogTab>('tunnel');
  const sources: readonly LogTab[] = ['tunnel', 'mcp', 'process'];

  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <h1>{t('live.title')}</h1>
          <p className="page-subtitle">{t('live.subtitle')}</p>
        </div>
        <div className="heading-actions">
          <button type="button" onClick={() => { void props.onPopOut(); }}>{t('live.popOut')}</button>
        </div>
      </div>
      <div className="log-tabs" role="tablist" aria-label={t('live.title')}>
        {sources.map((source) => (
          <button
            key={source}
            type="button"
            role="tab"
            aria-selected={tab === source}
            className={tab === source ? 'log-tab active' : 'log-tab'}
            onClick={() => setTab(source)}
          >
            {source === 'tunnel' ? t('live.tabTunnel') : source === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
          </button>
        ))}
      </div>
      {sources.map((source) => (
        tab === source ? (
          <LogStreamPanel
            key={source}
            title={source === 'tunnel' ? t('live.tabTunnel') : source === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
            source={source}
            lines={props.lines.filter((line) => line.source === source)}
            tunnelLogPath={props.tunnelLogPath}
            tunnelLogExists={props.tunnelLogExists}
            pauseLabel={t('live.pause')}
            followLabel={t('live.follow')}
            filterPlaceholder={t('live.filter')}
            clearLabel={t('workLog.clear')}
            exportLabel={t('live.export')}
            waitingLabel={source === 'tunnel' ? t('live.waitingTunnel') : t('live.waiting')}
            onClear={() => props.onClear(source)}
            onExport={() => props.onExport(source)}
          />
        ) : null
      ))}
    </div>
  );
}
