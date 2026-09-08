# Native provider development

lnwjud keeps the MCP/domain/storage/UI core shared. Native code is a narrow,
integrity-bound adapter selected at the Desktop/STDIO composition root. A
provider must report its dependency and permission state; a transport health
response alone is never capability readiness.

## Native-host protocol

The macOS Swift host and Linux Rust host use bounded newline-delimited JSON:

```json
{"id":"request-id","operation":"health","input":{}}
```

Responses contain the same `id`, an `ok` boolean, and either a bounded `value`
or a sanitized `{code,message,recoverable}` error. Each NDJSON line is limited
to 16 MiB to leave headroom for the bounded 8 MiB PNG/base64 capture payload;
operation names are allowlisted, and stdout contains response JSON only.
The TypeScript bridge matches concurrent responses by ID, uses no shell, times
out/cancels through the owned process tree, and verifies the helper's canonical
path, size, and SHA-256 before release-mode startup.

Implementations must not accept arbitrary shell strings, paths outside the
authorized Active Project, privilege escalation, setuid behavior, or API keys.
Do not log request payloads. Unknown operations and malformed input fail closed.

## Build and test on the target host

macOS (run on macOS 13+):

```text
swift test --package-path native/macos-host
swift build -c release --package-path native/macos-host
```

Linux (run on Linux):

```text
cargo test --manifest-path native/linux-host/Cargo.toml --locked
cargo build --release --manifest-path native/linux-host/Cargo.toml --locked
```

The Desktop scripts stage the target binary under
`apps/desktop/build/native-host/<platform>/<arch>/`, write `NATIVE_HOST.json`,
and record the executable hash/size. Release builds must stage each
architecture independently; do not copy a host binary across OSes or claim
arm64 parity without matching runtime artifacts.

The bundled OpenAI `tunnel-client` is accepted only after the pinned archive
hash, executable version, and Sigstore provenance all verify. Packaging hosts
must provide `cosign` version 3.1.3 or newer (or set `LNWJUD_COSIGN_PATH` to an
equivalent trusted installation); a missing or old verifier fails closed.

## Provider readiness rules

1. Add a platform-specific provider only in the platform capability backend;
   do not instantiate Windows bridges on macOS/Linux.
2. Add a deterministic fixture test for missing dependency, permission denial,
   cancellation, timeout, path scope, and successful health/readiness.
3. Return `available`, `ready`, `readinessReason`, dependency, permission, and
   runtime evidence separately.
4. Keep user confirmation and Active Project/Full Bypass semantics unchanged.
5. Add a support-contract row and packaging/evidence check before changing a
   capability from dependency-gated to native/ready.

The native hosts are intentionally incremental. The current macOS slice has
permission-aware CoreGraphics window observation, governed CGEvent input,
bounded CoreGraphics/ImageIO/Vision capture, and explicit status gates for
semantic AXUIElement actions, audio, screen recording, and Office. The Linux
slice has bounded X11 window/input operations and a bounded AT-SPI2 `gdbus`
observer (with a real registry probe, depth/item limits, and no shell), while
Wayland portal, capture/media, and Office operations remain dependency-gated.
Remaining actions still report `provider_not_implemented` or
`unsupported_platform` until their real target-host implementation and
packaged acceptance evidence exist. That is safer than shipping a green health
check without the corresponding AXUIElement, portal, ScreenCaptureKit,
PipeWire, or Office implementation.

## Review and release boundaries

Native code changes require source review, dependency/license evidence,
integrity-manifest tests, and target-host acceptance. PR/local builds may be
unsigned or ad hoc and are not releasable. Never place signing credentials,
Keychain/Secret Service data, tunnel keys, or local absolute paths in source,
fixtures, provenance, or support bundles.
