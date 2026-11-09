# Automatic Project Checkpoint Memory — Host Event v1

## Status

The local source contains an **opt-in** signed Host post-commit Goal publisher,
SQLite durable outbox, milestone selection and a consent-gated Hindsight writer.
Unit and isolated integration tests are not evidence of a live Production install
or an external authenticated subscriber. The upstream external companion API in
[issue #249](https://github.com/engasnm111/lnwjud/issues/249) is separately
required before external companions can subscribe to live committed Goal events.

## Authority and privacy

- The **Goal repository** stages a minimal allowlisted event in the same SQLite
  transaction as a successful Goal creation, checkpoint or finish. The listener
  is notified only after COMMIT. Rollbacks cannot publish a durable event.
- The event includes the contract, opaque event ID, Workspace/Goal IDs, revision,
  operation, transition and committed timestamp. It excludes prompts, objectives,
  transcripts, arguments, paths, keys and secrets.
- An Ed25519 signing key is derived inside the Desktop Host from the protected
  checkpoint master using a domain-separated KDF. It is not the Windows
  Authenticode publisher certificate. There is no hardcoded signing key.
- Workspace scope and the existing authorized bank mapping are revalidated on
  delivery. The Watcher read token does not grant write authority.
- Decision and next-action summary text comes only from the exact persisted Goal
  revision. Unsafe-looking secrets, paths, email addresses, URLs, control
  characters and overlong text fail closed. User reviews the **exact proposed
  content** in one-use Native Approval before every write.
- A durable journal is reserved before dispatch and settled from actual
  Hindsight HTTP and exact document readback. Ambiguous writes do not retry
  blindly. Denials do not create Hindsight documents.
- No Goal/Task/Scheduler is created by the memory publisher.

## Operational scope

The implementation handles only the Host-selected Active Project and its
explicitly configured existing bank; it does not automatically read/write other
projects while a different one is selected. This prevents cross-workspace
leakage. Automatic processing is event-driven but actual memory writes may
pause for Native Approval. It is not fully unattended.

## Verification boundary

Source checks include Signed Event validation (forgery/scope/replay/revocation),
SQLite commit/rollback/revision CAS tests, decision/next-step safety tests, and
mocked Hindsight one-write/receipt/readback. Tests must not be represented as a
genuine Production Hindsight write.

Before a Production rollout, verify the exact reviewed source/commit and hosted
CI, the installer SHA/provenance, verified backup and rollback, safe deployment,
a genuine Host-committed event, one consented Production Hindsight write with
receipt and exact document readback, and recall from a **separate new ChatGPT
conversation**. The rollout must not bypass Host Engineering Gates or substitute
an unsigned/unverified artifact for one requiring trusted publisher identity.

## External companion contract (not yet implemented)

A version-independent external subscription endpoint still needs separately
authenticated local pairing, public key enrollment/rotation, Workspace-scoped
authorization and revocation, durable cursor acknowledgments, capability
discovery and reconnection behavior across Host restart/upgrade. Never expose
the signed outbox using the read-only Watcher bearer token.
