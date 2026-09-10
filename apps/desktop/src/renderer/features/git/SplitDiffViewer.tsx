import { Fragment, useRef, useState, type ReactElement } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';

export interface DiffRow {
  readonly oldLineNumber: number | null;
  readonly oldText: string;
  readonly oldType: 'normal' | 'deleted' | 'empty';
  readonly newLineNumber: number | null;
  readonly newText: string;
  readonly newType: 'normal' | 'added' | 'empty';
}

export interface DiffHunk {
  readonly header: string;
  readonly rows: readonly DiffRow[];
}

export interface ParsedDiff {
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

export function parseUnifiedDiff(
  patch: string,
  fallbackNewContent?: string | undefined,
  fallbackOldContent?: string | undefined,
): ParsedDiff {
  const trimmed = patch.trim();
  if (!trimmed) {
    if (fallbackNewContent !== undefined && fallbackOldContent === undefined) {
      // Entire file is added
      const lines = fallbackNewContent.split(/\r?\n/);
      const rows: DiffRow[] = lines.map((line, idx) => ({
        oldLineNumber: null,
        oldText: '',
        oldType: 'empty',
        newLineNumber: idx + 1,
        newText: line,
        newType: 'added',
      }));
      return {
        hunks: [{ header: `@@ -0,0 +1,${lines.length} @@ (New File)`, rows }],
        additions: lines.length,
        deletions: 0,
      };
    }
    if (fallbackOldContent !== undefined && fallbackNewContent === undefined) {
      // Entire file is deleted
      const lines = fallbackOldContent.split(/\r?\n/);
      const rows: DiffRow[] = lines.map((line, idx) => ({
        oldLineNumber: idx + 1,
        oldText: line,
        oldType: 'deleted',
        newLineNumber: null,
        newText: '',
        newType: 'empty',
      }));
      return {
        hunks: [{ header: `@@ -1,${lines.length} +0,0 @@ (Deleted File)`, rows }],
        additions: 0,
        deletions: lines.length,
      };
    }
    return { hunks: [], additions: 0, deletions: 0 };
  }

  const lines = patch.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let currentHeader = '';
  let currentRows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let totalAdd = 0;
  let totalDel = 0;

  let pendingDel: string[] = [];
  let pendingAdd: string[] = [];

  const flushPending = (): void => {
    const maxLen = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < maxLen; i++) {
      const delText = pendingDel[i];
      const addText = pendingAdd[i];

      if (delText !== undefined && addText !== undefined) {
        currentRows.push({
          oldLineNumber: oldLine++,
          oldText: delText,
          oldType: 'deleted',
          newLineNumber: newLine++,
          newText: addText,
          newType: 'added',
        });
      } else if (delText !== undefined) {
        currentRows.push({
          oldLineNumber: oldLine++,
          oldText: delText,
          oldType: 'deleted',
          newLineNumber: null,
          newText: '',
          newType: 'empty',
        });
      } else if (addText !== undefined) {
        currentRows.push({
          oldLineNumber: null,
          oldText: '',
          oldType: 'empty',
          newLineNumber: newLine++,
          newText: addText,
          newType: 'added',
        });
      }
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushPending();
      if (currentRows.length > 0 || currentHeader) {
        hunks.push({ header: currentHeader, rows: currentRows });
        currentRows = [];
      }
      currentHeader = line;
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
      }
    } else if (currentHeader) {
      if (line.startsWith('-')) {
        totalDel++;
        pendingDel.push(line.slice(1));
      } else if (line.startsWith('+')) {
        totalAdd++;
        pendingAdd.push(line.slice(1));
      } else if (line.startsWith(' ') || line === '') {
        flushPending();
        currentRows.push({
          oldLineNumber: oldLine++,
          oldText: line.startsWith(' ') ? line.slice(1) : line,
          oldType: 'normal',
          newLineNumber: newLine++,
          newText: line.startsWith(' ') ? line.slice(1) : line,
          newType: 'normal',
        });
      }
    }
  }
  flushPending();
  if (currentRows.length > 0) {
    hunks.push({ header: currentHeader, rows: currentRows });
  }

  return { hunks, additions: totalAdd, deletions: totalDel };
}

interface SplitDiffViewerProps {
  readonly locale: UiLocale;
  readonly filePath: string;
  readonly patch: string;
  readonly oldContent?: string | undefined;
  readonly newContent?: string | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly onClose: () => void;
}

export function SplitDiffViewer({
  locale,
  filePath,
  patch,
  oldContent,
  newContent,
  additions: propAdditions,
  deletions: propDeletions,
  onClose,
}: SplitDiffViewerProps): ReactElement {
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef<'left' | 'right' | null>(null);

  const parsed = parseUnifiedDiff(patch, newContent, oldContent);
  const additionsCount = propAdditions ?? parsed.additions;
  const deletionsCount = propDeletions ?? parsed.deletions;

  const handleLeftScroll = (): void => {
    if (isScrollingRef.current === 'right') return;
    isScrollingRef.current = 'left';
    if (rightScrollRef.current && leftScrollRef.current) {
      rightScrollRef.current.scrollTop = leftScrollRef.current.scrollTop;
      rightScrollRef.current.scrollLeft = leftScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => {
      isScrollingRef.current = null;
    });
  };

  const handleRightScroll = (): void => {
    if (isScrollingRef.current === 'left') return;
    isScrollingRef.current = 'right';
    if (leftScrollRef.current && rightScrollRef.current) {
      leftScrollRef.current.scrollTop = rightScrollRef.current.scrollTop;
      leftScrollRef.current.scrollLeft = rightScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => {
      isScrollingRef.current = null;
    });
  };

  const isTh = locale === 'th';

  return (
    <div className="split-diff-viewer">
      <div className="diff-header-bar">
        <div className="diff-header-left">
          <button
            type="button"
            className="diff-back-btn"
            onClick={onClose}
            title={isTh ? 'กลับไปยังรายการไฟล์' : 'Back to file list'}
          >
            ← {isTh ? 'กลับ' : 'Back'}
          </button>
          <span className="diff-file-title" title={filePath}>
            📄 {filePath}
          </span>
          <div className="diff-stats-badges">
            <span className="diff-badge-add" title={isTh ? 'บรรทัดที่เพิ่ม' : 'Lines added'}>
              +{additionsCount}
            </span>
            <span className="diff-badge-del" title={isTh ? 'บรรทัดที่ลบ' : 'Lines deleted'}>
              -{deletionsCount}
            </span>
          </div>
        </div>

        <div className="diff-header-right">
          <div className="diff-view-toggle">
            <button
              type="button"
              className={`toggle-btn ${viewMode === 'split' ? 'active' : ''}`}
              onClick={() => { setViewMode('split'); }}
            >
              ⊞ {isTh ? 'แยก 2 จอ (Split)' : 'Split View'}
            </button>
            <button
              type="button"
              className={`toggle-btn ${viewMode === 'unified' ? 'active' : ''}`}
              onClick={() => { setViewMode('unified'); }}
            >
              ☰ {isTh ? 'รวม (Unified)' : 'Unified View'}
            </button>
          </div>
          <button
            type="button"
            className="diff-close-btn"
            onClick={onClose}
            aria-label={isTh ? 'ปิดหน้าต่าง diff' : 'Close diff'}
          >
            ✕
          </button>
        </div>
      </div>

      {parsed.hunks.length === 0 ? (
        <div className="diff-empty-notice">
          <span>✨</span>
          <p>{isTh ? 'ไม่มีความเปลี่ยนแปลงของบรรทัดโค้ดในไฟล์นี้' : 'No changes in this file.'}</p>
        </div>
      ) : viewMode === 'split' ? (
        <div className="diff-split-container">
          {/* Column Titles */}
          <div className="diff-pane-titles">
            <div className="diff-pane-title old-title">
              <span className="dot red-dot" />
              <span>{isTh ? 'ต้นฉบับ / ก่อนแก้ไข (Old)' : 'Original (Old / HEAD)'}</span>
            </div>
            <div className="diff-pane-title new-title">
              <span className="dot green-dot" />
              <span>{isTh ? 'แก้ไขล่าสุด / ใหม่ (New)' : 'Modified (New / Working Tree)'}</span>
            </div>
          </div>

          <div className="diff-panes-wrapper">
            {/* Left Pane (Old) */}
            <div
              ref={leftScrollRef}
              className="diff-pane diff-pane-left"
              onScroll={handleLeftScroll}
            >
              {parsed.hunks.map((hunk, hunkIdx) => (
                <div key={`hunk-left-${hunkIdx}`} className="diff-hunk-block">
                  <div className="diff-hunk-header">{hunk.header}</div>
                  <table className="diff-table">
                    <tbody>
                      {hunk.rows.map((row, rowIdx) => (
                        <tr
                          key={`row-l-${rowIdx}`}
                          className={`diff-row ${row.oldType === 'deleted' ? 'row-deleted' : row.oldType === 'empty' ? 'row-empty' : 'row-normal'}`}
                        >
                          <td className="diff-gutter">
                            {row.oldLineNumber ?? ''}
                          </td>
                          <td className="diff-marker">
                            {row.oldType === 'deleted' ? '-' : ' '}
                          </td>
                          <td className="diff-code">
                            <code>{row.oldText}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {/* Right Pane (New) */}
            <div
              ref={rightScrollRef}
              className="diff-pane diff-pane-right"
              onScroll={handleRightScroll}
            >
              {parsed.hunks.map((hunk, hunkIdx) => (
                <div key={`hunk-right-${hunkIdx}`} className="diff-hunk-block">
                  <div className="diff-hunk-header">{hunk.header}</div>
                  <table className="diff-table">
                    <tbody>
                      {hunk.rows.map((row, rowIdx) => (
                        <tr
                          key={`row-r-${rowIdx}`}
                          className={`diff-row ${row.newType === 'added' ? 'row-added' : row.newType === 'empty' ? 'row-empty' : 'row-normal'}`}
                        >
                          <td className="diff-gutter">
                            {row.newLineNumber ?? ''}
                          </td>
                          <td className="diff-marker">
                            {row.newType === 'added' ? '+' : ' '}
                          </td>
                          <td className="diff-code">
                            <code>{row.newText}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* Unified View */
        <div className="diff-unified-container">
          {parsed.hunks.map((hunk, hunkIdx) => (
            <div key={`hunk-unified-${hunkIdx}`} className="diff-hunk-block">
              <div className="diff-hunk-header">{hunk.header}</div>
              <table className="diff-table unified-table">
                <tbody>
                  {hunk.rows.map((row, rowIdx) => {
                    const isDel = row.oldType === 'deleted';
                    const isAdd = row.newType === 'added';
                    if (isDel && isAdd) {
                      return (
                        <Fragment key={`row-u-${rowIdx}`}>
                          <tr className="diff-row row-deleted">
                            <td className="diff-gutter">{row.oldLineNumber ?? ''}</td>
                            <td className="diff-gutter" />
                            <td className="diff-marker">-</td>
                            <td className="diff-code"><code>{row.oldText}</code></td>
                          </tr>
                          <tr className="diff-row row-added">
                            <td className="diff-gutter" />
                            <td className="diff-gutter">{row.newLineNumber ?? ''}</td>
                            <td className="diff-marker">+</td>
                            <td className="diff-code"><code>{row.newText}</code></td>
                          </tr>
                        </Fragment>
                      );
                    }
                    if (isDel) {
                      return (
                        <tr key={`row-u-${rowIdx}`} className="diff-row row-deleted">
                          <td className="diff-gutter">{row.oldLineNumber ?? ''}</td>
                          <td className="diff-gutter" />
                          <td className="diff-marker">-</td>
                          <td className="diff-code"><code>{row.oldText}</code></td>
                        </tr>
                      );
                    }
                    if (isAdd) {
                      return (
                        <tr key={`row-u-${rowIdx}`} className="diff-row row-added">
                          <td className="diff-gutter" />
                          <td className="diff-gutter">{row.newLineNumber ?? ''}</td>
                          <td className="diff-marker">+</td>
                          <td className="diff-code"><code>{row.newText}</code></td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={`row-u-${rowIdx}`} className="diff-row row-normal">
                        <td className="diff-gutter">{row.oldLineNumber ?? ''}</td>
                        <td className="diff-gutter">{row.newLineNumber ?? ''}</td>
                        <td className="diff-marker"> </td>
                        <td className="diff-code"><code>{row.newText}</code></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
