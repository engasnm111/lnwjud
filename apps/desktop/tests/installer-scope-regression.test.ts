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

  it('warns about missing protected service in per-user installs and rejects unattended degraded installs', () => {
    expect(installerScript).toContain('Current-user mode cannot install the protected Windows containment service');
    expect(installerScript).toContain('IfSilent unsupportedPerUserSilent 0');
    expect(installerScript).toContain('SetErrorLevel 125');
    expect(installerScript).toContain('acknowledgedPerUserMode:');
  });

  it('rejects silent per-user install in NSIS initialization before any files are extracted', () => {
    const init = installerScript.slice(installerScript.indexOf('!macro customInit'), installerScript.indexOf('!macroend'));
    expect(installerScript.indexOf('!macro customInit')).toBeGreaterThanOrEqual(0);
    expect(init).toContain('${if} $installMode == "CurrentUser"');
    expect(init).toContain('${if} ${Silent}');
    expect(init).toContain('SetErrorLevel 125');
    expect(init).toContain('Abort');
    expect(installerScript.indexOf('!macro customInit')).toBeLessThan(installerScript.indexOf('!macro customInstall'));
  });

  it('keeps silent update uninstall from waiting on the user-data prompt', () => {
    const silentGuard = installerScript.indexOf('IfSilent keepData 0');
    const prompt = installerScript.indexOf('MessageBox MB_YESNO|MB_ICONQUESTION');
    expect(silentGuard).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(silentGuard);
  });

  it('keeps service installation and removal failures non-interactive in silent updates', () => {
    const serviceInstall = installerScript.slice(
      installerScript.indexOf('nsExec::ExecToStack \'"$INSTDIR\\resources\\native-containment\\lnwjud-containment.exe" service-install\''),
      installerScript.indexOf('; Resolve the shortcut'),
    );
    const serviceUninstall = installerScript.slice(
      installerScript.indexOf('nsExec::ExecToStack \'"$INSTDIR\\resources\\native-containment\\lnwjud-containment.exe" service-uninstall\''),
      installerScript.indexOf('  Delete "$SMPROGRAMS\\lnwjud.lnk"'),
    );

    expect(serviceInstall).toContain('Pop $0');
    expect(serviceInstall).toContain('Pop $1');
    expect(serviceInstall).toContain('SERVICE_INSTALL_UNEXPECTED');
    expect(serviceInstall).toContain('reason $1');
    expect(serviceInstall).toContain('IfSilent silentInstallFailure 0');
    expect(serviceInstall).toContain('silentInstallFailure:');
    expect(serviceInstall).toContain('SetErrorLevel $0');
    expect(serviceUninstall).toContain('Pop $0');
    expect(serviceUninstall).toContain('Pop $1');
    expect(serviceUninstall).toContain('SERVICE_REMOVE_UNEXPECTED');
    expect(serviceUninstall).toContain('reason $1');
    expect(serviceUninstall).toContain('IfSilent silentUninstallFailure 0');
    expect(serviceUninstall).toContain('silentUninstallFailure:');
    expect(serviceUninstall).toContain('SetErrorLevel $0');
  });
});
