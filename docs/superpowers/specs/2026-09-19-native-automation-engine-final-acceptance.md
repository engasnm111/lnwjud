# Native Automation Engine — Final Acceptance Report

Date: 2026-09-19
Branch: `feat/native-automation-engine`
Scope: M0–M9 final branch acceptance against the native automation architecture and `upstream/main`.

## Verdict

**MERGE_READY**

The branch satisfies the architecture invariants and the M0–M8 acceptance contracts under the branch-level test, build, packaging-contract, migration, security, and regression evidence recorded below. This verdict means the branch is ready for a normal reviewed merge workflow; it is not a release/deploy authorization.

## Branch baseline

- Fetched `upstream/main` before final acceptance.
- Upstream base reviewed: `1e112c1a9bd8c0fecec9d7326fa22a2747769af2`.
- M0–M8 are nine commits ahead of that base with no upstream commits behind at the start of M9.
- `upstream/main` is an ancestor of the branch.
- Installed lnwjud v5.3.0 was not modified.
- No push, merge, tag, release, deploy, repository deletion, `git clean`, `git reset --hard`, browser automation, or desktop automation was used.

## Architecture acceptance

- Durable Goal remains the root authority; AutomationRun is subordinate and terminal only after durable GoalRecord completion/readback.
- Goal revision, intent revision, lease generation, and current lease proof are fenced before durable automation mutations.
- Scheduled continuation remains the existing authoritative wakeup mechanism; automation resume projects from a valid recurring claim rather than creating a second scheduler.
- Crash recovery reconciles persisted dispatch receipts, exact durable task identity, verification checkpoints, and terminal GoalRecord state before replay or completion.
- Dispatch ambiguity remains fail-closed: unresolved external effects are reconciled before retry and are never converted to success by inference.
- Dispatch identity/idempotency is persisted before launch and replay does not create a second child launch for the same reserved operation.
- `coding_guarded` exposes only shell/process/Codex execution descriptors and hard-denies browser, desktop, keyboard/mouse/UI automation and destructive workspace/repository cleanup.
- Push, merge, tag, publish, release, and deploy operations still require explicit authorization and normal ToolRegistry policy.
- Observability is read-only over authoritative automation state and projects bounded audit/dashboard/Live Log data without raw lease tokens, idempotency keys, execution payloads, secrets, or private reasoning.
- Migrations 019/020 are additive, preserve pre-existing durable state, reopen idempotently, and retain the pre-migration backup contract.
- Packaging isolation includes compiled automation code/migrations while excluding mutable automation SQLite/runtime state from installation resources.

## M9 findings fixed

1. Current-version tool-count documentation and Desktop package metadata still contained the pre-automation `253 total / 241 default / 253 Codex-enabled` contract in several current sections. Current surfaces were corrected to the generated runtime contract: **263 total / 251 default / 263 Codex-enabled**. Historical version snapshots were intentionally left unchanged.
2. The Desktop live External MCP recheck integration test hit the default 15-second Vitest timeout under high parallel suite load even though the operation completed reliably when isolated/serialized. The test-only timeout was raised to 30 seconds. It passed targeted verification and the exact full `test:release` run afterward.

## Security and code-quality review

- Whole-branch added-line scan found no TODO/FIXME/HACK, `debugger`, or added `console.log`/debug artifacts.
- Production scan found no raw `leaseToken` logging.
- Added-line credential scan found no private-key headers, GitHub PATs, OpenAI-style secret literals, AWS access-key patterns, or hard-coded password literals.
- Production automation provider scan found no browser/computer-use/DOM/input/desktop dispatch provider.
- Production wiring review confirmed orchestrator, task supervisor, goal integration, scheduled resume, observability, execution policy, runtime adapter, and SQLite repository are all wired into production paths rather than test-only dead exports.
- Lint/typecheck plus production wiring review found no branch-specific dead local code or unused imports.
- No second goal authority, lease authority, scheduler, or repository/folder deletion path was introduced.
- Whole-branch `git diff --check upstream/main` passes.

## Verification evidence

| Gate | Result |
| --- | --- |
| Domain tests | 7/7 passed |
| Audit tests | 8/8 passed |
| Shared tests | 139/139 passed |
| Storage tests | 101/101 passed |
| Application tests | 243/243 passed |
| MCP server tests | 1075/1075 passed |
| CLI tests | 29/29 passed |
| Desktop full suite after timeout hardening | 703 passed, 1 skipped, 0 failed |
| Automation fault-injection suite | 9/9 passed |
| Automation upgrade integration | 1/1 passed |
| Native automation packaging isolation | 3/3 passed |
| Packaging contract suite | 78/78 passed |
| Acceptance suite | 33/33 passed |
| Integration suite | 2/2 passed |
| Release gate | 23/23 passed |
| Version contract | passed |
| `test:release` full workspace regression | passed |
| Root lint | passed |
| Root typecheck | passed |
| Full monorepo build | passed |
| Tool catalog generation/check | 263 total / 251 default / 263 Codex-enabled, synchronized |
| Whole-branch diff check | passed |

The real Windows DPAPI/SecureString migration test was exercised using the unchanged installed v5.3.0 native migration helper as a read-only test dependency because the development host does not have the .NET SDK installed.

## Residual risks / non-blocking release evidence

- Target-native macOS/Linux packaging, signing/notarization, and final distributable provenance remain CI/release-environment evidence. Windows branch-level packaging contracts passed, but this M9 did not publish or deploy any artifact.
- Real Native ChatGPT recurring-watchdog E2E remains host/integration evidence required by the release checklist; M6 scheduled-resume and crash-window behavior is covered by deterministic application/MCP tests.
- The External MCP live-recheck test is comparatively load-sensitive. Its branch acceptance timeout is now 30 seconds, and the final release regression completed the case in about 6.9 seconds.

None of these items contradicts the branch architecture or requires a source change before merge. They remain release-process evidence boundaries rather than merge blockers.

## Final merge-readiness statement

The M0–M8 implementation plus the M9 corrections preserve upstream compatibility, durable-goal authority, lease/fencing semantics, idempotent crash recovery, `coding_guarded` restrictions, observability redaction, additive migration behavior, and packaging isolation. With the recorded gates passing and no unresolved branch-specific blocker, the final branch status is **MERGE_READY**.
