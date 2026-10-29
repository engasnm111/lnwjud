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

  it('keeps service installation and removal failures non-interactive in silent updates', () => {
    const serviceInstall = installerScript.slice(
      installerScript.indexOf('ExecWait \'"$INSTDIR\\resources\\native-containment\\lnwjud-containment.exe" service-install\''),
      installerScript.indexOf('; Resolve the shortcut'),
    );
    const serviceUninstall = installerScript.slice(
      installerScript.indexOf('ExecWait \'"$INSTDIR\\resources\\native-containment\\lnwjud-containment.exe" service-uninstall\''),
      installerScript.indexOf('  Delete "$SMPROGRAMS\\lnwjud.lnk"'),
    );

    expect(serviceInstall).toContain('IfSilent silentInstallFailure 0');
    expect(serviceInstall).toContain('silentInstallFailure:');
    expect(serviceInstall).toContain('SetErrorLevel $0');
    expect(serviceUninstall).toContain('IfSilent silentUninstallFailure 0');
    expect(serviceUninstall).toContain('silentUninstallFailure:');
    expect(serviceUninstall).toContain('SetErrorLevel $0');
  });
});
