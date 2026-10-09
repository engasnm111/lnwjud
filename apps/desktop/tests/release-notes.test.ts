import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { releaseNotesForSeries, releaseNotesForVersion, type ReleaseNote } from '../src/renderer/features/release-notes/release-notes.js';

describe('release notes registry', () => {
  it('contains non-empty in-app notes for the current Desktop version', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const note = releaseNotesForVersion(packageJson.version);

    expect(note, `Missing in-app What's New entry for v${packageJson.version}`).toBeDefined();
    expect(note?.categories.some((category) => category.items.length > 0)).toBe(true);
  });

  it('shows all installed v5.8 patch notes newest-first without leaking v5.7 or later minors', () => {
    expect(releaseNotesForSeries('5.8.1').map((note) => note.version)).toEqual(['5.8.1', '5.8.0']);
    expect(releaseNotesForSeries('5.8.0').map((note) => note.version)).toEqual(['5.8.0']);
    expect(releaseNotesForSeries('5.7.4').map((note) => note.version)).toEqual(['5.7.4', '5.7.3', '5.7.2', '5.7.1', '5.7.0']);
    expect(releaseNotesForSeries('5.9.0')).toEqual([]);
  });

  it('sorts version numbers numerically and resets at the next minor or major train', () => {
    const versions = ['5.8.2', '5.8.10', '5.8.9', '5.7.4', '5.9.0', '6.0.0', '6.0.1', '6.1.0', '7.0.0'];
    const notes: readonly ReleaseNote[] = versions.map((version) => ({ version, categories: [] }));
    const names = (installed: string): string[] => releaseNotesForSeries(installed, notes).map((entry) => entry.version);
    expect(names('5.8.10')).toEqual(['5.8.10', '5.8.9', '5.8.2']);
    expect(names('5.8.9')).toEqual(['5.8.9', '5.8.2']);
    expect(names('5.9.0')).toEqual(['5.9.0']);
    expect(names('6.0.1')).toEqual(['6.0.1', '6.0.0']);
    expect(names('6.1.0')).toEqual(['6.1.0', '6.0.1', '6.0.0']);
    expect(names('7.0.0')).toEqual(['7.0.0']);
    expect(names('5.8.10-beta.1')).toEqual([]);
    expect(names('garbage')).toEqual([]);
  });

  it('resolves the exact installed version only', () => {
    expect(releaseNotesForVersion('5.7.0')).toMatchObject({ version: '5.7.0' });
    expect(releaseNotesForVersion('5.6.5')).toMatchObject({ version: '5.6.5' });
    expect(releaseNotesForVersion('5.6.4')).toMatchObject({ version: '5.6.4' });
    expect(releaseNotesForVersion('5.6.3')).toMatchObject({ version: '5.6.3' });
    expect(releaseNotesForVersion('5.6.2')).toMatchObject({ version: '5.6.2' });
    expect(releaseNotesForVersion('5.6.1')).toMatchObject({ version: '5.6.1' });
    expect(releaseNotesForVersion(' 5.6.1 ')).toMatchObject({ version: '5.6.1' });
    expect(releaseNotesForVersion('5.6.0')).toMatchObject({ version: '5.6.0' });
    expect(releaseNotesForVersion('5.5.3')).toMatchObject({ version: '5.5.3' });
    expect(releaseNotesForVersion('5.5.2')).toMatchObject({ version: '5.5.2' });
    expect(releaseNotesForVersion('5.5.1')).toMatchObject({ version: '5.5.1' });
    expect(releaseNotesForVersion('5.5.0')).toMatchObject({ version: '5.5.0' });
    expect(releaseNotesForVersion('5.5.1-beta.1')).toBeUndefined();
    expect(releaseNotesForVersion('5.4.3')).toBeUndefined();
  });

  it('keeps release-note categories non-empty so the modal can hide empty groups deterministically', () => {
    const note = releaseNotesForVersion('5.6.5');
    expect(note).toBeDefined();
    expect(note?.categories.length).toBeGreaterThan(0);
    for (const category of note?.categories ?? []) {
      expect(category.items.length).toBeGreaterThan(0);
    }
  });
});
