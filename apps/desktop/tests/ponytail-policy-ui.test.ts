import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../src/renderer/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
const settingsCssSource = readFileSync(new URL('../src/renderer/settings-extra.css', import.meta.url), 'utf8');

describe('Ponytail scoped settings UI', () => {
  it('keeps Current Goal text and mode controls in a bounded responsive grid', () => {
    expect(settingsSource).toContain('backup-item ponytail-goal-item');
    expect(settingsSource).toContain('ponytail-goal-copy');
    expect(settingsSource).toContain('settings-select ponytail-goal-select');
    expect(settingsCssSource).toContain('grid-template-columns: minmax(0, 1fr) minmax(180px, 240px)');
    expect(settingsCssSource).toContain('@media (max-width: 760px)');
    expect(settingsCssSource).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
