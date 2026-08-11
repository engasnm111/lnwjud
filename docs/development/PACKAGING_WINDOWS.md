# Windows packaging

The desktop package is built with Electron and packaged as an x64 NSIS installer. The packaged application uses Electron's bundled Node runtime; a system Node installation is not required after installation.

## Build

From the repository root in PowerShell:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 package:windows
```

The script builds the main/preload/renderer bundles and writes the installer to `apps/desktop/dist/installers/`.

The package configuration keeps `asar` enabled, includes the three built runtime bundles, the desktop package manifest, and the Windows capability bridge resource, and targets x64 NSIS. The installer is per-user, allows the install directory to be selected, and removes application data when the user explicitly uninstalls.

The MVP installer is unsigned and does not edit the executable icon. `signAndEditExecutable: false` avoids requiring a Windows symlink privilege for electron-builder's signing cache; production signing can be enabled when a project-owned certificate and CI secret policy are available.

## Clean-machine smoke

Use a clean Windows account or VM with no repository checkout and no system Node requirement:

1. Install the generated `lnwjud-Setup-*.exe`.
2. Launch lnwjud and confirm the dashboard opens with the Electron security settings intact.
3. Add a disposable workspace and confirm its canonical path appears after restart.
4. Run Doctor and confirm the SQLite database check and platform checks are reported.
5. Close the app, uninstall it from Windows Settings, and confirm the application and user data are removed according to the uninstall policy.

Record installer path, OS architecture, launch result, database creation, workspace add, Doctor result, and uninstall result. Do not record credentials, environment variables, or full terminal history.
