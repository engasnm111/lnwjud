# Cross-Platform Packaging and Update Contract

## Target artifacts

| Platform | Architecture | Initial artifacts | Update policy |
| --- | --- | --- | --- |
| Windows | x64 | Existing NSIS Setup + Portable | Existing v4.52.0 channels remain authoritative |
| macOS | arm64, x64 | DMG + ZIP | Signed/notarized release only; update metadata generated from exact-SHA artifacts |
| Linux | x64 | AppImage + DEB | AppImage updater allowed after acceptance; DEB install/update remains explicit/elevation-aware |
| Linux | arm64 | AppImage/DEB preview only after runtime parity | No GA update channel until full target-native evidence exists |

## Native-build authority

Release artifacts are built and verified on their target operating system. Cross-compilation may be useful for developer feedback but is not release evidence for native helpers, signing, entitlements, portals or package installation.

## macOS trust

Production macOS artifacts require a stable Developer ID identity, hardened runtime, least entitlements, notarization and stapling. The same signing identity must be stable across releases so Keychain-backed secret storage does not repeatedly appear as a different application. Unsigned/ad-hoc CI artifacts cannot be promoted as production artifacts.

## Linux trust

The initial supported package formats are AppImage and DEB. AppImage is the primary portable/updateable format. DEB installation may require elevated package-manager flow; lnwjud must not silently bypass package signature/trust policy. Additional Snap/Flatpak/RPM formats require a separate sandbox/portal/update contract before being advertised.

## Runtime assets

Every bundled third-party binary is described by a target-triple manifest recording upstream source, version, license, SHA-256, architecture and packaged path. Release mode does not silently replace a missing verified runtime with an unrelated system binary.

## Release provenance

The existing exact-commit release model is extended, not replaced:

1. target-native CI verifies the exact source commit;
2. each platform job uploads SHA-scoped artifacts plus hashes/provenance;
3. the release/tag workflow reuses only the successful artifact set for that same commit;
4. one platform's successful artifact is never evidence for another platform.

Updater behavior is enabled per distribution only after clean-install and N-to-N+1 rollback/data-preservation acceptance succeeds.
