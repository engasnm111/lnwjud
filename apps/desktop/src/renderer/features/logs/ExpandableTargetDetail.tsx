import { useId, useState, type ReactElement } from 'react';
import type { ActivityTargetDetail, ActivityTargetReference, UiLocale } from '@lnwjud/ipc-contracts';
import { formatDisplayTimestampItem } from '@lnwjud/shared/date-time-display';

interface ExpandableTargetDetailProps {
  readonly locale?: UiLocale;
  readonly reference: ActivityTargetReference;
  readonly legacySummary?: string | null;
  readonly showMoreLabel: string;
  readonly showLessLabel: string;
  readonly detailHeadingLabel: string;
  readonly loadingLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly legacyIncompleteLabel: string;
  readonly loadDetail?: (detailRef: string) => Promise<ActivityTargetDetail | null>;
}

type DetailState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'complete'; readonly detail: ActivityTargetDetail }
  | { readonly status: 'error' };

export function ExpandableTargetDetail(props: ExpandableTargetDetailProps): ReactElement | null {
  const reactId = useId();
  const panelId = `log-detail-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [expanded, setExpanded] = useState(false);
  const [detailState, setDetailState] = useState<DetailState>({ status: 'idle' });
  const legacyExpandableFallback = props.reference.preview.length > 0
    ? props.reference.itemCount > props.reference.preview.length
    : props.reference.itemCount > 3;
  const expandable = !props.reference.legacyIncomplete
    && props.reference.detailRef !== null
    && (props.reference.hasAdditionalDetail ?? legacyExpandableFallback);

  if (props.reference.legacyIncomplete && legacySummaryIsTruncated(props.legacySummary)) {
    return <p className="log-detail-legacy-warning" role="note">{props.legacyIncompleteLabel}</p>;
  }
  if (!expandable) return null;

  async function toggle(): Promise<void> {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detailState.status === 'complete' || detailState.status === 'loading') return;
    setDetailState({ status: 'loading' });
    try {
      const detailRef = props.reference.detailRef;
      const detail = detailRef === null || props.loadDetail === undefined ? null : await props.loadDetail(detailRef);
      setDetailState(detail === null ? { status: 'error' } : { status: 'complete', detail });
    } catch {
      setDetailState({ status: 'error' });
    }
  }

  return (
    <div className="expandable-log-detail">
      <button
        type="button"
        className="log-detail-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => { void toggle(); }}
      >
        {expanded ? props.showLessLabel : props.showMoreLabel}
      </button>
      {expanded ? (
        <div id={panelId} className="log-detail-panel" aria-live="polite">
          <h3>{props.detailHeadingLabel}</h3>
          {detailState.status === 'idle' || detailState.status === 'loading' ? <p role="status">{props.loadingLabel}</p> : null}
          {detailState.status === 'error' ? <p className="log-detail-error" role="alert">{props.errorLabel}</p> : null}
          {detailState.status === 'complete' && detailState.detail.items.length === 0 ? <p>{props.emptyLabel}</p> : null}
          {detailState.status === 'complete' && detailState.detail.items.length > 0 ? (
            <ul className="log-detail-items">
              {detailState.detail.items.map((item, index) => <li key={`${index}:${item}`}>{formatDisplayTimestampItem(item, props.locale ?? 'th')}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function legacySummaryIsTruncated(summary: string | null | undefined): boolean {
  return typeof summary === 'string' && /\(\+\d+\)\s*$/.test(summary.trim());
}
