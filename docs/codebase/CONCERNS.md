# lnwjud confirmed concerns and technical debt

Audit date: 2026-09-19
This document records evidence, not an instruction to implement every item immediately.

## P0 — production dependency extraction risk

Confirmed by `pnpm audit --prod --json`: direct production dependency `extract-zip@2.0.1` is affected by two High advisories:

- CVE-2026-56876 / GHSA-jmr9-qjv8-65gv — symlink path traversal.
- CVE-2026-19693 / GHSA-7pqw-9j4j-h8q3 — arbitrary write through a planted symlink entry.

Both were reported with CVSS 8.1 and no patched upstream version.

Current PDF-provider download code verifies source integrity/size, which reduces but does not eliminate archive-extraction risk. Required next step is to replace/harden the extraction implementation and verify native packaging on every supported target. Do not suppress the audit finding.

## P1 — architecture concentration in high-churn files

Confirmed large + high-churn implementation hotspots include:
- `apps/desktop/src/main/desktop-services.ts`
- `apps/desktop/src/main/main.ts`
- `packages/mcp-server/src/upgrade-runtime.ts`
- `packages/storage/src/goal-repository.ts`
- `packages/mcp-server/src/tool-registry.ts`
- `apps/desktop/src/preload/index.ts`

The workspace package graph itself is acyclic. The concern is responsibility concentration, not dependency cycles.

Refactor through contract-preserving responsibility extraction; avoid a whole-system rewrite.

## P1 — dashboard/summary refresh cost

Existing design can rebuild multi-subsystem dashboard/summary state on a short periodic cadence. This becomes expensive as workspace, Git, Doctor, tool availability and process state grow.

Recommended direction:
- dirty/event-driven section invalidation,
- cached section snapshots,
- a slower fallback reconciliation poll,
- explicit refresh for user-forced sync.

Measure before/after CPU/event-loop and I/O impact using the existing diagnostics/benchmark infrastructure.

## P1 — generated-workspace pollution

Automatic context/search discovery historically included local/generated directories that can be extremely large. Current working changes add ignore policy for `.codegraph`, `.local-artifacts`, `.pnpm-store`, `.serena`, `.superpowers`, `.worktrees`, Playwright reports and test results.

A scanner used during this audit demonstrated the failure mode by counting local artifacts as source and reporting more than two million lines.

Follow-up: version/invalidate persisted workspace indexes when context-discovery policy changes so stale indexed generated files do not survive a policy update.

## P1 — external MCP health semantics

Fixed in this audit at source level:
- active replacement sessions now report `connected` even if an earlier child close failed,
- historical `termination_unverified` remains visible only without an active replacement,
- stale external tool names now give catalog-refresh recovery guidance.

The currently running installed lnwjud process may continue to show the old health semantics until rebuilt/reinstalled; source-level tests cover the corrected behavior.

## P1 — skill matching/autoload

Fixed in this audit at source level:
- natural-language matching no longer relies on one contiguous substring,
- `limit` is honored,
- `run_goal` can pre-load a relevant skill before subsequent work,
- auto-load is confidence bounded,
- external-trust skills are not auto-injected unless explicitly named,
- loaded skill content is capped at 48 KiB.

A future iteration may generalize preflight beyond `run_goal`, but only at an orchestration layer that actually possesses the user's original intent. Low-level file/shell tools should not guess independently.

## P2 — runtime/provider maintenance

`runtime:check` reported PDF provider `26.07.0-0 -> 26.09.0-0`.

Apply using the existing pinned URL/hash/provenance and target-native package verification path, in a maintenance change separate from extraction/security restructuring when practical.

## P2 — dependency modernization

Several dependencies have newer releases. Minor updates can be grouped by compatibility surface, but major migrations (ESLint 10, TypeScript 7, Vite 8, Vitest 5) should be isolated and verified separately.

Do not update Electron solely because it is prerelease/currently unusual; current `45.0.0-alpha.7` is tied to explicit crash-diagnostics/runtime evidence.

## P2 — duplicate domain helpers

Similar helpers for bounded text/string normalization and lease-token hashing exist across goal/scheduled-continuation services. They are candidates for a small shared durable-goal utility with one contract.

By contrast, local one-line `isRecord` guards are intentionally low-level boundary checks and are not automatically a useful shared abstraction.

## Confirmed healthy areas

- Workspace package dependency graph: no cycles found.
- Electron BrowserWindow baseline: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, deny new-window and unapproved navigation.
- Secure secret storage: no intentional plaintext fallback on unsupported Linux keyring state.
- Production Git-tracked source: no confirmed TODO/FIXME/HACK backlog from the audit scan.
- Cross-platform CI/release: target-native verification exists for Windows/macOS/Linux.
