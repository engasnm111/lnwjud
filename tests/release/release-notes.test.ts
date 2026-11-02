import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const releaseNotesModuleUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'release-notes.mjs')).href;

describe('standardized GitHub release notes', () => {
  it('keeps changelogs out of the READMEs while preserving exact-version highlights for GitHub Releases', async () => {
    const { extractCuratedHighlights } = await import(releaseNotesModuleUrl);
    const [readme, fullReadme, releaseHistory, packageContents] = await Promise.all([
      readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'FULL_README.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'RELEASE_NOTES.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ]);
    const { version: currentVersion } = JSON.parse(packageContents) as { version: string; };
    const versions = (markdown: string): string[] => Array.from(
      markdown.matchAll(/^### (?:Historical: )?What's new in v([0-9.]+)$/gm),
      (match) => match[1],
    );

    expect(versions(readme)).toHaveLength(0);
    expect(versions(fullReadme)).toHaveLength(0);
    expect(versions(releaseHistory)).toContain(currentVersion);
    for (const version of [currentVersion, '5.8.3', '5.6.1', '4.52.0']) {
      expect(extractCuratedHighlights(releaseHistory, `v${version}`, 'engasnm111/lnwjud')).not.toEqual([]);
    }
  });

  it('reports only actual release-scope targets and manual installation in exact-version notes', async () => {
    const { futureReleaseMetadata } = await import(releaseNotesModuleUrl);
    const releaseScope = JSON.parse(await readFile(path.join(repositoryRoot, 'config/release-scope.json'), 'utf8')) as {
      version: string; targets: string[]; deferredTargets: string[]; automaticUpdaterEnabled: boolean;
    };
    const entries = futureReleaseMetadata('a'.repeat(40), `v${releaseScope.version}`, releaseScope);
    expect(entries.join(' ')).toContain('Windows x64, Linux x64, Linux arm64');
    expect(entries.join(' ')).toContain('Automatic installation is disabled');
    expect(entries.join(' ')).toContain('Targets held from this release: darwin-arm64, darwin-x64');
    expect(entries.join(' ')).not.toContain('target-native Windows, macOS');
  });

  it('classifies conventional entries into the three mandatory sections', async () => {
    const { normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    const sourceBody = `## What's Changed
* feat(action): add optional pr_number input and workflow_run fallback (#1156)
* fix(diff): flag untracked binary files as binary in workspace mode (#1288)
* perf(diff): skip oversized untracked files before reading (#1310)

**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v1.2.3...v1.2.4`;

    const body = normalizeReleaseNotesBody({
      sourceBody,
      repository: 'engasnm111/lnwjud',
      previousTag: 'v1.2.3',
      tag: 'v1.2.4',
    });

    expect(body).toContain('## Features\n\n- feat(action): add optional pr_number input and workflow_run fallback (#1156)');
    expect(body).toContain('## Bug Fixes\n\n- fix(diff): flag untracked binary files as binary in workspace mode (#1288)');
    expect(body).toContain('## Other Changes\n\n- perf(diff): skip oversized untracked files before reading (#1310)');
    expect(body).not.toContain("## What's Changed");
    expect(body).toContain('**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v1.2.3...v1.2.4');
  });

  it('preserves curated historical detail while mapping legacy headings', async () => {
    const { normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    const sourceBody = `## Highlights
- Added a new MCP capability.

## Reliability hardening
- Fixed a process-lifecycle race.

## Windows release assets
- \`lnwjud-Setup-4.8.3.exe\`

**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v4.7.1...v4.8.3`;

    const body = normalizeReleaseNotesBody({
      sourceBody,
      repository: 'engasnm111/lnwjud',
      previousTag: 'v4.7.1',
      tag: 'v4.8.3',
    });

    expect(body).toContain('## Features\n\n- Added a new MCP capability.');
    expect(body).toContain('## Bug Fixes\n\n- Fixed a process-lifecycle race.');
    expect(body).toContain('## Other Changes\n\n- `lnwjud-Setup-4.8.3.exe`');
  });

  it('omits empty categories and collapses duplicate changelog lines', async () => {
    const { normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    const sourceBody = `## Other Changes
- **Full Changelog:** https://github.com/engasnm111/lnwjud/compare/v1.0.1...v1.1.1

**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v1.0.1...v1.1.1`;
    const fallbackBody = `## What's Changed
* docs: clarify setup instructions (#2)

**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v1.0.1...v1.1.1`;

    const body = normalizeReleaseNotesBody({
      sourceBody,
      fallbackBody,
      repository: 'engasnm111/lnwjud',
      previousTag: 'v1.0.1',
      tag: 'v1.1.1',
    });

    expect(body).not.toContain('## Features');
    expect(body).not.toContain('## Bug Fixes');
    expect(body).not.toContain('None.');
    expect(body).toContain('## Other Changes\n\n- docs: clarify setup instructions (#2)');
    expect(body.match(/\*\*Full Changelog\*\*/g)).toHaveLength(1);
  });

  it('fills missing sections from real commits without repeating PR titles', async () => {
    const { normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    const body = normalizeReleaseNotesBody({
      sourceBody: `## Features\n\n- None.\n\n## Bug Fixes\n\n- fix(ci): stabilize release verification by @engasnm111 in https://github.com/engasnm111/lnwjud/pull/10\n\n## Other Changes\n\n- Release v5.6.3 by @engasnm111 in https://github.com/engasnm111/lnwjud/pull/11`,
      repository: 'engasnm111/lnwjud',
      previousTag: 'v5.6.2',
      tag: 'v5.6.3',
      additionalEntries: [
        'fix(ci): stabilize release verification ([`aaaaaaa`](https://github.com/engasnm111/lnwjud/commit/aaaaaaa))',
        'fix: restore Tunnel recovery ([`bbbbbbb`](https://github.com/engasnm111/lnwjud/commit/bbbbbbb))',
        'feat: add clearer setup ([`ccccccc`](https://github.com/engasnm111/lnwjud/commit/ccccccc))',
      ],
    });

    expect(body).toContain('## Features\n\n- feat: add clearer setup');
    expect(body).toContain('## Bug Fixes\n\n- fix(ci): stabilize release verification');
    expect(body).toContain('- fix: restore Tunnel recovery');
    expect(body.match(/fix\(ci\): stabilize release verification/g)).toHaveLength(1);
    expect(body).not.toContain('- None.');
  });

  it('refuses a release whose only entries describe publication metadata', async () => {
    const { normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    expect(() => normalizeReleaseNotesBody({
      sourceBody: '## Other Changes\n\n- Published from the exact successful CI commit `abc`.\n- Release v5.6.5 by @engasnm111 in https://github.com/engasnm111/lnwjud/pull/12',
      repository: 'engasnm111/lnwjud',
      tag: 'v5.6.5',
    })).toThrow('no substantive change notes');
  });

  it('uses version-specific README bullets as readable highlights and resolves repository links', async () => {
    const { extractCuratedHighlights, normalizeReleaseNotesBody } = await import(releaseNotesModuleUrl);
    const readme = `### What's new in v5.6.2\n\n- Old behavior.\n\n### Historical: What's new in v5.6.3\n\n- **Tunnel discovery fixed:** ChatGPT can connect again. See [setup](docs/USAGE_TH.md).\n- **Backup cleanup:** old snapshots follow retention\n  without deleting unrelated data.\n\n### What's new in v5.6.4\n\n- New behavior.`;
    const highlights = extractCuratedHighlights(readme, 'v5.6.3', 'engasnm111/lnwjud');

    expect(highlights).toHaveLength(2);
    expect(highlights[0]).toContain('https://github.com/engasnm111/lnwjud/blob/v5.6.3/docs/USAGE_TH.md');
    expect(highlights[1]).toContain('retention without deleting unrelated data.');
    expect(extractCuratedHighlights(readme, 'v5.6.5', 'engasnm111/lnwjud')).toEqual([]);
    const body = normalizeReleaseNotesBody({
      sourceBody: '## Other Changes\n\n- Release v5.6.3 by @engasnm111 in https://github.com/engasnm111/lnwjud/pull/11',
      repository: 'engasnm111/lnwjud',
      tag: 'v5.6.3',
      highlightEntries: highlights,
    });
    expect(body).toMatch(/^## Highlights\n\n- \*\*Tunnel discovery fixed:/);
    expect(body).not.toContain('None.');
  });

  it('uses current-source change bullets as highlights before the version is published', async () => {
    const { extractCuratedHighlights } = await import(releaseNotesModuleUrl);
    const readme = `### Current source changes in v5.7.4\n\n- High-risk approval dialogs stay on-screen across operating systems.\n- Other native alerts bound oversized error text.`;

    const previewReadme = `### What's new in v5.8.3 (development preview; not yet published)\n\n- Verified files and safer workflows.`;
    expect(extractCuratedHighlights(previewReadme, 'v5.8.3', 'engasnm111/lnwjud')).toEqual([
      'Verified files and safer workflows.',
    ]);
    expect(extractCuratedHighlights(readme, 'v5.7.4', 'engasnm111/lnwjud')).toEqual([
      'High-risk approval dialogs stay on-screen across operating systems.',
      'Other native alerts bound oversized error text.',
    ]);
  });

  it('uses the published comparison base when unpublished tags sit between releases', async () => {
    const { extractPreviousTag } = await import(releaseNotesModuleUrl);
    expect(extractPreviousTag('**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v4.56.1...v4.60.0', 'v4.60.0')).toBe('v4.56.1');
    expect(extractPreviousTag('**Full Changelog**: https://github.com/engasnm111/lnwjud/compare/v4.56.1...v4.60.0', 'v4.61.0')).toBeUndefined();
  });
});
