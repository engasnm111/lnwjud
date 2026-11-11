# Local Goal Event API

The Desktop Host exposes `http://127.0.0.1:17892/api/v1/goal-events/` when secure secret storage and native approval are available. The API publishes metadata from committed Goal repository transitions to an explicitly paired local companion. It has no remote destination or memory-write endpoint.

## Capability and compatibility contract

`GET capabilities` returns `contract: "lnwjud.goal-event.v1"` and supported capabilities. Consumers discover this contract and individual capabilities without checking the application version. An unavailable endpoint, unknown contract, missing capability or invalid response grants no authority. A future incompatible contract uses a different contract identifier; consumers retain their cursor and stop until they support it.

The server binds IPv4 loopback and accepts the exact `127.0.0.1:<port>` Host header. Browser Origin and Fetch Metadata requests are rejected. It exposes no CORS permission. Write requests require `Content-Type: application/json`, exact fields, valid UTF-8 and at most 8 KiB. Responses use `Cache-Control: no-store`. Watcher tokens cannot authenticate this API.

## Pairing and authorization

`POST pair` accepts exactly `workspaceId`, `companionName` and `nonce`. The nonce is a fresh 32-byte random value encoded as unpadded base64url. Names contain 1 to 80 ASCII letters, digits, spaces, periods, underscores or hyphens.

The workspace must be the current Primary Project. A native Host dialog identifies the workspace, companion, nonce SHA-256 and host signing-key fingerprint. Approval is specific to that workspace and subscriber. Full Bypass cannot authorize pairing or publication. A workspace change while the dialog is open cancels enrollment.

The approved response contains `contract`, `subscriber`, a one-time returned bearer `token` and `hostKey`. The companion compares the nonce and host-key fingerprints shown in the native dialog, then durably stores its subscriber ID, workspace ID, authorization epoch and pinned host public key. SQLite stores only the SHA-256 hash of the bearer token. Host private signing keys use a dedicated, purpose-bound `goal_event_signing_key` secret envelope.

Enrollment starts at the current outbox cursor. It does not expose historical events from before enrollment. No events are retained for a workspace without an active subscription. There are at most 32 active subscriptions per Host.

If the pairing response is lost, a repeated request with the same workspace, name and nonce requires a fresh native approval. It reuses the active subscriber and its cursor, rotates the bearer token and advances its authorization epoch. It consumes no additional subscription slot. A revoked enrollment cannot be revived with its old nonce; a new enrollment requires a new nonce and native approval.

Subsequent private requests send `Authorization: Bearer <token>`. `GET events` and `GET subscription` also require a fresh `X-Lnwjud-Goal-Nonce` in the same 32-byte unpadded base64url format. Nonces are request-specific and must never be reused by a consumer.

## Event payload and signature

The event contains exactly these fields, in this canonical JSON order.

| Field | Value |
| --- | --- |
| `contract` | `lnwjud.goal-event.v1` |
| `eventId` | Opaque unique event ID |
| `workspaceId` | Approved workspace ID |
| `goalId` | Host-created Goal ID |
| `revision` | Committed nonnegative integer Goal revision |
| `fromStatus` | Previous Goal status, or null for creation |
| `toStatus` | Committed Goal status |
| `committedAt` | Host UTC timestamp with millisecond precision |
| `origin` | `host-goal-repository` |
| `authorizationMode` | `standard` |

Creation is `null` to `active` at revision zero. Significant updates are `active` to `completed`, `failed`, `blocked` or `cancelled`, and explicit `blocked` to `active` recovery. Ordinary checkpoints, unchanged statuses and activity messages are excluded.

The repository stages the event in the same SQLite transaction as the Goal mutation and checkpoint. An outbox failure rolls back the Goal mutation. Other database connections cannot read the event before commit. The checked MCP invocation establishes authorization in an isolated asynchronous context; a settings change cannot relabel an already admitted Full Bypass invocation. Unwrapped or unknown-provenance writes produce no event.

The payload contains no objective, prompt, transcript, path, checkpoint text, raw arguments, lease token or credentials. Adding unknown fields makes the v1 payload invalid. The canonical serializer is `canonicalGoalEvent` in `packages/domain/src/goal-events.ts`.

Each delivery contains `cursor`, `event`, `keyId` and `signature`. The Ed25519 message is the UTF-8 bytes of `lnwjud.goal-event-signature.v1`, a null byte and the canonical event JSON. The signature uses canonical padded base64. `keyId` is the lowercase SHA-256 digest of the Ed25519 public-key SPKI DER bytes. The public key is canonical padded base64 SPKI DER.

## Current authorization proof

`GET subscription` returns the subscriber, its active state and a signed authorization receipt. `GET events` returns the same proof with the batch. The signed object contains exactly `contract`, `nonce`, `subscriberId`, `workspaceId`, `authorizationEpoch`, `active`, `observedAt` and `expiresAt`, in that order. Its contract is `lnwjud.goal-event-authorization.v1`. Its validity interval is 15 seconds. The Ed25519 signature covers the canonical JSON UTF-8 bytes directly.

The consumer verifies the host key, signature, exact request nonce, subscriber ID, workspace, epoch, active state and freshness. It revalidates with a new nonce immediately before any separately authorized memory write. An event signature proves a committed transition; it does not grant current write permission. A changed Primary Project or Full Bypass returns inactive status and refuses delivery and acknowledgement. Revocation returns unauthorized.

## Cursor, replay and acknowledgement

`GET events` returns up to 50 unacknowledged events in workspace sequence order. The batch includes `contract`, `workspaceId`, `authorizationEpoch`, `ackCursor`, signed `authorization` and `events`. The cursor is an opaque monotonic integer and may contain gaps belonging to other workspaces.

Delivery is at least once. A lost response or Host restart returns the same unacknowledged event identities and payloads. A rotated host key can re-sign an existing event; event ID and canonical payload remain unchanged.

The consumer durably deduplicates by workspace, event ID and Goal revision. It records its own intended action before making a consent-scoped memory write. An ambiguous or missing external write receipt requires exact readback or operator reconciliation. It must not blindly issue the write again. Local protocol tests use an independent local receipt document; they do not prove a real Hindsight staging write.

After the receiver has a durable verified receipt, `POST ack` accepts exactly `cursor` and `eventId`. The cursor must identify an event already delivered to that subscription in its workspace. Acknowledgement is cumulative and idempotent. A skipped, unknown, wrong-workspace or mismatched event is rejected. Do not acknowledge an event whose downstream outcome is unknown.

The consumer preserves the highest accepted key, workspace-scoped acknowledgement and external receipt journal across restart and application upgrade. Deleting or restoring consumer state does not authorize replaying an external write.

A Host database backup restore revokes all restored active subscriptions, including a restore on the same host. This prevents an older backup from resurrecting revoked tokens or an old acknowledgement. The companion requires fresh native pairing. Historical event records remain intact, and the new subscription begins after them.

Every confirmed Host database restore also removes the restored host-bound encrypted signing-key chain. OS and architecture equality cannot prove the same machine or account. The Host creates a new secure root, which requires explicit native enrollment after all old subscriptions have been revoked. The Goal profile reader floor advances to 3 with schema migration 026; an already-open older writer is rejected before it can commit a transition without an outbox record.

## Revocation and rotation

`DELETE subscription` revokes the authenticated subscriber immediately, including when its workspace is no longer active. `POST revoke` accepts exactly `workspaceId` and `subscriberId`, then requires native Host approval. This second route lets an owner revoke a lost companion credential. Old tokens fail after revocation.

`POST credential` accepts an empty JSON object and rotates only the authenticated subscription's bearer token. It preserves its cursor and increments its authorization epoch. The old token stops working immediately. If the response is lost, the companion stops and pairs again through native approval; it does not retry using an indeterminate credential.

`GET keys` returns the enrolled host key and its signed successor certificates. `POST keys/rotate` accepts an empty JSON object and requires native approval. Each successor certificate contains exactly `contract`, `keyId`, `publicKey`, `previousKeyId` and `issuedAt`, in that order. Its contract is `lnwjud.goal-event-key.v1`. The predecessor Ed25519 key signs the canonical certificate JSON bytes. There are at most 64 keys in a chain.

The consumer verifies every successor from its enrolled or highest accepted key, retains that highest key and rejects a downgrade or unknown predecessor. `verifyGoalEventKeyChain`, `verifySignedGoalEvent` and `verifyGoalEventAuthorization` in the Desktop signing module are executable reference verifiers. A lost or unavailable Host signing key stops delivery. Re-enrollment requires a fresh native approval; an unsigned replacement key cannot silently replace the pinned root.

## External companion boundary

The Host authorizes lifecycle metadata delivery only. Bank mapping, staging versus production selection, allowed fields, downstream credentials and each memory write require the receiver's own explicit consent and durable reconciliation. The Host never sends a raw chat transcript or performs a Hindsight write. Production packaging, rollback and live staging readback remain separate acceptance work.
