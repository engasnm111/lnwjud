import { useState, type ReactElement } from 'react';
import type { DashboardSnapshot, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { WorkLogPanel, type WorkLogFilter } from '../worklog/WorkLogPanel.js';

interface WorkLogPageProps {
  readonly locale: UiLocale;
  readonly dashboard: DashboardSnapshot;
  readonly onClearWorkLog: () => Promise<void>;
}

export function WorkLogPage(props: WorkLogPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [filter, setFilter] = useState<WorkLogFilter>('all');
  return (
    <div className="page-content">
      <WorkLogPanel
        title={t('workLog.title')}
        emptyLabel={t('workLog.empty')}
        filterAllLabel={t('workLog.filterAll')}
        filterErrorLabel={t('workLog.filterError')}
        clearLabel={t('workLog.clear')}
        filter={filter}
        onFilterChange={setFilter}
        onClear={props.onClearWorkLog}
        entries={props.dashboard.workLog}
        inFlight={props.dashboard.inFlight}
      />
    </div>
  );
}
