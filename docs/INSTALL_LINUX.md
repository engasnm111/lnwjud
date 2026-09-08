# Install lnwjud on Linux

The first Linux release target is x64 on Ubuntu 24.04 LTS. GNOME Wayland and
X11 are acceptance sessions; KDE Wayland is a smoke target. Linux arm64 has a
separate target-native artifact in the release matrix but remains preview until
Electron, native host, ripgrep, tunnel-client, optional media dependencies,
package smoke, and provenance all have matching production evidence.

## Install and verify

1. Download the matching x64 AppImage or DEB from the project release page. For
   Linux arm64 preview, choose the `arm64` artifact explicitly.
2. Verify `SHA256SUMS.txt` and the exact-commit provenance before running it.
   The bundled tunnel client is accepted by the build only after cryptographic
   Sigstore verification; a missing verifier fails the package build.
3. For an AppImage, make it executable and launch it from a user-owned path.
   For a DEB, install it with the distribution package manager in a disposable
   test environment before using it with real workspaces.
4. Add a project explicitly in Projects. lnwjud does not auto-register `/`, a
   mount root, or a home directory.

The package includes Electron, target-native ripgrep, the official OpenAI
`tunnel-client`, and the bounded native-host protocol helper. System Node.js is
not required for the packaged Desktop app or the packaged STDIO launcher.

## Desktop session and permissions

Doctor displays the detected session without treating it as permission:

- **X11:** input and capture are limited to the active display session.
- **Wayland:** input and capture require a user-approved portal session. A
  previous approval is not an unattended replay grant.
- **Headless:** core MCP, files, Git, search, logs, backup, and other non-UI
  tools remain usable; UI-native calls are dependency-gated.

The Linux secure-storage backend must be a supported Secret Service/KWallet
provider exposed through Electron `safeStorage`. `basic_text`, `unknown`, a
locked keyring, or temporary unavailability blocks new persisted tunnel and
checkpoint secrets. lnwjud never enables plaintext encryption as a fallback.

For Wayland capture/input, install and run the desktop portal and PipeWire
services required by the desktop environment. Missing DBus, portals, AT-SPI,
or PipeWire is shown as a dependency state, not as a successful capability.

## MCP and tunnel setup

Use the packaged launcher path from the app's MCP panel, for example:

```text
/opt/lnwjud/lnwjud-mcp-stdio --workspace /home/user/project
```

The exact installation path depends on the AppImage/DEB layout. The launcher
executes the packaged Electron host with `--mcp-stdio`, keeps stdout MCP-clean,
and sends diagnostics to stderr. Always pass an explicit project path when
using a new installation.

For ChatGPT Secure MCP Tunnel, configure the Platform tunnel and runtime key
in Settings, keep the `tunnel-client` override empty, and let lnwjud select the
verified bundled client. The key is protected by the host secure-storage
provider and the tunnel targets the Desktop loopback MCP endpoint. The source
of the bundled client is the
[OpenAI tunnel-client release page](https://github.com/openai/tunnel-client/releases).
No tool call downloads an unverified executable or silently falls back to a
system copy.

## Scheduler and platform limits

Scheduled tasks use only the per-user systemd user-unit/timer namespace under
`~/.config/systemd/user/lnwjud-*`. If user systemd is unavailable, the
scheduler is dependency-gated and lnwjud does not mutate cron as a substitute.
The optional desktop autostart setting owns only
`~/.config/autostart/lnwjud.desktop`.

WSL, Windows Registry, Windows Sandbox, Windows PDF provider installation, and
Outlook/COM actions are `unsupported_platform` on Linux. LibreOffice/UNO,
AT-SPI, media, OCR, portals, and browser providers are dependency-gated and do
not block the core MCP surface when absent.

## Troubleshooting

- **Keyring unavailable:** start/unlock the desktop Secret Service or KWallet,
  restart lnwjud, and run Doctor again. Never put a key in a shell variable,
  unit file, or issue report.
- **Wayland action denied:** create a fresh visible portal session from the
  requested tool. A denial is expected to remain `permission_required`.
- **AT-SPI unavailable:** install/enable the `gdbus` utility and accessibility
  bus/service for the current desktop session; pixel capture is not substituted
  for semantic observation. The observer is bounded and reports a dependency or
  permission state when the bus cannot answer.
- **Browser not ready:** install Chrome/Chromium and start the managed CDP
  profile; Doctor distinguishes not installed from not running.
- **Tunnel not ready:** verify the bundled-client manifest, tunnel ID, and
  bounded diagnostics. Do not point the override at an arbitrary executable in
  a production release.

Support reports should contain distro/session type, architecture, version, and
redacted error codes only. Exclude tokens, keyring contents, environment dumps,
private paths, and raw journal output.
