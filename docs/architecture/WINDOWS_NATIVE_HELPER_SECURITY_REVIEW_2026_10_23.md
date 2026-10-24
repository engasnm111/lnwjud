# Windows native helper security review — October 23, 2026

## Scope and authority

Separate Codex reviewers `helper_security_review` and `tunnel_final_review` inspected the Windows native helper and the stale Tunnel recovery changes based on `dev` commit `8a281f946131aa4f83df9c6832417179443f1f90`. The reviewed candidate includes the subsequent pipe, Tunnel and regression changes. Reviewers did not implement the changes they approved. Their source reviews are independent of the implementers, but are not third-party certification or release approval.

The production helper tested and installed for this candidate has SHA-256 `032f6a4956c5f21981b9eef7cc6494891d46938819732d2c618d430d9b1f0684`.

## Threat model and trust boundaries

Unprivileged authenticated Windows users, hostile child processes, forged receipts, replayed task identities, competing pipe servers and stale or replaced Tunnel metadata are untrusted. Administrators and LocalSystem are trusted for this review. Profiles sharing a Windows SID do not constitute separate OS identities.

The reviewed boundaries are application-to-helper executable pinning, helper-to-SCM endpoint authentication, impersonated pipe caller-to-service ledger ownership, service-to-user-token process launch, and the caller-owned Tunnel state files. Stale Tunnel cleanup runs as the caller through the pinned helper, without SCM elevation or a new public MCP operation.

## Findings and remediation

| Finding | Evidence and impact | Resolution |
| --- | --- | --- |
| Historical ProfileKey export | Production command dispatch and compilation were inspected for key export, legacy receipt writing and replay paths. | `ProfileKey.cs` is excluded from production compilation; legacy execution/receipt paths are test-only. Production export-denial tests also passed. Independently resolved in source. |
| P2: authenticated users can create competing service pipe instances | The former AU generic-write grant included bit `0x4`, shared by `FILE_APPEND_DATA` and `FILE_CREATE_PIPE_INSTANCE`. A restricted-token regression reproduced competing-instance creation. Availability loss was supported; privilege escalation or receipt forgery was not demonstrated. | Explicit client rights exclude `0x4`. Client opening requests compatible exact rights, retains impersonation SQOS and asynchronous handles, and disposes failed/cancelled handles. Restricted-AU tests prove competing-instance denial and legitimate duplex RPC. Final scoped review approved. |
| Stale alias cleanup can signal a replacement owner | A probe followed by CLI Stop is insufficient: the pinned client re-reads its current owner under its own lock, so an intervening restart can change the process being stopped. Missing liveness evidence is also not stopped proof. | Historical-PID recovery removes only exact stale alias/process entries under the upstream byte-range state lock. It uses native process identity, no termination rights or signals, bounded parsing, pinned paths, whole-map CAS and a paired recovery journal. Live, inaccessible, unknown or conflicting identity remains refused. Independent final review approved. |
| Retained supervisor can bypass pending journal recovery | After interruption between paired map publications, a retained supervisor Start/kick could reach adapter connect without the controller recovery hook. Rewriting state then caused later recovery/Reset to refuse `SNAPSHOT_CHANGED`. | Deterministic controller/adapter regressions reproduced the failure. `connect`, `stop` and `ensureSingleProcess` now recover before CLI or process mutation, and refuse conflicting maps without reconnecting or signalling processes. Read-only status/capabilities remain unchanged. Independent final source review approved the correction. |

Microsoft documents the shared pipe right in [named-pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

## Authentication and fault scenarios inspected

`ServiceEndpointIdentity` compares the connected server with SCM authority and pins the installed image before requests and after responses. `AuthenticatedPipeCaller` derives the caller SID through pipe impersonation. `ServiceAttemptLedger` checks SID, complete attempt identity and operation digest. A caller-controlled receipt file does not replace service authority.

The Tunnel review covered alias restart races, live/reused/inaccessible PIDs, missing lock bootstrap, byte-range lock compatibility with the real pinned Go client, reparse/hard-link refusal, malformed and duplicate JSON, paired publication crashes, journal recovery and third-party metadata conflicts. Read-only status does not perform journal recovery. Windows provides this native metadata route; other platforms retain conservative refusal for historical-PID cleanup.

Two test-only observer/setup corrections received independent approval: waiting for terminal proof and reservation release in one observation without increasing the timeout, and replacing inherited case variants before setting `PSExecutionPolicyPreference=Restricted`. Native duplicate-environment rejection remains unchanged.

## Verified evidence and limits

The test counts and installed/UI results below are evidence recorded by the implementing/root workers; the independent source reviewers did not rerun those checks. Full canonical `verify-release.ps1 -SkipWindowsPackaging` completed with exit 0 on the candidate before the final lifecycle journal guards, including Electron E2E **18/18**. Those guards subsequently passed the canonical-helper Tunnel matrix **146/146**, lint and typecheck. Fresh full validation and exact-head hosted CI for the final source remain pending.

- Restricted-AU security regression failed before the pipe fix and passed afterward; the complete native suite passed with the canonical helper.
- Canonical-helper Tunnel tests passed **141/141**, including isolated fixtures using the real pinned client. Unrelated metadata, profile bytes and unrelated live processes were preserved.
- Packaging contracts passed **90/90**. Setup and Portable integrity/provenance checks passed; both are unsigned local development candidates from a dirty tree.
- Installed application/helper hashes matched the fresh candidate, SCM reported Running, and installed authority/service/attempt tests passed **39/39**.
- A real outer PowerShell invocation reported `EffectivePolicy=Restricted` and passed **10/10** contained-launch and installed-authority cases.
- Actual installed UI Stop/Start verified connected → stopped → connected. Live Factory Reset was not executed.

These results do not establish all clean-install/uninstall/migration/failure-recovery cases, distinct-user/session acceptance, signed unattended updater/restart/rollback, macOS all-descendant owner-loss containment, hosted exact-SHA CI or official release acceptance. Direct SCM configuration/ACL queries from the ordinary caller returned access denied; no elevation was used to bypass that boundary.

**Final scoped sign-off:** reviewers approved the pipe correction, metadata-only retirement design and subsequent supervisor/journal guards with no remaining blocking findings within the reviewed scope. Required release gates remain open until their own native and hosted evidence is accepted.
