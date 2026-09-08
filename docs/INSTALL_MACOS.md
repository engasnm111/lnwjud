# Install lnwjud on macOS

This guide covers the v4.56.0 native macOS target. macOS 13 or newer is
supported on both Apple silicon (`arm64`) and Intel (`x64`). The package is
built on macOS for the matching architecture; there is no universal build
claim until every native helper and runtime has been verified as universal.

## Install and verify

1. Download the matching DMG or ZIP from the project release page. Do not
   install an Intel artifact on Apple silicon or the reverse.
2. Before opening it, verify the artifact SHA-256 against the accompanying
   `SHA256SUMS.txt` and verify the release provenance. The bundled tunnel
   client provenance is cryptographically verified with Sigstore during
   packaging. A production release
   must also pass Developer ID, hardened-runtime, notarization, stapling, and
   Gatekeeper checks. An unsigned PR artifact is for development only.
3. Copy `lnwjud.app` to `Applications` and open it. macOS may ask for the
   normal first-launch confirmation.
4. Add an explicit project in Projects. lnwjud never treats `/`, `/Volumes`,
   or a home directory as an implicit trusted project.

The app contains Electron, the target-native ripgrep binary, and the official
OpenAI `tunnel-client` selected for the artifact architecture. A system Node.js
installation is not required for the packaged Desktop app or `lnwjud-mcp-stdio`.

## Permissions

Only enable a permission when the corresponding tool is needed:

- Accessibility for governed input/window actions and (when enabled by a
  future provider slice) semantic AXUIElement observation.
- Screen Recording for screenshots, OCR, or screen recording.
- Microphone for an explicitly requested audio task.
- Automation/Apple Events only for an approved Office action.
- Keychain access is used by Electron `safeStorage`; a denied or unavailable
  Keychain state blocks new persisted secrets rather than falling back to
  plaintext.

Permission prompts are not MCP mutation approval. The existing permission
profile, Active Project, host confirmation, and Full Bypass rules still apply.
Revoking a permission changes the tool to `needs_setup`/`permission_required`
and never to ready.

## MCP and tunnel setup

For local MCP clients, use the packaged executable launcher shown in the app's
MCP panel:

```text
/Applications/lnwjud.app/Contents/Resources/lnwjud-mcp-stdio --workspace /path/to/project
```

The launcher invokes the packaged Electron host with `--mcp-stdio`, preserves
arguments, and keeps stdout reserved for MCP protocol messages. Diagnostics go
to stderr. Use an explicit project path; do not substitute `/` or a mount root.

For ChatGPT Secure MCP Tunnel:

1. Create/authorize the Platform tunnel and runtime key using OpenAI's tunnel
   permissions.
2. In lnwjud Settings, leave the `tunnel-client` override empty so the
   verified bundled client is selected.
3. Save the runtime key through the UI. It is stored using macOS secure
   storage; it is never written to a profile, argv, logs, or environment dump.
4. Configure the tunnel and confirm that it targets the Desktop loopback MCP
   endpoint shown by the app.

The official release source is the
[OpenAI tunnel-client release page](https://github.com/openai/tunnel-client/releases).
If the target asset is absent or its hash/version check fails, tunnel readiness
is dependency-gated and lnwjud does not use an unverified system binary.

## What is intentionally not available

WSL execution/path translation, Windows Registry views, Windows Sandbox,
Windows PDF provider installation, and Outlook/COM actions remain explicit
Windows-only features. They are reported as `unsupported_platform`; they are
not emulated with a lossy macOS substitute.

Office actions that have a tested macOS application provider may remain
dependency-gated. Missing Office or Automation permission does not block the
core MCP, workspace, file, search, Git, backup, and tunnel surfaces.

## Troubleshooting

- **Secure storage unavailable:** unlock/enable the macOS Keychain and restart
  lnwjud. `basic_text` or an unknown backend is never accepted for persisted
  secrets.
- **Accessibility or capture not ready:** grant the requested permission in
  System Settings → Privacy & Security, then restart the app if macOS requests
  it and recheck Doctor.
- **Browser not ready:** install a supported Chrome/Chromium browser and start
  its managed CDP profile. Doctor distinguishes not installed from not running.
- **Tunnel not ready:** use the bundled client, verify the selected tunnel ID,
  and inspect the bounded tunnel diagnostics. Do not paste the API key into a
  shell command or issue report.
- **STDIO client sees no response:** ensure only the launcher is used and that
  stdout is not wrapped by a shell script that prints banners.

To report a problem, include OS version, architecture, artifact version, and
the redacted Doctor error code. Do not include runtime keys, full environment
dumps, private paths, or raw logs containing secrets.
