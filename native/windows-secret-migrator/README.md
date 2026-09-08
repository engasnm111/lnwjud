# Windows secret migrator

`lnwjud-windows-secret-migrator.exe` is a one-time, Windows-only compatibility
helper for v4.44.0 legacy secrets. It reads one JSON request per line and
returns one JSON response per line on stdout. It calls `CryptUnprotectData`
directly for the current Windows user; it never starts PowerShell and never
writes plaintext to stdout, stderr, logs, or arguments.

Supported operations:

- `dpapi_v2` — `ciphertextBase64` is the v2 UTF-8 DPAPI payload.
- `secure_string_v1` — `ciphertextHex` is the legacy
  `ConvertFrom-SecureString` DPAPI payload, whose decrypted bytes are UTF-16LE.

The output contains only `plaintextBase64` so the TypeScript coordinator can
immediately re-encrypt the value with Electron `safeStorage`.
