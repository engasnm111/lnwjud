import { ActionButton, FormInput, FilterBar } from '../ui/UiPrimitives.js';
import { useDeferredValue, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, GitImagePreview, GitStatusEntrySummary, UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { v580Strings } from '../../i18n/v580-copy.js';
import { SplitDiffViewer } from './SplitDiffViewer.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { filterGitFiles, type GitFileStatusFilter } from './git-file-browser.js';
import { buildGitFileTree } from './git-file-tree.js';
import { GitFileTree } from './GitFileTree.js';

interface GitPageProps {
  readonly locale: UiLocale;
  readonly gitSummary: DashboardSnapshot['gitSummary'];
  readonly selectedWorkspace?: WorkspaceSummary | null;
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly onSelectWorkspace?: (workspaceId: string) => Promise<void>;
  readonly onRefresh?: () => Promise<void>;
}

export function GitPage({
  locale,
  gitSummary,
  selectedWorkspace,
  workspaces = [],
  onSelectWorkspace,
  onRefresh,
}: GitPageProps): ReactElement {
  const t = createTranslator(locale);
  const copy = v580Strings(locale).git;
  const isClean = gitSummary.changedFiles === 0 && gitSummary.stagedFiles === 0;
  const isRepo = gitSummary.isRepo ?? (gitSummary.message !== 'Not a Git repository' && gitSummary.message !== 'No workspace selected');
  const currentPath = gitSummary.repositoryPath ?? selectedWorkspace?.realRootPath ?? '—';

  const [selectedFile, setSelectedFile] = useState<GitStatusEntrySummary | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<GitFileStatusFilter>('all');
  const [visibleCount, setVisibleCount] = useState(250);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const toggleFolder = (path: string): void => setCollapsedFolders((previous) => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  useEffect(() => { setSelectedFile(null); setDiffData(null); setQuery(''); setStatusFilter('all'); setVisibleCount(250); setCollapsedFolders(new Set()); }, [selectedWorkspace?.id]);
  const filteredEntries = useMemo(
    () => filterGitFiles(gitSummary.entries ?? [], deferredQuery, statusFilter),
    [gitSummary.entries, deferredQuery, statusFilter],
  );
  const visibleEntries = useMemo(() => filteredEntries.slice(0, visibleCount), [filteredEntries, visibleCount]);
  const fileTree = useMemo(() => buildGitFileTree(visibleEntries), [visibleEntries]);

  const folderPaths = useMemo(() => {

    const paths: string[] = [];

    const walk = (nodes: typeof fileTree): void => {

      for (const node of nodes) {

        if (node.type === 'folder') { paths.push(node.path); walk(node.children); }

      }

    };

    walk(fileTree);

    return paths;

  }, [fileTree]);
  const [diffData, setDiffData] = useState<{
    patch: string;
    oldContent?: string;
    newContent?: string;
    oldImage?: GitImagePreview;
    newImage?: GitImagePreview;
    imagePreviewError?: 'too_large' | 'unsupported';
    preview?: import('@lnwjud/ipc-contracts').GitFilePreviewInfo;
    additions?: number;
    deletions?: number;
    loading: boolean;
    error?: string;
  } | null>(null);

  const handleOpenFileDiff = async (
    entry: GitStatusEntrySummary,
    staged = entry.indexStatus !== ' ' && entry.worktreeStatus === ' ',
  ): Promise<void> => {
    if (!selectedWorkspace) return;
    setSelectedFile(entry);
    setSelectedStaged(staged);
    setDiffData({ patch: '', loading: true });
    try {
      const res = await window.lnwjud.getGitDiff({
        workspaceId: selectedWorkspace.id,
        path: entry.path,
        staged,
      });
      setDiffData({
        patch: res.patch,
        ...(res.preview === undefined ? {} : { preview: res.preview }),
        ...(res.oldContent !== undefined ? { oldContent: res.oldContent } : {}),
        ...(res.newContent !== undefined ? { newContent: res.newContent } : {}),
        ...(res.oldImage !== undefined ? { oldImage: res.oldImage } : {}),
        ...(res.newImage !== undefined ? { newImage: res.newImage } : {}),
        ...(res.imagePreviewError !== undefined ? { imagePreviewError: res.imagePreviewError } : {}),
        ...(res.additions !== undefined ? { additions: res.additions } : {}),
        ...(res.deletions !== undefined ? { deletions: res.deletions } : {}),
        loading: false,
      });
    } catch (err: unknown) {
      setDiffData({
        patch: '',
        loading: false,
        error: err instanceof Error ? err.message : t('git.diffLoadError'),
      });
    }
  };

  return (
    <div className={`page-content viewport-list-page git-page ${selectedFile === null ? '' : 'git-page--diff-open'}`}>
      <div className="page-heading">
        <div>
          <h1>{t('git.title')}</h1>
          <p className="page-subtitle">{t('git.subtitle')}</p>
          <p className="hint">{t('git.projectLabel')}: {selectedWorkspace?.displayName ?? '—'} · {currentPath}</p>
        </div>
        <div className="heading-actions">
          {workspaces.length > 1 && onSelectWorkspace !== undefined ? (
            <div className="form-row">
              <SearchableSelect label={t('git.selectWorkspace')} value={selectedWorkspace?.id ?? ''}
                options={workspaces.map((ws) => ({ value: ws.id, label: ws.displayName }))}
                onChange={(value) => { void onSelectWorkspace(value); }} />
            </div>
          ) : null}
          {onRefresh === undefined ? null : (
            <ActionButton type="button" onClick={() => { void onRefresh(); }}>
              {t('action.refresh')}
            </ActionButton>
          )}
        </div>
      </div>

      <section className="git-panel">
        <div className="git-summary-strip">
          <strong className="git-summary-message" data-testid="git-summary">{gitSummary.message}</strong>
          <div className="git-summary-stats" aria-label={t('git.statusSummary')}>
            <span>
              <span className="git-summary-label">{t('git.branch')}</span>
              <strong>{gitSummary.branch ?? '—'}</strong>
            </span>
            <span>
              <span className="git-summary-label">{t('git.changed')}</span>
              <strong>{gitSummary.changedFiles}</strong>
            </span>
            <span>
              <span className="git-summary-label">{t('git.staged')}</span>
              <strong>{gitSummary.stagedFiles}</strong>
            </span>
            <span>
              <span className="git-summary-label">{t('git.workingTree')}</span>
              <strong className={!isRepo ? '' : isClean ? 'status-clean' : 'status-dirty'}>
                {!isRepo ? '—' : isClean ? t('git.clean') : t('git.modified')}
              </strong>
            </span>
          </div>
        </div>

        {selectedFile !== null ? (
          <div className="git-diff-container-section">
            {diffData?.loading ? (
              <div className="diff-loading-box">
                <span>{t('git.loadingDiff')}</span>
              </div>
            ) : diffData?.error ? (
              <div className="diff-error-box">
                <p>{diffData.error}</p>
                <ActionButton type="button" onClick={() => { setSelectedFile(null); }}>
                  {t('git.close')}
                </ActionButton>
              </div>
            ) : (
              <>
                {selectedFile.indexStatus !== ' ' && selectedFile.indexStatus !== '?' && selectedFile.worktreeStatus !== ' ' ? (
                  <div className="diff-view-toggle" aria-label={t('git.diffScope')}>
                    <ActionButton
                      type="button"
                      className={`toggle-btn ${selectedStaged ? 'active' : ''}`}
                      onClick={() => { void handleOpenFileDiff(selectedFile, true); }}
                    >
                      HEAD → Index (Staged)
                    </ActionButton>
                    <ActionButton
                      type="button"
                      className={`toggle-btn ${selectedStaged ? '' : 'active'}`}
                      onClick={() => { void handleOpenFileDiff(selectedFile, false); }}
                    >
                      Index → Working Tree (Unstaged)
                    </ActionButton>
                  </div>
                ) : null}
                <SplitDiffViewer
                  key={`${selectedFile.path}:${selectedStaged ? 'staged' : 'unstaged'}`}
                  locale={locale}
                  filePath={selectedFile.path}
                  patch={diffData?.patch ?? ''}
                  oldContent={diffData?.oldContent}
                  newContent={diffData?.newContent}
                  oldImage={diffData?.oldImage}
                  newImage={diffData?.newImage}
                  imagePreviewError={diffData?.imagePreviewError}
                  preview={diffData?.preview}
                  additions={diffData?.additions}
                  deletions={diffData?.deletions}
                  oldLabel={selectedStaged ? 'HEAD' : 'Index'}
                  newLabel={selectedStaged ? 'Index (Staged)' : 'Working Tree'}
                  onClose={() => { setSelectedFile(null); }}
                />
              </>
            )}
          </div>
        ) : null}

        {!isRepo ? (
          <div className="git-not-repo-notice">
            <div className="git-notice-header">
              <div>
                <strong>{t('git.notRepoTitle')}</strong>
                <p className="hint">
                  {t('git.notRepoHint', { path: currentPath })}
                </p>
              </div>
            </div>
            {workspaces.filter((ws) => ws.id !== selectedWorkspace?.id).length > 0 && onSelectWorkspace !== undefined ? (
              <div className="git-switch-list">
                {workspaces.filter((ws) => ws.id !== selectedWorkspace?.id).map((ws) => (
                  <div key={ws.id} className="git-switch-item">
                    <div>
                      <strong>{ws.displayName}</strong>
                      <p className="hint">{ws.realRootPath}</p>
                    </div>
                    <ActionButton type="button" onClick={() => { void onSelectWorkspace(ws.id); }}>
                      {t('git.switchProject')}
                    </ActionButton>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="git-files-section">
            <div className="git-files-header">
              <h3>{t('git.changedFilesTitle')}</h3>
              <span className="hint">
                {t('git.changedFilesHint')}
              </span>
              <div className="git-tree-actions">
                <ActionButton type="button" onClick={() => setCollapsedFolders(new Set())}>{copy.expandAll}</ActionButton>
                <ActionButton type="button" onClick={() => setCollapsedFolders(new Set(folderPaths))}>{copy.collapseAll}</ActionButton>
              </div>
            </div>
            <FilterBar className="git-file-toolbar">
              <FormInput aria-label={copy.search} placeholder={copy.placeholder} value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(250); }} />
              <SearchableSelect label={copy.filter} value={statusFilter}
                options={[{ value:'all', label:copy.all }, { value:'staged',label:'Staged' }, { value:'unstaged',label:'Unstaged' }, { value:'untracked',label:copy.untracked }]}
                onChange={(value) => { setStatusFilter(value as GitFileStatusFilter); setVisibleCount(250); }} />
              <span role="status" className="hint">{query !== deferredQuery ? (locale === 'en' ? 'Filtering… ' : 'กำลังกรอง… ') : ''}{visibleEntries.length.toLocaleString()} / {filteredEntries.length.toLocaleString()} {copy.files}</span>
            </FilterBar>
            <div className={`git-file-list ${filteredEntries.length > 0 ? '' : 'empty'}`}>
              {visibleEntries.length > 0 ? (
                <GitFileTree nodes={fileTree} locale={locale} collapsedFolders={collapsedFolders}
                  searchActive={deferredQuery.trim().length > 0}
                  onToggle={toggleFolder} onOpen={(entry) => { void handleOpenFileDiff(entry); }} />
              ) : (
                <div className="git-file-empty">
                  <strong>{filteredEntries.length === 0 && (gitSummary.entries?.length ?? 0) > 0 ? (copy.noMatch) : t('git.noChangedFiles')}</strong>
                  <span className="hint">{filteredEntries.length === 0 && (gitSummary.entries?.length ?? 0) > 0 ? (copy.tryFilter) : t('git.workingTreeClean')}</span>
                </div>
              )}
            </div>
            {visibleEntries.length < filteredEntries.length ? <ActionButton type="button" className="git-show-more" onClick={() => setVisibleCount(c => c + 250)}>{copy.showMore}</ActionButton> : null}
          </div>
        )}
      </section>
    </div>
  );
}
