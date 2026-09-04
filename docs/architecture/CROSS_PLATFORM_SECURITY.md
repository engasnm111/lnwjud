# Cross-Platform Secret and Security Architecture

## Decision

Use a `SecretStore` abstraction in shared/runtime composition and keep platform cryptography outside domain/application code.

Desktop secret protection uses Electron's asynchronous `safeStorage` API after `app.whenReady()` because it maps to OS-provided stores, is non-blocking and exposes key-rotation/temporary-unavailability behavior. Windows compatibility keeps legacy DPAPI data readable during migration. macOS uses Keychain through the signed application identity. Linux accepts only a secure secret backend such as Secret Service/KWallet/portal-backed storage; `basic_text`, unknown-before-ready or temporary unavailability are not treated as secure persisted storage.

The application must never call `safeStorage.setUsePlainTextEncryption(true)` in production.

## Headless/private Node contract

The v4.52.0 packaged direct-STDIO design intentionally uses the bundled private Node runtime to retain stable pipe ownership. That design remains the baseline until a tested ADR supersedes it. Because pure Node cannot directly depend on Electron `safeStorage`, headless/private-Node secret access is provided through a narrow platform `SecretStore` provider/helper or by receiving an already-authorized runtime credential from the owning Desktop process. It must not silently create a weaker plaintext file.

Development-only headless execution may accept an explicit injected key/credential intended for CI/test use; production launchers must not invent one.

## Provider contract

A provider reports at least:

- availability and security level
- backend/provider identifier
- temporary unavailability versus permanent unsupported state
- encrypt/store, read/decrypt and delete operations
- key rotation or re-encryption requirement where supported

Secret payloads never appear in logs, argv, process snapshots, release evidence, support bundles or checkpoint metadata.

## Migration

Windows v4.52.0 encrypted checkpoint/tunnel material remains readable. Migration must be atomic, idempotent, retryable and backed up before replacement. A cross-host restore keeps portable state but never pretends Windows DPAPI, macOS Keychain or Linux Secret Service ciphertext is decryptable on another host; the UI requests re-auth while retaining non-secret data.

## Permission and native-helper boundary

Native helpers receive semantic allowlisted operations, bounded structured payloads and no arbitrary shell command. All file paths and destructive intent are authorized in the main policy layer before native dispatch. Helper integrity/version is verified in packaged builds.
