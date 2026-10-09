import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { releaseNotesForSeries, type ReleaseNote } from '../src/renderer/features/release-notes/release-notes.js';
import { WhatsNewModal } from '../src/renderer/features/release-notes/WhatsNewModal.js';

const note = (version: string): ReleaseNote => ({
  version,
  categories: [{
    id: 'experience',
    titleKey: 'whatsNew.category.experience',
    items: [{ id: version, titleKey: 'whatsNew.581.dropdown.title', descriptionKey: 'whatsNew.581.dropdown.description' }],
  }],
});

describe('What’s New release series', () => {
  it('shows the installed 5.8 patch series newest first without future or older minor notes', () => {
    const versions = ['5.7.4', '5.8.1', '5.8.0', '5.9.0', '5.8.2'];
    expect(releaseNotesForSeries('5.8.1', versions.map(note)).map((entry) => entry.version)).toEqual(['5.8.1', '5.8.0']);
    expect(releaseNotesForSeries('5.8.2', versions.map(note)).map((entry) => entry.version)).toEqual(['5.8.2', '5.8.1', '5.8.0']);
    expect(releaseNotesForSeries('5.9.0', versions.map(note)).map((entry) => entry.version)).toEqual(['5.9.0']);
  });

  it('groups 6.x.x as the same major series and prevents future versions from appearing', () => {
    const versions = ['5.9.2', '6.0.0', '6.1.0', '6.1.3', '6.2.0', '7.0.0'];
    expect(releaseNotesForSeries('6.1.3', versions.map(note)).map((entry) => entry.version))
      .toEqual(['6.1.3', '6.1.0', '6.0.0']);
    expect(releaseNotesForSeries('6.0.0', versions.map(note)).map((entry) => entry.version)).toEqual(['6.0.0']);
    expect(releaseNotesForSeries('5.8.1-beta.1', versions.map(note))).toEqual([]);
  });

  it('renders 5.8.1 and 5.8.0 in one scrollable modal, without older release notes', () => {
    const markup = renderToStaticMarkup(createElement(WhatsNewModal, {
      locale: 'en', version: '5.8.1', onClose: () => undefined,
    }));
    expect(markup).toContain('whats-new-scroll');
    expect(markup.indexOf('>v5.8.1</h3>')).toBeGreaterThan(-1);
    expect(markup.indexOf('>v5.8.0</h3>')).toBeGreaterThan(-1);
    expect(markup.indexOf('>v5.8.1</h3>')).toBeLessThan(markup.indexOf('>v5.8.0</h3>'));
    expect(markup).not.toContain('>v5.7.4</h3>');
    expect(markup).toContain('Remove nonfunctional Tunnel Log filters');
  });
});
