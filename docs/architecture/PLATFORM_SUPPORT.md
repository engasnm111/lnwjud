# Platform Support Contract

Status: implementation baseline for the macOS/Linux program starting from lnwjud v4.52.0.

## Supported product tiers

| Host | Architectures | Initial tier | Desktop/session contract |
| --- | --- | --- | --- |
| Windows 10/11 | x64 | GA regression baseline | Existing v4.52.0 behavior must remain green |
| macOS 13+ | arm64, x64 | GA target | Native signed app; TCC-gated capabilities report permission state truthfully |
| Ubuntu 24.04 LTS | x64 | GA target | GNOME Wayland and X11 acceptance; KDE Wayland smoke |
| Linux | arm64 | Preview | Promote only when every required bundled runtime and package gate has native arm64 evidence |

Ubuntu 22.04 may be kept as compatibility coverage only after Phase 0/CI proves the pinned Electron/native runtime stack works without weakening the 24.04 contract.

## Stable cross-platform core

The following product surfaces are intended to be supported on every Tier-1 host once their phases land:

- workspace registration, Active Project boundaries, files, search, Git, audit and logs
- durable goals, scheduled continuation and owned background task state
- Local MCP HTTP and direct packaged STDIO entrypoints
- browser/CDP when a compatible browser is available
- Secure Tunnel and OAuth when a verified tunnel-client binary exists for the target triple
- platform-aware Tools/Doctor readiness and remediation

## Native capability disposition

| Capability family | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Accessibility | UI Automation | AXUIElement | AT-SPI2 |
| Input/window automation | Existing native bridge | CGEvent + AX, Accessibility permission | X11 provider; Wayland only through approved portal/session capability |
| Screenshot/OCR | Existing capture + WinRT OCR | ScreenCaptureKit + Vision | Wayland portal/PipeWire or X11 capture; OCR dependency/provider gated |
| Audio/screen recording | Existing provider | AVFoundation/ScreenCaptureKit | PipeWire/portal or session-specific provider |
| Scheduler | Windows Task Scheduler | per-user launchd/LaunchAgent | per-user systemd timers |
| Notifications/dialog/clipboard | Existing provider | Electron/native APIs | Electron/freedesktop/session provider |
| Office | Microsoft Office COM | dependency-gated provider only when exact semantics are implemented | dependency-gated provider only when exact semantics are implemented |
| WSL / Registry / Windows Sandbox | Supported | unsupported_platform | unsupported_platform |

A missing provider is never an internal error and never receives Windows remediation text on another platform. Readiness must distinguish unsupported platform, missing dependency, missing permission, unavailable desktop session, provider not delivered, runtime stopped and inconclusive probe.

## Security invariants

- No platform can weaken Active Project, permission profile, exact-action approval, destructive scope, recovery or audit semantics.
- POSIX `/`, a home directory and a mount root are not implicit trusted mutation roots.
- Process cancellation must verify ownership/identity and completion; uncertain termination remains `termination_unverified`.
- Wayland automation must respect the desktop portal/session model and never advertise unattended control that the compositor does not permit.
- Persisted credentials never fall back to plaintext merely to make a target appear supported.

## Package and update contract

- Windows keeps NSIS x64 and Portable x64 as the regression baseline.
- macOS package candidates are DMG and ZIP for arm64/x64. A CI-produced unsigned package is development evidence only; GA still requires Developer ID signing, hardened-runtime entitlement review, notarization, stapling and clean-machine Gatekeeper acceptance.
- Linux x64 package candidates are AppImage and DEB. AppImage may use application self-update only after native-runner acceptance; DEB remains package-manager-managed and must never be self-replaced by the AppImage/portable updater path.
- `electron-updater` is enabled only for a distribution whose replacement semantics are known: Windows installer/portable, macOS app and Linux AppImage. Unknown Linux layouts and DEB fail closed with explicit package-manager guidance.
- Native macOS/Linux package builds and platform/runtime tests run on their corresponding GitHub-hosted OS runners before their artifacts are treated as portability evidence.

## Release independence

macOS and Linux may progress and be promoted independently. A missing Linux arm64 or optional Office provider must not block macOS or Linux x64 core GA. Windows remains the regression baseline throughout the program.
