# Windows Defender / SmartScreen false-positive response

lnwjud treats a Microsoft Defender malware detection and a Microsoft Defender SmartScreen reputation warning as two different signals. Neither should be worked around by telling end users to disable Defender or add a permanent exclusion.

## If Defender detects an lnwjud file as malware

1. Record the lnwjud version, exact Defender detection name, Defender engine/security-intelligence version, UTC time, installation type (Setup or Portable), and the SHA-256 of the detected file. Do not collect credentials or unrelated user files.
2. Compare the file against the release `SHA256SUMS.txt` and `PROVENANCE.json`. The provenance file binds the Windows artifacts and packaged runtime hashes to the exact Git commit that produced them.
3. If the hash matches an official artifact/runtime entry, submit the detected file to Microsoft Security Intelligence as a **Software developer** at https://www.microsoft.com/wdsi/filesubmission. For an incorrect malware classification, select the option indicating that you do **not** believe the submitted file contains malware.
4. Record the Microsoft Submission ID (and Case ID if one is issued), submitted SHA-256, submission time, detection name, and final Microsoft analysis outcome in the release incident record.
5. If the file hash does not match the published release evidence, stop treating it as a false positive and investigate artifact integrity before asking the user to run it.

Microsoft's current guidance for software developers is to dispute incorrect detections through the file-submission process. There is no developer allowlist/known-list program. The same official guidance recommends signing program files consistently with a certificate chained to a trusted root so Microsoft can identify the publisher across releases.

## If SmartScreen says Unknown/Unrecognized publisher

SmartScreen reputation is not the same as a Defender malware verdict. Authenticode signing with a stable trusted publisher identity is recommended for non-Store distribution because it improves publisher identity and reputation behavior, but lnwjud does not require a paid signing credential to publish. When production signing secrets are configured, the Release workflow requires Setup and Portable to have `Get-AuthenticodeSignature` status `Valid`; when they are absent, the workflow permits an unsigned release only after the same SHA-256 and source-provenance verification and reports the unsigned status explicitly.

The build pipeline supports electron-builder Authenticode signing through repository secrets:

- `WINDOWS_CSC_LINK` — the production PFX/certificate source accepted by electron-builder.
- `WINDOWS_CSC_KEY_PASSWORD` — its password/secret.

CI maps these only to `CSC_LINK` / `CSC_KEY_PASSWORD` for the packaging step. Secrets, certificates, and private keys must never be committed to the repository or written into provenance files.

For a new signing deployment, Microsoft Artifact Signing (formerly Trusted Signing) is the preferred Microsoft-managed option for non-Store distribution. Migrating to it requires the organization's verified Artifact Signing account/profile and CI credentials; do not substitute a self-signed certificate. Microsoft documents self-signed SmartScreen behavior as equivalent to an unsigned application for reputation purposes.

Signing reduces Unknown publisher/reputation problems but does not guarantee that antivirus heuristics can never produce a false positive. A genuine Defender malware classification should still be submitted separately for Microsoft analysis.

## Release evidence

Every Windows package build produces:

- `lnwjud-Setup-<version>.exe`
- `lnwjud-Portable-<version>.exe`
- `latest.yml`
- `portable.yml`
- Setup blockmap
- `SHA256SUMS.txt`
- `PROVENANCE.json`

`PROVENANCE.json` records the exact source commit and hashes/sizes for the distributed Setup/Portable artifacts plus critical installed runtime files, including:

- `lnwjud.exe`
- `lnwjud-mcp-stdio.cjs`
- `lnwjud-mcp-stdio.cmd`
- `lnwjud-node.exe`
- bundled `rg.exe`
- bundled `tunnel-client.exe`

The release workflow verifies the provenance commit against the tagged commit, requires clean-source provenance, and re-hashes release artifacts before creating a public GitHub Release. It then enforces valid Authenticode only when production signing secrets are configured; otherwise it records and reports the unsigned status rather than blocking the release.

## User support rule

Do **not** use "disable Microsoft Defender", "allow all threats", or a permanent Defender exclusion as the primary support response. First verify the hash/provenance and obtain Microsoft analysis for a suspected false positive. A temporary organization-specific security-policy exception, if ever required, is an administrator decision outside lnwjud's normal support path.
