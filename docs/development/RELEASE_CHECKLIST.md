# lnwjud Release Checklist

The canonical release sequence is [RELEASE_PROCESS.md](RELEASE_PROCESS.md). This file keeps the historical checklist path stable for older links and separates operational release sequencing from per-version acceptance evidence.

Use these documents together:

- [RELEASE_PROCESS.md](RELEASE_PROCESS.md) — authoritative `dev -> PR -> main CI -> tag -> Release -> dev sync` sequence and failure handling.
- [../../.github/RELEASE_CHECKLIST.md](../../.github/RELEASE_CHECKLIST.md) — current-version automated and manual acceptance evidence.
- [PACKAGING_WINDOWS.md](PACKAGING_WINDOWS.md) — Windows packaging and clean-machine validation details.

The local authoritative release gate remains:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

Pull-request/non-main CI may use the same gate with `-SkipWindowsPackaging` so expensive NSIS/Portable packaging is not performed twice. A push to `main` must run the full gate, produce the SHA-scoped Windows artifact, and succeed before the version tag is created.

Historical verification records in old planning/handoff documents are evidence only. They do not override the canonical release process above.
