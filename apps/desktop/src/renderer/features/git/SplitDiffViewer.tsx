import { ActionButton } from '../ui/UiPrimitives.js';
import { Fragment, useRef, useState, type ReactElement } from 'react';
import type { GitFilePreviewInfo, GitImagePreview, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { v580Strings } from '../../i18n/v580-copy.js';


export function formatGitHunkLabel(header: string, locale: UiLocale): string {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return header;
  const range = (startText: string, countText?: string): string => {
    const start = Number(startText);
    const count = countText === undefined ? 1 : Number(countText);
    if (count === 0) return '—';
    return count === 1 ? String(start) : `${start}–${start + count - 1}`;
  };
  const oldRange = range(match[1]!, match[2]);
  const newRange = range(match[3]!, match[4]);
  return locale === 'th'
    ? `ช่วงที่เปลี่ยน • ก่อนแก้ ${oldRange} / หลังแก้ ${newRange}`
    : `Changed range • Old ${oldRange} / New ${newRange}`;
}

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
  readonly oldImage?: GitImagePreview | undefined;
  readonly newImage?: GitImagePreview | undefined;
  readonly imagePreviewError?: 'too_large' | 'unsupported' | undefined;
  readonly preview?: GitFilePreviewInfo | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly oldLabel?: string | undefined;
  readonly newLabel?: string | undefined;
  readonly onClose: () => void;
}

function renderImagePane(
  image: GitImagePreview | undefined,
  failed: boolean,
  missingText: string,
  unsupportedText: string,
  alt: string,
  onError: () => void,
): ReactElement {
  let preview: ReactElement;
  if (image === undefined) {
    preview = <div className="image-diff-empty">{missingText}</div>;
  } else if (failed) {
    preview = <div className="image-diff-empty">{unsupportedText}<small>{image.mimeType}</small></div>;
  } else {
    preview = <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={alt} onError={onError} />;
  }
  return (
    <figure className="image-diff-pane">
      {preview}
      {image === undefined ? null : <figcaption>{image.mimeType} · {image.byteLength.toLocaleString()} B</figcaption>}
    </figure>
  );
}

export function SplitDiffViewer({
  locale,
  filePath,
  patch,
  oldContent,
  newContent,
  oldImage,
  newImage,
  imagePreviewError,
  preview,
  additions: propAdditions,
  deletions: propDeletions,
  oldLabel = 'HEAD',
  newLabel = 'Working Tree',
  onClose,
}: SplitDiffViewerProps): ReactElement {
  const t = createTranslator(locale);
  const copy = v580Strings(locale).git;
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const [imageFit, setImageFit] = useState(true);
  const [oldImageFailed, setOldImageFailed] = useState(false);
  const [newImageFailed, setNewImageFailed] = useState(false);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef<'left' | 'right' | null>(null);

  const parsed = parseUnifiedDiff(patch, newContent, oldContent);
  const additionsCount = propAdditions ?? parsed.additions;
  const deletionsCount = propDeletions ?? parsed.deletions;
  const isImageDiff = oldImage !== undefined || newImage !== undefined || imagePreviewError !== undefined;

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

  let imageDiffBody: ReactElement | null = null;
  if (isImageDiff) {
    if (imagePreviewError !== undefined) {
      const errorText = imagePreviewError === 'too_large' ? t('diff.imageTooLarge') : t('diff.imageUnsupported');
      imageDiffBody = <div className="diff-empty-notice"><p>{errorText}</p></div>;
    } else {
      imageDiffBody = (
        <div className={`image-diff-container ${imageFit ? 'image-fit' : 'image-actual'}`}>
          <div className="diff-pane-titles">
            <div className="diff-pane-title old-title"><span className="dot red-dot" /><span>{t('diff.original', { label: oldLabel })}</span></div>
            <div className="diff-pane-title new-title"><span className="dot green-dot" /><span>{t('diff.modified', { label: newLabel })}</span></div>
          </div>
          <div className="image-diff-grid">
            {renderImagePane(oldImage, oldImageFailed, t('diff.imageMissing'), t('diff.imageUnsupported'), t('diff.original', { label: oldLabel }), () => { setOldImageFailed(true); })}
            {renderImagePane(newImage, newImageFailed, t('diff.imageMissing'), t('diff.imageUnsupported'), t('diff.modified', { label: newLabel }), () => { setNewImageFailed(true); })}
          </div>
        </div>
      );
    }
  }

  return (
    <div className="split-diff-viewer">
      <div className="diff-header-bar">
        <div className="diff-header-left">
          <ActionButton
            type="button"
            className="diff-back-btn"
            onClick={onClose}
            title={t('diff.backTitle')}
          >
            ← {t('diff.back')}
          </ActionButton>
          <span className="diff-file-title" title={filePath}>
            📄 {filePath}
          </span>
          <div className="diff-stats-badges">
            <span className="diff-badge-add" title={t('diff.linesAdded')}>
              +{additionsCount}
            </span>
            <span className="diff-badge-del" title={t('diff.linesDeleted')}>
              -{deletionsCount}
            </span>
          </div>
        </div>

        <div className="diff-header-right">
          <div className="diff-view-toggle">
            {isImageDiff ? (
              <>
                <ActionButton type="button" className={`toggle-btn ${imageFit ? 'active' : ''}`} onClick={() => { setImageFit(true); }}>
                  {t('diff.imageFit')}
                </ActionButton>
                <ActionButton type="button" className={`toggle-btn ${imageFit ? '' : 'active'}`} onClick={() => { setImageFit(false); }}>
                  {t('diff.imageActual')}
                </ActionButton>
              </>
            ) : (
              <>
                <ActionButton
                  type="button"
                  className={`toggle-btn ${viewMode === 'split' ? 'active' : ''}`}
                  onClick={() => { setViewMode('split'); }}
                >
                  {t('diff.splitView')}
                </ActionButton>
                <ActionButton
                  type="button"
                  className={`toggle-btn ${viewMode === 'unified' ? 'active' : ''}`}
                  onClick={() => { setViewMode('unified'); }}
                >
                  {t('diff.unifiedView')}
                </ActionButton>
              </>
            )}
          </div>
          <ActionButton
            type="button"
            className="diff-close-btn"
            onClick={onClose}
            aria-label={t('diff.closeAria')}
          >
            {t('diff.close')}
          </ActionButton>
        </div>
      </div>

      {isImageDiff ? imageDiffBody : null}
      {!isImageDiff && (parsed.hunks.length === 0 ? (
        <div className="diff-empty-notice">
          {preview?.kind === 'binary' || preview?.kind === 'too_large' || preview?.kind === 'missing'
            ? <div className="git-preview-metadata">
                <strong>{copy.details}</strong>
                <dl>
                  <dt>{copy.type}</dt><dd>{preview.mimeType ?? (preview.extension || 'Unknown')}</dd>
                  <dt>{copy.size}</dt><dd>{preview.sizeBytes === null ? 'Unknown' : `${preview.sizeBytes.toLocaleString()} bytes`}</dd>
                  <dt>{copy.preview}</dt>
                  <dd>{preview.kind === 'binary' ? (copy.binary) : preview.kind === 'too_large' ? (copy.tooLarge) : (copy.removed)}</dd>
                </dl>
              </div>
            : <p>{t('diff.noChanges')}</p>}
        </div>
      ) : viewMode === 'split' ? (
        <div className="diff-split-container">
          {/* Column Titles */}
          <div className="diff-pane-titles">
            <div className="diff-pane-title old-title">
              <span className="dot red-dot" />
              <span>{t('diff.original', { label: oldLabel })}</span>
            </div>
            <div className="diff-pane-title new-title">
              <span className="dot green-dot" />
              <span>{t('diff.modified', { label: newLabel })}</span>
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
                  <div className="diff-hunk-header" title={hunk.header}>{formatGitHunkLabel(hunk.header, locale)}</div>
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
                  <div className="diff-hunk-header" title={hunk.header}>{formatGitHunkLabel(hunk.header, locale)}</div>
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
              <div className="diff-hunk-header" title={hunk.header}>{formatGitHunkLabel(hunk.header, locale)}</div>
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
      ))}
    </div>
  );
}
