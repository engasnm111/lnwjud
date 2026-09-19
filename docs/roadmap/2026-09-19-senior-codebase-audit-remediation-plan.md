# Senior codebase audit remediation plan

Date: 2026-09-19
Repository: `E:\lnwjud`
Status: implementation plan. Except for the Serena/skill infrastructure fixes documented below, this plan has not been implemented in this audit pass.

## Goals

1. Remove confirmed security/reliability risks before broad modernization.
2. Reduce high-churn responsibility concentration without changing product behavior.
3. Make automatic context/skill/tool routing cheaper and more deterministic.
4. Preserve cross-platform and release evidence contracts.
5. Avoid mixing unrelated major dependency migrations into functional/security work.

## Already fixed in this audit

### External MCP / Serena health
- Correct lifecycle precedence so a live replacement child session is `connected`.
- Preserve `termination_unverified` when there is no active replacement and an old close remains unverified.
- Return actionable stale-tool recovery guidance pointing callers to `mcp_describe` and the live declared catalog.
- Regression tests exist for close failure -> reconnect and stale tool name.

### Skill matching/preflight
- Replace whole-prompt substring matching with bounded ranked natural-language matching.
- Honor match limit.
- Add `run_goal` skill preflight based on the user objective.
- Prefer explicit user-selected skill names.
- Auto-load only confident non-external skills.
- Cap loaded skill content to 48 KiB.
- Regression tests cover relevant match selection and external-trust non-autoload.

These fixes must still pass the repository-level verification gates before eventual commit/release.

## Wave 0 — establish a clean verification baseline

Before additional implementation:
1. Preserve all unrelated working-tree changes; do not reset/revert them.
2. Run `git diff --check`.
3. Run root lint/typecheck.
4. Run the directly affected package tests.
5. If the combined tree is intended for release, run the authoritative release verification path documented in `docs/development/RELEASE_PROCESS.md`.
6. Record any failures as either pre-existing/unrelated or caused by the current changes; do not hide unrelated failures.

Exit criteria:
- no syntax/type/lint regression caused by the audit changes,
- all new Serena/skill tests green,
- documentation paths tracked by Git.

## Wave 1 — P0 archive-extraction security

Problem: `extract-zip@2.0.1` has two High symlink/path traversal advisories and no patched upstream version.

Tasks:
1. Trace every production use of `extract-zip`.
2. Select a maintained extraction implementation or a hardened wrapper that rejects links/escapes.
3. Keep existing download hash, size and provenance validation.
4. Ensure extraction destination containment is checked on every entry and final resolved target.
5. Validate executable/native module packaging behavior on Windows, macOS arm64/x64 and Linux x64/arm64.
6. Add security regression fixtures for symlink traversal and duplicate-name symlink overwrite where the chosen extractor permits controlled fixture creation.
7. Re-run `pnpm audit --prod`.

Exit criteria:
- no High advisory remains through the production extraction path,
- malicious archive fixtures cannot write outside the destination,
- target-native package smoke remains green.

Do not combine this wave with major framework/toolchain upgrades.

## Wave 2 — context/index correctness and performance

Tasks:
1. Finalize automatic-context ignore policy for generated/local trees.
2. Add an index-policy/schema revision to persisted workspace indexing.
3. On policy revision change, invalidate/rebuild or safely prune stale indexed generated paths.
4. Add metrics for indexed file count/bytes/hash work and ignored-path count.
5. Add a regression fixture containing a large ignored worktree/artifact tree and prove automatic discovery stays bounded.
6. Keep explicit-path user access to ignored directories available.

Exit criteria:
- no stale generated entries remain after an ignore-policy change,
- automatic indexing cost scales with source content rather than local artifacts,
- explicit reads continue to work.

## Wave 3 — dashboard/readiness refresh architecture

Tasks:
1. Measure current refresh cost using runtime diagnostics/benchmark hooks.
2. Identify independent dashboard sections and their authoritative change events.
3. Replace whole-dashboard short polling with per-section dirty flags/event invalidation where reliable.
4. Keep a slower reconciliation poll for missed/out-of-process events.
5. Cache expensive Git/Doctor/tool-availability summaries behind revision/time keys.
6. Verify search/log UX is not interrupted by background refreshes.

Exit criteria:
- materially lower idle CPU/I/O on a large workspace,
- no stale state beyond the documented fallback interval,
- no correctness loss in multi-workspace/tunnel/process states.

## Wave 4 — composition-root extraction

Start with high-size/high-churn files, but split only along stable ownership boundaries.

### `desktop-services.ts`
Candidate extractions:
- Doctor/readiness requirement registry builder.
- tunnel/auth composition.
- tool availability/catalog composition.
- recovery/retention scheduling.
- Desktop service facade assembly.

Keep `createDesktopRuntime` as the composition root; reduce policy implementation inside it.

### `main.ts`
Candidate extractions:
- app/bootstrap lifecycle,
- updater orchestration,
- IPC registration groups,
- crash/session diagnostics,
- secure-secret startup/migration.

### `upgrade-runtime.ts`
Group facades by domain and move domain-specific implementation into services/modules while preserving one routing contract.

### `goal-repository.ts`
Separate schema/migrations/serialization from bounded query/update operations. Do not introduce repository-to-application dependencies.

Exit criteria:
- package graph remains acyclic,
- public contracts unchanged unless explicitly migrated,
- extracted modules have focused existing/new behavior tests,
- large orchestrators become composition/dispatch code rather than mixed business logic.

## Wave 5 — durable-goal shared contracts

Tasks:
1. Compare duplicate normalization/hash helpers in goal and scheduled-continuation services.
2. Extract only semantically identical functions into one low-level application/domain utility.
3. Keep lease-token redaction/hash semantics unchanged.
4. Do not create a generic dumping-ground utility module.
5. Do not centralize unrelated local `isRecord` guards without a stronger contract reason.

Exit criteria:
- one source of truth for truly shared durable-goal normalization/security helpers,
- no new dependency cycle.

## Wave 6 — dependency/runtime maintenance

Small/compatible updates should be grouped by surface. Major versions require dedicated migration branches/PRs.

Near-term candidates:
- PDF provider `26.09.0-0` through the existing runtime-dependency workflow.
- `ecc-agentshield`, Zod, Playwright, React/ReactDOM and electron-builder after compatibility review.

Separate major migrations:
- ESLint 10,
- TypeScript 7,
- Vite 8,
- Vitest 5.

Electron is excluded from generic “latest dependency” work; change it only with explicit runtime/crash/package evidence.

Exit criteria:
- lockfile reproducible,
- target-native packaging green,
- no release-gate weakening.

## Wave 7 — documentation and operational contracts

1. Keep `docs/codebase/*` updated when a structural wave lands.
2. Keep platform/release architecture docs authoritative; avoid duplicating current version state in many files.
3. Add a lightweight codebase-audit script that scopes to Git-tracked source or uses the same context-economy ignore policy so local artifacts do not corrupt metrics.
4. Make Serena/external-MCP troubleshooting explicitly distinguish:
   - server disabled,
   - disconnected,
   - termination unverified with no active replacement,
   - active connection with stale caller tool name,
   - tool catalog/version drift.

## Suggested PR sequence

1. Serena + auto-skill infrastructure fix and documentation.
2. Archive-extraction security fix.
3. Context/index policy revision and performance regression.
4. Dashboard event-driven refresh.
5. Desktop composition-root extractions.
6. MCP/runtime and storage large-module extractions.
7. Durable-goal helper consolidation.
8. Runtime/dependency maintenance.
9. Major toolchain migrations one at a time.

Each PR should have one primary failure mode and one clear rollback boundary.

## Non-goals

- No rewrite of the entire architecture.
- No new package solely to reduce file line count.
- No behavior-changing test added merely for coverage.
- No release-gate weakening.
- No reset/revert of unrelated working-tree work.
- No automatic trust of external skill instructions.
