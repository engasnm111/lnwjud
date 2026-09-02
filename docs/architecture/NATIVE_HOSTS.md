# Native Host Architecture

## Decision

Use one shared TypeScript/Electron/MCP core with platform-specific providers selected once at composition time. Do not fork the application by OS and do not scatter platform checks through domain/application code.

### Windows

Keep the existing PowerShell/native bridge and Windows OCR provider behind the same platform-provider interfaces until a separate Windows refactor is justified. Cross-platform work must not regress its behavior.

### macOS

Use a small Swift native host for APIs that Electron/Node cannot safely or completely provide. The host owns semantic operations for AXUIElement accessibility, CoreGraphics/AppKit window data, CGEvent governed input, ScreenCaptureKit capture/recording and Vision OCR. TCC permission state is explicit readiness data.

### Linux

Use a small Rust native host for bounded D-Bus/AT-SPI/X11/portal operations where Node/Electron is insufficient. Session composition selects AT-SPI2, X11 and xdg-desktop-portal/PipeWire capabilities according to what the current desktop can prove. Wayland portal consent/session state is part of readiness and cannot be bypassed.

## Protocol

Each helper uses a versioned request/response protocol with:

- request IDs and operation allowlist
- strict schema and payload/output bounds
- timeout/cancellation handling
- stdout reserved for protocol and bounded stderr diagnostics
- no shell command strings and no arbitrary executable launch
- sanitized error taxonomy
- packaged SHA-256/size/version verification before use

A missing, mismatched or untrusted helper produces a typed provider-not-ready result instead of constructing a foreign-platform provider and failing later.

## Composition rule

`process.platform` is allowed in the top-level composition/platform adapter layer. Lower layers consume `PlatformContext` and provider contracts. Unit tests must be able to construct win32/darwin/linux profiles without mutating the real host platform.
