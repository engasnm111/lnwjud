import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitFileTree } from '../src/renderer/features/git/GitFileTree.js';
import type { GitStatusEntrySummary } from '@lnwjud/ipc-contracts';
import { buildGitFileTree } from '../src/renderer/features/git/git-file-tree.js';
import { formatGitHunkLabel } from '../src/renderer/features/git/SplitDiffViewer.js';

const entry = (path: string): GitStatusEntrySummary => ({
  path, kind: 'modified', indexStatus: ' ', worktreeStatus: 'M',
});

describe('Git file explorer tree', () => {
  it('builds nested folders with exact descendant counts, preserving file path and type', () => {
    const tree = buildGitFileTree([
      entry('apps/desktop/src/App.tsx'),
      entry('apps/desktop/tests/App.test.ts'),
      entry('README.md'),
      entry('apps/desktop/src/Z.ts'),
    ]);
    expect(tree[0]).toMatchObject({ type:'folder', path:'apps', count:3 });
    expect(tree[1]).toMatchObject({ type:'file', path:'README.md' });
    const apps = tree[0];
    if (apps?.type !== 'folder') throw Error('expected apps folder');
    const desktop = apps.children[0];
    expect(desktop).toMatchObject({ type:'folder', path:'apps/desktop', count:3 });
    if (desktop?.type !== 'folder') throw Error('expected desktop folder');
    expect(desktop.children.map((node) => node.name)).toEqual(['src','tests']);
    const src = desktop.children[0];
    if (src?.type !== 'folder') throw Error('expected src folder');
    expect(src.children.map((node) => node.name)).toEqual(['App.tsx','Z.ts']);
  });
  it('automatically renders changed files inside every nested folder and supports manual collapse/search expansion', () => {
    const tree = buildGitFileTree([entry('apps/desktop/src/renderer/styles.css')]);
    const render = (collapsedFolders: ReadonlySet<string>, searchActive = false): string => renderToStaticMarkup(
      GitFileTree({ nodes: tree, locale: 'th', collapsedFolders, searchActive,
        onToggle: () => undefined, onOpen: () => undefined }),
    );
    expect(render(new Set())).toContain('styles.css');
    expect(render(new Set(['apps/desktop']))).not.toContain('styles.css');
    expect(render(new Set(['apps/desktop']), true)).toContain('styles.css');
  });
  it('normalizes backslashes without losing the source entry path', () => {
    const tree = buildGitFileTree([entry('src\\feature\\index.ts')]);
    const src = tree[0];
    if (src?.type !== 'folder') throw Error('expected src');
    const feature = src.children[0];
    if (feature?.type !== 'folder') throw Error('expected feature');
    expect(feature.children[0]).toMatchObject({ type:'file', path:'src\\feature\\index.ts' });
  });
});

describe('Git diff human hunk headers', () => {
  it('retains inclusive old and new line ranges in Thai and English', () => {
    expect(formatGitHunkLabel('@@ -13,7 +13,7 @@ exported function', 'th'))
      .toBe('ช่วงที่เปลี่ยน • ก่อนแก้ 13–19 / หลังแก้ 13–19');
    expect(formatGitHunkLabel('@@ -0,0 +1,5 @@', 'en'))
      .toBe('Changed range • Old — / New 1–5');
    expect(formatGitHunkLabel('@@ -44 +46 @@', 'en'))
      .toBe('Changed range • Old 44 / New 46');
    expect(formatGitHunkLabel('unknown', 'th')).toBe('unknown');
  });
});
