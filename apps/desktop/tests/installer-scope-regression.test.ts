import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const installerScript = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');

describe('Windows installer scope regression', () => {
  it('defaults to protected all-users installation while retaining per-user choice', () => {
    expect(builderConfig).toContain('oneClick: false');
    expect(builderConfig).toContain('perMachine: false');
    expect(builderConfig).toContain('selectPerMachineByDefault: true');
    expect(builderConfig).not.toContain('selectPerMachineByDefault: false');
  });

  it('keeps silent update uninstall from waiting on the user-data prompt', () => {
    const silentGuard = installerScript.indexOf('IfSilent keepData 0');
    const prompt = installerScript.indexOf('MessageBox MB_YESNO|MB_ICONQUESTION');
    expect(silentGuard).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(silentGuard);
  });
});
