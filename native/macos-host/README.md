# lnwjud macOS native host

This helper is a signed, least-privilege companion inside the macOS app bundle.
It speaks bounded newline-delimited JSON on stdin/stdout. `stdout` contains only
request responses; diagnostics belong on `stderr` or the host activity log.

The TypeScript bridge verifies the staged SHA-256/size manifest before spawning
the helper, passes one request ID per operation, and owns cancellation through a
verified process group. Capability providers must still enforce authorization,
Active Project path scope, and user-visible macOS permission state.

The first native provider slice includes permission-aware CoreGraphics window
observation, bounded AX tree observation and semantic control actions against
freshly-resolved elements, AX mutations that preserve explicit window selectors,
governed CGEvent input,
bounded screenshot/ImageIO/Vision OCR and image annotation, with separate
helper boundaries for accessibility, window, input, capture, Vision, audio,
and screen-recording work. Audio, screen recording, and Office remain
explicitly dependency-gated until their provider ownership and signed
real-device acceptance cover restart and permission contracts.

Run `swift test --package-path native/macos-host` on macOS. Regression tests
exercise the executable's NDJSON loop, CF type validation, numeric JSON values,
lossless Unicode event construction, image decoding/annotation, AX read-result
forwarding, and unique window matching without posting input to the desktop.
Explicit windows are matched within the owner process using their CoreGraphics
bounds and title; missing or ambiguous AX matches fail without falling back to
the focused window. Real TCC grants, multi-window actions, and capture still
require an interactive macOS acceptance run.
