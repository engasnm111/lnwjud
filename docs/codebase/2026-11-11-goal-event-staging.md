# Goal Event API staging validation

On 11 November 2026, an independent local subscriber consumed an actual committed Goal transition from the built Host and retained it in a disposable Hindsight 1.2.1 instance. The Host ran in a separate Node 24.22.2 process. This validates the built protocol and a real downstream staging write. Installed native approval and release publication are separate checks.

## Observed result

The standard checked `ToolRegistry.run_goal` path committed the Goal and its outbox event in one SQLite transaction. The receiver verified the Ed25519 event signature, committed revision, workspace and fresh signed authorization before its staging write.

A fault proxy dropped Hindsight's successful retain response. The receiver kept the outcome unknown, made no second write and withheld acknowledgement. It reconciled the exact stored document through Hindsight's HTTP readback, flushed its durable receipt, restarted the Host, deduplicated the replay and acknowledged the event.

- Downstream retain attempts: **1**.
- Canonical document SHA-256: `4f0e46288a3700422780438cf08e394f045105104c78d046bf3d98daeaf7faa9`.
- Forged signatures, nonce replay, workspace changes and revoked credentials were rejected.
- Hindsight stored one embedded memory unit using its supported chunk-retention mode and a local embedding model.
- The temporary bank, Host state, task containers, volumes and private network were removed. Existing services were preserved.

The staging Host used an explicit ephemeral secret protector and an approved test-host adapter. This run did not exercise an installed Desktop approval dialog, an operating-system keychain or a user's existing Hindsight deployment. No production data or external credentials were used.

## Reproduction records

The local workspace retains the rerunnable harness at `.audit/v5.9.1-hindsight-staging.mjs`, the setup and cleanup guide at `.audit/v5.9.1-hindsight-staging-run.md`, the result at `.audit/v5.9.1-hindsight-staging-result.json`, and the public receiver journal at `.audit/v5.9.1-hindsight-receipt-217998b9-448b-44c5-80cb-eb7784ea4754.json`.

The Hindsight image was `ghcr.io/vectorize-io/hindsight-api@sha256:084af5a6522d67f5905f7992cdb3d910d778496e5dd2566caec7cf82ed2e7d8c`. Cosign 3.1.3 verified the official GitHub Actions release identity. The embedding service used `ollama/ollama@sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592` and `all-minilm`, observed model ID `1b226e2802db`. Combined memory was limited to 2304 MiB and two CPUs. Only `127.0.0.1:17988` was published.

See the [API contract](../development/GOAL_EVENT_API.md) for enrollment, signatures, current consent, replay, acknowledgement and restore behavior.
