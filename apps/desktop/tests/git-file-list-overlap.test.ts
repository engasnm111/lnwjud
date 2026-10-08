import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Git file list constrained scrolling', () => {
  it('keeps each folder header and file row at intrinsic height instead of compressing them into each other', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const folders = css.match(/\.git-folder-group\s*\{([^}]*)\}/)?.[1] ?? '';
    const rows = [...css.matchAll(/\.git-file-item\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '').join(' ');
    const scroller = css.match(/\.git-file-list\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(folders).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(folders).not.toMatch(/position\s*:\s*sticky/);
    expect(rows).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(scroller).toMatch(/overflow\s*:\s*auto/);
  });
});
