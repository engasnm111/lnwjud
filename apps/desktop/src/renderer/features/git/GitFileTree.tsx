import type { CSSProperties, ReactElement } from 'react';
import type { GitStatusEntrySummary, UiLocale } from '@lnwjud/ipc-contracts';
import { ActionButton } from '../ui/UiPrimitives.js';
import type { GitTreeNode } from './git-file-tree.js';
import { v580Strings } from '../../i18n/v580-copy.js';

interface GitFileTreeProps {
  readonly nodes: readonly GitTreeNode[];
  readonly locale: UiLocale;
  readonly collapsedFolders: ReadonlySet<string>;
  readonly searchActive: boolean;
  readonly onToggle: (path: string) => void;
  readonly onOpen: (entry: GitStatusEntrySummary) => void;
}

export function GitFileTree(props: GitFileTreeProps): ReactElement {
  const copy = v580Strings(props.locale).git;
  function renderNode(node: GitTreeNode, depth: number): ReactElement {
    const style = { paddingInlineStart: `${12 + depth * 18}px` } satisfies CSSProperties;
    if (node.type === 'folder') {
      const expanded = props.searchActive || !props.collapsedFolders.has(node.path);
      const title = `${copy.folder} ${node.path} • ${node.count} ${copy.files}`;
      return <div className="git-tree-folder" key={node.path}>
        <ActionButton type="button" role="treeitem" aria-level={depth + 1} aria-expanded={expanded}
          className="git-tree-folder-row" title={title} style={style}
          onClick={() => props.onToggle(node.path)}>
          <span className="git-tree-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <svg className="git-tree-folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5h6l2.4 2.5H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/></svg>
          <span className="git-tree-name">{node.name}</span>
          <span className="git-tree-count">{node.count}</span>
        </ActionButton>
        {expanded ? <div role="group" className="git-tree-children">
          {node.children.map((child) => renderNode(child, depth + 1))}
        </div> : null}
      </div>;
    }
    const entry = node.entry;
    return <ActionButton type="button" key={node.path} role="treeitem" aria-level={depth + 1}
      aria-label={entry.path} title={entry.path} style={style}
      className="git-tree-file-row" onClick={() => props.onOpen(entry)}>
      <span className="git-tree-file-icon" aria-hidden="true">▤</span>
      <span className="git-tree-name">{node.name}</span>
      <span className={`git-file-tag ${entry.kind}`}>{entry.kind.toUpperCase()}</span>
      <span className="git-file-stats">
        {typeof entry.additions === 'number' && entry.additions > 0
          ? <span className="stat-badge stat-add">+{entry.additions}</span> : null}
        {typeof entry.deletions === 'number' && entry.deletions > 0
          ? <span className="stat-badge stat-del">-{entry.deletions}</span> : null}
      </span>
      <span className="git-tree-diff-label">{copy.openDiff}</span>
    </ActionButton>;
  }

  return <div role="tree" aria-label={copy.treeLabel}
    className="git-file-tree">{props.nodes.map((node) => renderNode(node, 0))}</div>;
}
