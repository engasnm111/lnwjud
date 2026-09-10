import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SplitDiffViewer, parseUnifiedDiff } from '../src/renderer/features/git/SplitDiffViewer';

describe('parseUnifiedDiff', () => {
  it('parses standard git unified diff patch into aligned rows', () => {
    const patch = [
      'diff --git a/file.txt b/file.txt',
      'index 1234567..89abcdef 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2_old',
      '+line2_new',
      '+line2_added',
      ' line3',
    ].join('\n');

    const result = parseUnifiedDiff(patch);
    expect(result.hunks.length).toBe(1);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);

    const rows = result.hunks[0]!.rows;
    // Row 0: context line1
    expect(rows[0]).toEqual({
      oldLineNumber: 1,
      oldText: 'line1',
      oldType: 'normal',
      newLineNumber: 1,
      newText: 'line1',
      newType: 'normal',
    });
    // Row 1: modified (del old, add new)
    expect(rows[1]).toEqual({
      oldLineNumber: 2,
      oldText: 'line2_old',
      oldType: 'deleted',
      newLineNumber: 2,
      newText: 'line2_new',
      newType: 'added',
    });
    // Row 2: extra addition aligned with empty old
    expect(rows[2]).toEqual({
      oldLineNumber: null,
      oldText: '',
      oldType: 'empty',
      newLineNumber: 3,
      newText: 'line2_added',
      newType: 'added',
    });
    // Row 3: context line3
    expect(rows[3]).toEqual({
      oldLineNumber: 3,
      oldText: 'line3',
      oldType: 'normal',
      newLineNumber: 4,
      newText: 'line3',
      newType: 'normal',
    });
  });

  it('handles untracked new files with fallbackNewContent', () => {
    const result = parseUnifiedDiff('', 'line A\nline B');
    expect(result.hunks.length).toBe(1);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
    expect(result.hunks[0]!.rows[0]).toEqual({
      oldLineNumber: null,
      oldText: '',
      oldType: 'empty',
      newLineNumber: 1,
      newText: 'line A',
      newType: 'added',
    });
  });

  it('handles empty diff gracefully', () => {
    const result = parseUnifiedDiff('');
    expect(result.hunks).toEqual([]);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it('renders the actual Git source labels supplied by the caller', () => {
    const markup = renderToStaticMarkup(createElement(SplitDiffViewer, {
      locale: 'en',
      filePath: 'src/app.ts',
      patch: '@@ -1 +1 @@\n-old\n+new',
      oldLabel: 'HEAD',
      newLabel: 'Index (Staged)',
      onClose: () => undefined,
    }));
    expect(markup).toContain('Original (HEAD)');
    expect(markup).toContain('Modified (Index (Staged))');
  });
});
