# Release metadata contract, protocol 1

This is the selected producer/consumer contract for the next implementation unit. It adopts the native consumer sketch's complete previous-package identities, compatibility digests and scoped recovery authorization, and the producer sketch's actual build-attestation verification boundary. The worker remains the sole update lifecycle owner. Metadata authentication alone never permits admission closure, publisher acceptance, installation or rollback. Automatic installation remains unavailable until all later units and actual acceptance pass.

## Signature and structural schema

The exact envelope fields are `protocol`, `keyId`, `payload`, `signature`. Protocol is integer 1. Key ID is 1–64 ASCII letters, digits, dot, underscore or hyphen and selects an embedded root. Payload and signature are canonical padded standard Base64. Signature is exactly 64 bytes of P-256/SHA-256 IEEE-P1363 `r || s`. The signed message is ASCII `lnwjud-update-release-v1`, one NUL byte, and the exact decoded payload bytes. No algorithm negotiation or JSON reserialization occurs during verification.

One tracked `config/update-release-schema.json` defines exact field sets, fixed enum values, primitive bounds and encodings for both implementations. Both decoders consume that resource, rather than maintaining separate structural allowlists. Native embeds it. Domain relationships are checked after structural validation and signature verification. Shared adversarial byte fixtures exercise both decoders. Unsupported schema changes fail closed.

Bounds are 49,152 envelope bytes, 32,768 payload bytes and JSON depth 12. Reject duplicate decoded property names at every depth, unknown/missing/null fields, invalid UTF-8/BOM/surrogates, trailing data, noncanonical Base64, integer exponent/float forms, unrecognized enums and overlong strings before authority is returned. Envelope digest hashes the exact retained outer bytes. Strings carrying identifiers, names and numeric values remain ASCII under the rules below.

## Exact payload fields

All fields listed here are required and every object rejects additional fields.

| Object | Exact fields |
| --- | --- |
| payload | `protocol`, `product`, `policyRevision`, `releaseId`, `channel`, `platform`, `architecture`, `distribution`, `version`, `releaseSequence`, `issuedAt`, `notBefore`, `expiresAt`, `source`, `buildEvidence`, `artifact`, `provenance`, `previous`, `compatibility`, `recoveryAuthorization` |
| source | `repository`, `commit`, `workflow`, `ref`, `runId`, `runAttempt` |
| buildEvidence | `kind`, `artifactAttestationSha256`, `provenanceAttestationSha256`, `sourceTree` |
| artifact/provenance | `name`, `sha256`, `sizeBytes` |
| previous | `version`, `releaseSequence`, `envelopeSha256`, `artifact`, `provenance` |
| compatibility | `migrationContractSha256`, `workerContractSha256`, `serviceContractSha256` |
| recoveryAuthorization | `purpose`, `candidateArtifactSha256`, `candidateReleaseSequence`, `previousEnvelopeSha256`, `previousArtifactSha256`, `previousProvenanceSha256`, `expiresAt`, `maximumAttempts` |

Protocol/product/channel/target are `1`, `lnwjud`, `stable`, `win32/x64/windows-nsis` for the first unit. This target restriction is metadata scope, not installation support. macOS needs its actual native transaction and an explicitly implemented target policy. Release IDs are 1–128 ASCII letters/digits/`._-`.

Version is canonical stable `major.minor.patch`, no leading zeroes, prerelease or build suffixes; each component is bounded to 2,147,483,647. Digests are 64 lowercase hex; current repository commits are 40 lowercase hex. Positions, sequences, run IDs/attempts and sizes use canonical decimal strings bounded to uint64; sequences/run IDs/attempts/sizes are positive. Times are decimal UTC Unix seconds in 0..253402300799. `policyRevision` and `maximumAttempts` are JSON integers, with the latter exactly 1.

Artifact names are exactly `lnwjud-Setup-<version>.exe`; provenance name is exactly `PROVENANCE.json`. They are basenames, never paths/URLs. Production limits cap package size at 2 GiB and provenance at 1 MiB. Source repository is the exact configured `https://github.com/engasnm111/lnwjud`; workflow, ref, immutable builder identity, source commit and selected run/attempt must satisfy configured allowlists. A stable source normally comes from the protected `refs/heads/main` push build selected by existing release promotion, not a tag build invented by the payload.

Build evidence kind is `github-artifact-attestation-v1` and source tree is `clean`. These are authenticated release-authority endorsements of the producer's verified inputs, not independently observed native build-machine facts. Artifact and exact provenance bytes each need actual authenticated build attestations before signing. Attestation digests bind the exact input bundles.

Both candidate and previous artifact/provenance identities include names, sizes and digests. The previous envelope digest binds its exact original authenticated bytes. Recovery purpose is `failed-candidate-only`; its candidate/previous fields must exactly equal their corresponding payload identities and its expiry cannot exceed candidate expiry. It is evidence for one later transaction-bound recovery, not a general downgrade operation.

## Time, baseline and receipts

Protocol 1 issues immediately active offers with `issuedAt == notBefore < expiresAt`. Maximum validity is 86,400 seconds and maximum future issue skew is 300 seconds. Both limits are explicit policy fields and cannot be overridden by a manifest. The producer must provide fresh metadata; expired offers remain unavailable rather than extending their validity locally. An operational refresh mechanism remains necessary before production availability can be claimed.

Native verification requires a native-owned authenticated installed baseline, a trust snapshot with generation/revision, highest accepted sequence, last accepted time and failed candidate digests, and a usable time observation. Missing/uncertain baseline or clock refuses. Time below the retained floor refuses instead of silently using the floor as now. Sequence and version must advance beyond the relevant floor/baseline. Verification returns immutable authenticated metadata and a receipt bound to the snapshot; it never mutates the floor or journal. Later admission must CAS-commit and revalidate actual pinned package/publisher evidence before effects.

An expired historical previous descriptor is eligible only for the signed candidate's fresh exact recovery authorization, retained original authenticated installation acceptance, permitted current key history/revocation, compatible recovery contracts, and this exact failed transaction with its one remaining attempt. There is no `ignoreExpiry` flag. Ordinary expiry, revocation, quarantine and anti-replay floors remain enforced. No retained trust record means no unattended baseline. The current unit does not execute recovery.

## Production trust policy and producer

One tracked `config/update-release-policy.json` is embedded in the native assembly and consumed by the producer. Initial release roots, target/source authorities and verifier authority are empty/unconfigured. Production refuses `RELEASE_TRUST_UNCONFIGURED`; it never generates keys, loads public roots from environment/cwd/CLI, adopts downloaded keys or enables test roots. A configured P-256 root has exact key ID, canonical DER SPKI plus digest, allowed release/recovery roles, bounded validity and revocation state. Its explicit `allowHistoricalRecovery` flag defaults to false. Historical verification requires retained original native authenticated acceptance time and identity, that permission and a currently non-revoked historical root; the fresh candidate's release/recovery root must still be currently active. Unsupported rotation or policy revision refuses. Initial root provisioning and protected signer custody are explicit operator work.

The production producer starts a fixed hash/version-pinned GitHub attestation verifier against the actual artifact and exact provenance bytes/bundles. It accepts no saved verification-result JSON, caller `verified` boolean, arbitrary verifier executable/path or identity override. The verified certificate issuer, repository/source ref/digest, signer/config workflow/digests, GitHub-hosted runner and run/attempt identity must match configured policy and the selected exact successful CI source. Subject hashes/names and required verified timestamps are checked. Workflow predicate contents remain workflow-controlled; the audited immutable trusted builder must enforce the clean-source/build contract.

The source authority pins the reusable builder's immutable `builderDigest`. The caller workflow changes with each source release: its explicit `buildConfigDigestRule` is `source-commit`, requiring the authenticated certificate's configuration digest to equal the exact selected source commit and its configuration URI to match the configured caller workflow/ref. Neither an arbitrary future caller digest nor a wildcard is accepted. Unsupported rules refuse.

Only after all evidence subprocesses complete may the producer load its private signing key in process. It derives the public SPKI and requires exact agreement with the configured root, removes the secret environment entry, starts no further subprocess, signs exact payload bytes and verifies its own output. No private key goes into arguments, child environment/stdin, logs, exceptions or files. Output is published only after successful verification, with no partial unsigned envelope or unrelated overwrite.

Production build attestation requires an audited immutable reusable builder that owns checkout of the actual execution SHA, fixed target build/signing, independent clean-source checks and final subject hashing. Grant `contents:read`, `id-token:write`, `attestations:write` only at the appropriate non-PR builder boundary. Release promotion must verify before signing, not merely sign downloaded unsigned provenance. Workflow integration, exact verifier provisioning and issuer/schema compatibility need real evidence; absent authority refuses. Do not invent action revisions, source/builder digests or signing identities.

## Implementation ownership and verification

Producer owner creates shared schema/policy first, Node strict parsing, evidence verification and signing modules, plus focused fixtures. Native owner embeds those exact resources and implements strict metadata/policy/crypto/time/baseline verification. Native stdio retains its current narrow bootstrap commands; no paths, roots or arbitrary verification/install commands are exposed. Test-only policy construction stays inside the friend harness. A valid disposable Node-signed fixture must pass the real .NET verifier and fail production's empty embedded policy.

Both implementations must reject changed bytes, wrong domain/key/curve/signature format, malformed nested data, signed dirty/wrong-source evidence, wrong target/run/builder, time rollback/expiry, replay/quarantine, untrusted previous identity and unauthorized recovery. Missing production authority must leave capabilities unavailable and produce no drain, Tunnel stop, installer, data restore or trust-floor write. Actual native signer/file pinning, global admission, install/relaunch, migration/health, Tunnel restoration and bounded trusted rollback remain required after this metadata unit. The user's no-release-until-actual-updater-acceptance instruction remains in force.
