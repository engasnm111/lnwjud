# v5.9.0 automatic update transaction

## Problem

The current v5.9.0 source keeps automatic updates unavailable: `initAutoUpdater()` does not configure or start Electron's updater because `automaticCapability()` reports `TRANSACTION_BOOTSTRAP_ONLY`. The requested product flow confirms the exact target version once; after acceptance, it waits for active work, drains renderer IPC, stops the enrolled Tunnel, installs without further installer clicks, and relaunches. Operating-system authorization remains in force. The Windows transaction store and maintenance admission broker described here have isolated native tests, but production does not call either one. The separate package handoff does not prove authenticated enrollment, global maintenance admission, post-restart health, or trusted rollback. The current unsigned installation cannot establish a production trust identity.

Any release **that enables automatic installation** must remain blocked until a real signed update and an injected-failure rollback pass on each advertised platform. The separately scoped v5.9.0 manual-install release does not enable this feature or claim these receipts, and excludes macOS until #216 is accepted. Local tests, package provenance, or a release receipt fixture do not prove those operations. The release verifier currently refuses every structurally valid updater receipt because it cannot authenticate the producer; matching self-reported fields against package provenance is not proof of an observed update. This guard must be replaced only by a verified target-native producer and independent evidence validation.

## Usage

The Electron main process owns update offers and user intent. It does not receive a package path or ask a privileged process to execute a caller-provided command.

```ts
const capability = await updateTransactions.capability();
if (capability.kind !== 'available') {
  patchUpdateStatus({ phase: 'unavailable', canInstall: false, message: capability.reason });
  return;
}

// One explicit user confirmation of this exact displayed version authorizes
// the package handoff; the installer must not ask for Next/further interaction.
const outcome = await updateTransactions.request({
  releaseId: offer.releaseId,
  requestId: randomUUID(),
  mode: 'confirmed',
});
```

Before writable startup, the main process asks the installed authority to reconcile any interrupted transaction. A held result prevents the normal runtime and Tunnel from starting. After startup, the app can report one challenge-bound readiness observation. The authority independently checks the process image, version, application health, and Tunnel connection before it commits.

## Shape

The caller sees one `UpdateTransactions` interface. The service owns package authentication, the transaction journal, slot selection, restart supervision, health checks, and rollback.

```ts
type UpdateCapability =
  | { readonly kind: 'unavailable'; readonly reason: UpdateRefusal }
  | { readonly kind: 'available'; readonly installedVersion: string };

type UpdateRequest = {
  readonly releaseId: ReleaseId;
  readonly requestId: RequestId;
  readonly mode: 'confirmed';
};

type RequestOutcome =
  | { readonly kind: 'unavailable'; readonly reason: UpdateRefusal }
  | { readonly kind: 'deferred'; readonly reason: 'activity' | 'tunnel' | 'maintenance' }
  | { readonly kind: 'accepted'; readonly transactionId: TransactionId };

type StartupDisposition =
  | { readonly kind: 'normal' }
  | { readonly kind: 'health-check'; readonly transactionId: TransactionId; readonly challenge: string }
  | { readonly kind: 'held'; readonly reason: UpdateRefusal };

interface UpdateTransactions {
  capability(): Promise<UpdateCapability>;
  request(input: UpdateRequest): Promise<RequestOutcome>;
  recoverBeforeStartup(): Promise<StartupDisposition>;
  reportReady(input: { transactionId: TransactionId; challenge: string; observedVersion: string }): Promise<void>;
  status(transactionId: TransactionId): Promise<TransactionStatus>;
}
```

The IPC adapter parses external strings into bounded domain values. The pipe protocol and storage records stay private. An `available` result requires a signed enrollment identity, a protected installed authority, production admission, and a qualified target platform. The current app has none of these, so it continues to return `unavailable`.

The service stores one typed state for each enrolled installation. Valid states include `Idle`, `Fetching`, `Staged`, `Closing`, `Sealed`, `Switching`, `AwaitingHealth`, `RollingBack`, `Committed`, `Restored`, and `Held`. Only the service writes `transaction.json` and `active-slot.json`. Every publication records the prior digest, flushes the staged bytes, atomically replaces the current record, and verifies the published file identity and digest. Corrupt or conflicting state becomes `Held`.

`AuthenticatedOffer` can be created only after release-envelope, provenance, signer, sequence, package-digest, and compatibility checks pass. `VerifiedSlot` can be created only after extraction and signed-file checks pass. `SealedAdmission` can be created only after every registered writer has stopped and the containment authority proves native Job completion. `HealthyBoot` can be created only after the service binds the candidate process image, slot, version, runtime probes, and Tunnel result to its one-use challenge.

The current schema-2 native selection and journal records require the complete application slot and immutable data-generation pair. Candidate activation, retry, successor validation, interrupted publication and predecessor restoration compare both identities and manifest digests. Unpaired schema-1 records are refused. These records do not capture or verify actual data. The current data path mixes generation contents with stable ownership records, while shared Tunnel profiles are resolved separately. Production must complete the [mutable-data inventory and startup admission contract](../codebase/2026-10-25-v5.9.0-updater-transaction-architecture.md) before it can select or roll back a real generation.

The service fetches a release by authenticated identity. It never accepts a package path, URL, executable, shell, or generic file operation from the UI. It keeps the previous slot immutable while it selects the candidate. It starts the exact candidate through a stable launcher, checks the candidate after restart, and commits only after independent health and Tunnel probes pass. If any required check fails, it selects the prior slot, restarts it, and verifies its version, health, and Tunnel state. Failed rollback leaves the installation held with admission closed.

The Tunnel snapshot contains only whether Tunnel was enabled, whether it was connected, and a digest of the selected profile. It never stores a credential. If Tunnel was stopped before the update, rollback leaves it stopped. If it was connected, the service restores the same profile and requires an ordinary-client connection check. When the native authority is implemented, Windows explicit Stop, an accepted updater handoff, and confirmed Factory Reset may use the current ID of a verified app-owned alias only after the pinned native helper validates owner, alias ID/PID, and process identity under the shared client state lock. Automatic reconciliation remains strict when saved and live Tunnel IDs differ. A mismatched update handoff without the verified native route fails closed, and platforms that lack that route do not stop by guessing.

Workspace mutations still require the current rolling `goalLease`, including when Full Bypass is enabled. Maintenance admission does not grant or replace a Goal lease. Updates defer while a Goal or other writer has live or unknown activity.

## Synthesis decision

The [26 October continuation of the selected transaction design](../codebase/2026-10-25-v5.9.0-updater-transaction-architecture.md) is authoritative. One stable native authority owns admission, paired application/data selection, process lifetime, health and rollback. Session presentation and Electron do not become independent transaction owners. Keep transport and storage details behind that authority's typed interface. Retain exact Tunnel restoration, rolling Goal-lease checks and explicit recovery at every publication boundary. This supersedes the earlier candidate labels; it does not authorize a second admission service or transaction recovery in the Electron facade.

The public interface hides package formats, privileged transport, journal revisions, slot files, and rollback phases. Callers still provide release identity and user intent, and they handle unavailable or deferred outcomes. Those are product decisions; implementation details remain with the service.

## Tradeoffs accepted

- We accept a signed stable launcher and installed service in exchange for a protected switch point and recovery after Electron exits.
- We accept two immutable application slots and delayed cleanup in exchange for rollback to the exact prior image.
- The user confirms the exact target version once; the package then installs silently without installer Next pages and relaunches. This path is not accepted on a platform until that platform passes its own signed host tests. Operating-system security authorization remains in force.
- We accept target-native CI and signing requirements in exchange for receipts based on real installation, restart, health, Tunnel, and rollback observations.
- We accept that the existing unsigned installation cannot enroll itself as a production trust root.

## Alternatives considered

An in-place NSIS update reuses the current install layout, but it exposes shutdown timing, partial replacement, registry reversal, and rollback to Electron. It does not provide one protected owner that can recover after Electron exits.

A per-user updater avoids a machine service, but it cannot safely replace the existing `Program Files` installation and would need a separate identity and migration path.

The native worker alone cannot own installation while it remains a short-lived child of Electron. The worker may keep bounded protocol and recovery code, but the installed service must own the transaction across shutdown and restart.

## Implementation reconciliation

The current worker constructs `UpdateWorkerCore` and an `UpdateTransactionStore` under the same native lock. It reads transaction and selection records and can finish only a validated staged publication during recovery. Nonterminal, conflicting or unverified state remains held. These bounded store operations do not install a package. The admission broker has no production enrollment, and `automaticCapability()` still reports `TRANSACTION_BOOTSTRAP_ONLY`.

The native helper has separate read-only `service-enroll-preflight <absolute-package-directory>` and `service-enroll-attestation-preflight` commands. The first authenticates detached enrollment metadata against the signed release envelope and checks pinned installer and provenance hashes. The second retains the package and performs bounded attestation verification with a fixed verifier. Initial authentication does not fabricate a predecessor baseline. Existing offer and recovery baseline/replay checks remain intact. Both commands return `readyToEnroll:false`; real hosted attestation, protected installed-tree verification, intended-user binding and native acceptance are still missing. The empty embedded production policy refuses with `RELEASE_TRUST_UNCONFIGURED`. Existing `service-install` and NSIS behavior are unchanged.

No production updater enrollment, stable launcher, authenticated transaction installation path, rollback supervisor or CI receipt producer exists. The Desktop gate therefore keeps Electron's package updater disabled. The explicit-consent package handoff is not reachable as an available update flow.

Any implementation that changes the caller outcomes, transaction phases, signer rules, Tunnel contract, Goal ownership, or module boundaries must update this document before the next implementation unit uses the changed contract. Both the protected native transaction capability and Electron update entry point remain unavailable while these items remain incomplete.

## Open questions and risks

- How will the provisioned protected GitHub signing key be independently verified, rotated and recovered, and which signed enrollment package will establish the first protected Windows installation identity?
- Can the current per-machine NSIS installation migrate to a stable launcher without changing shortcuts, uninstall behavior, file associations, or user data?
- Which immutable files belong in the application slots while the service and launcher remain stable?
- Which Windows, macOS, and Linux hosts can run the signed install, restart, health, Tunnel, and rollback acceptance jobs?
- Which independent MCP client will prove Tunnel connectivity during host acceptance?

## Next implementation step

Validate the bounded artifact-attestation verifier against real protected build evidence and add native binding of the authenticated layout to the actual installation and intended user. Publish no enrollment or accepted baseline until that evidence exists. Then implement the stable launcher and startup admission, including ordinary MCP STDIO handles, and verify actual Windows app/data selection before adding package-install execution. The selected launcher design still needs a trusted whole-Job recovery proof after authority loss; an unknown outcome remains held.
