# lnwjud Linux native host

The Linux helper is a small, integrity-bound NDJSON process. It has no shell,
no privilege escalation, no setuid behavior, and no arbitrary file-open API.
The host bridge validates the executable hash/size before launch, bounds every
request and response, and verifies process-group termination on cancellation.

The current provider slices include bounded X11 window/input/capture operations,
a bounded AT-SPI2 `gdbus` observer, and explicit Wayland RemoteDesktop,
screencast, PipeWire, OCR, and optional LibreOffice readiness modules.
AT-SPI/portal/media/Office actions remain dependency-gated until their session
ownership and real-device acceptance contracts are complete; a missing DBus,
portal, keyring, or desktop session never becomes fake-ready.
