# Native update worker foundation

The selected updater design makes the native worker own a durable update transaction. Electron launches one authenticated packaged child and uses a narrow inherited stdin/stdout protocol. The foundation implements ownership, journal publication, pre-authentication refusal, and recovery. A separate native verifier authenticates release metadata against embedded policy. **Automatic installation is unavailable.** No response permits falling back to the former unattended installer path.

The worker has no installer execution, package download/authentication, signer verification, privileged execution, global MCP/job/Goal admission fence, tunnel stop/restoration, migration, restart/version/health acceptance, or rollback implementation. Its per-store native lock does not prove shared-service quiescence. macOS and other platforms have no native implementation here. Windows Authenticode release acceptance, signed package provenance, production installation, actual power-loss testing, and macOS production acceptance remain open boundaries. Process-kill tests prove process interruption recovery only.

## Launch and trust boundary

`WindowsUpdateWorker.csproj` publishes self-contained Windows x64 `lnwjud-update-worker.exe`; build ID is `lnwjud-update-worker-bootstrap-v1`, protocol is integer `1`.

```text
lnwjud-update-worker.exe --stdio --state-root <absolute internal dataPath/update-transactions> --installation-id <64 lowercase hex>
```

The application resolves these fixed arguments internally, verifies the native pin module against its compiled hash, and holds a native pin on the hash-verified worker until the child closes. Package preparation verifies the manifest; the runtime client does not read or pin that manifest. The installation ID is the host's SHA-256 of the normalized executable path. It is a journal binding, not independent proof of installation ownership. No renderer/MCP command supplies filesystem paths, executables, shell arguments, signer overrides, or arbitrary native actions. There is no listening service or generic SYSTEM execution route. This worker runs as the launching user; it cannot bypass UAC.

The private inherited streams carry one UTF-8 JSON object per LF-terminated line, maximum 65,536 bytes excluding LF. Oversized lines are discarded with bounded memory; a line beyond 1 MiB closes the session. Invalid UTF-8, duplicate fields, unknown fields, non-integer numbers, and malformed identifiers/positions are refused. Only the following commands exist:

```typescript
type ReadCommand = {
  protocol: 1; requestId: string;
  command: 'capabilities' | 'recover' | 'status';
};
type RequestCommand = {
  protocol: 1; requestId: string; command: 'request';
  releaseId: string; policyRevision: number;
  expectedGeneration: string; expectedRevision: string;
};
```

Request/release identifiers are 1–128 ASCII letters, digits, `._-`. Policy revision is an integer in 1..2147483647. Positions are canonical unsigned 64-bit decimal strings; leading zeroes are refused. Empty state reports `"0","0"`; uncertain positions report `null,null`. Transaction IDs are canonical lowercase UUIDs with hyphens (`Guid` format `D`).

Every reply contains `protocol`, `buildId`, `installationId`, `requestId`, `generation`, `revision`, and `result`. A malformed request can have `requestId:null`. Result variants are:

| Kind | Required result fields | Meaning |
| --- | --- | --- |
| `capabilities` | `platform:'windows'`, `architecture:'x64'`, `automaticInstallation:'unavailable'`, `reason:'TRANSACTION_BOOTSTRAP_ONLY'` | No installation support. |
| `none` | `safeToStart:true` | Empty store or terminal refusal; normal startup may proceed. |
| `unavailable` | `safeToStart:true`, `reason:'PACKAGE_AUTHENTICATION_UNAVAILABLE'`, `transactionId`, `phase:'unavailable'` | Durable request refusal before any effect. |
| `recovered` | `safeToStart:true`, `reason:'PREAUTH_OWNER_RECOVERED'`, `transactionId`, `phase:'unavailable'` | Interrupted pre-authentication request safely finished as unavailable. |
| `held` | `safeToStart:false`, symbolic `reason`, optional `transactionId` | Pending, conflicting, corrupt, live/unknown-owner, unsupported-phase, or uncertain state. |
| `error` | symbolic `reason` | Invalid wire request; no requested operation admitted. |

`status` and `capabilities` never advance/recover journal state. `recover` runs before writable application startup. A valid pre-authentication journal has `effects:'none'`; recovery requires the prior owner to be this exact process or proven gone using native PID + creation-time identity. Live or inaccessible owners fail closed. Unknown future phases or possible effects remain held and preserved; they are never rewritten as pre-authentication or rerun.

`request` checks native generation/revision CAS, records `preauth`, then terminal `unavailable`. It accepts only release identity and policy revision, never a caller assertion that a package is authenticated. Duplicate request ID/release/policy tuples return their original transaction outcome without another write, even with their old expected positions. Reusing an ID with different data is refused. A bounded journal retains up to 64 previous request receipts plus the current request; exhaustion refuses a new request without discarding history. Terminal refusal remains nonblocking on subsequent recovery. Later implementation must introduce authenticated package receipts and policy rechecks before any install-capable transition.

## Native persistence

The store contains `owner.lock`, `journal.json`, and optionally `journal.pending.json`. The worker pins each ordinary local directory ancestor with native handles denying delete sharing, rejects reparse points, and verifies the state directory's owner/write ACL. Files are bounded, ordinary, single-link, owner-checked, and refuse broad write ACLs. The lifetime byte-range owner lock is an actual OS lock; a second process returns `OWNER_BUSY`. The lock inode cannot be replaced while held.

The journal binds installation ID, schema, decimal generation/revision, previous file digest, payload digest, native process identity, and phase-specific payload. Digests detect corruption; they do not authenticate a same-account attacker. Journal changes use native write-through file handles, `FlushFileBuffers`, same-directory `MoveFileExW` with replace/write-through flags, and reopened file-identity/digest readback. Recovery validates staged predecessor and successor positions before publishing. Conflicting bytes remain untouched. These primitives do not claim completed hardware/filesystem power-loss certification.

## Verification

From the repository root on Windows:

```powershell
corepack pnpm@10.15.0 prepare:update-worker
corepack pnpm@10.15.0 test:update-worker
corepack pnpm@10.15.0 --filter @lnwjud/desktop build
corepack pnpm@10.15.0 test:update-worker-trust
```

The executable argument can instead point to the separately published packaged worker. Tests launch real separate processes, kill only their own fixture child after durable boundaries, and verify exclusive ownership, owner-death generation fencing, stage/current reconciliation, terminal refusal startup behavior, durable idempotency/CAS, corruption and ambiguous-effect holds, readonly calls, pinned root/lock identity, hardlinks, and junction refusal. Fixtures use isolated OS temporary directories; they never target the user's installed application or Tunnel data.

Production package preparation is owned by `apps/desktop/scripts/prepare-update-worker.mjs`. It does not rebuild or replace the existing containment helper. Test/build success for this foundation must not be reported as a working automatic updater or permission to release.

## Release metadata authentication

The authoritative [metadata contract](release-metadata-contract.md) defines the shared strict producer/consumer schema. The native assembly embeds the exact checked-in `config/update-release-schema.json` and `config/update-release-policy.json`. Production roots and authorities remain empty; a valid disposable test envelope returns `RELEASE_TRUST_UNCONFIGURED` under production policy. No environment, cwd, CLI or stream field supplies a public key or policy override.

`ReleaseMetadataVerifier.VerifyOffer` checks P-256/SHA-256 with fixed P1363 signatures over the domain-separated exact payload bytes, strict shared structure, source/target identities, time/floors, replay/quarantine, exact retained authenticated baseline identities, and compatible recovery contracts. Its immutable result is authenticated **metadata** plus a trust-snapshot-bound receipt. It does not authenticate downloaded package bytes or the operating-system publisher, write acceptance floors, close admission, or launch anything. Historical expired baseline eligibility requires retained original acceptance and explicit current non-revoked key policy; the offer result grants no rollback permission.

`VerifyRecoveryMetadata` additionally requires the exact failed transaction, accepted trust position, quarantined candidate identity, fresh exact recovery authorization and one remaining attempt. It also returns metadata only. Neither method is exposed as a new production stdio operation. Native baseline storage, trusted time acquisition, package acquisition/pinning/publisher validation, and admission integration are later units.

The native test harness accepts this separate **test-only** mode:

```powershell
& native/update-worker/tests/bin/Debug/net8.0/win-x64/Lnwjud.UpdateWorker.Tests.exe metadata-tests E:/lnwjud/tests/fixtures/update-release/metadata-v1.json
```

The tracked fixture contains disposable public policy and Node-signed candidate/baseline bytes; no private key is retained. The real .NET verifier accepts those exact bytes only under the internal test policy and rejects them under the embedded production policy. Shared adversarial byte fixtures run through both decoders. This proves metadata interoperability, not package installation or end-to-end updater acceptance.
