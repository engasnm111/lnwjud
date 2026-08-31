# Full Bypass and First-Run Closure Implementation Plan

> **Source of truth:** `FIRST_RUN_PERMISSION_FLOW_AUDIT.md` plus the approved Standards/Spec review findings from 2026-08-28.
>
> **Delivery contract:** implement in the existing `dev` working tree, preserve unrelated/user-owned changes, rebuild, bump every product version to `4.28.0`, update all README and behavior docs, and create one local commit without pushing.

## Goal

Make Full Bypass an honest end-to-end application authorization mode for Desktop and STDIO, keep Full-with-bypass-off and Custom decisions truthful, make a clean first run recoverable, separate the Full Access controls from Custom in Settings, and align runtime evidence, UI, docs, and release metadata.

## Non-negotiable behavior

- Full Bypass ON skips application-owned confirmation, profile, protected-path, workspace-scope, command-risk, active-scope, and durable-goal lease gates. Input validation, file existence, OS permissions, and backend failures still apply.
- Full Bypass must never be represented as forged `userConfirmed: true` input. Audit/activity records must say `authorizationMode: full_bypass` from the first event.
- Full Bypass OFF keeps the Full profile's normal automation but still asks for the documented always-confirm mutation families.
- Custom `ALLOW` must really allow the selected ordinary capability; `ASK` must ask; `DENY` must deny. Always-confirm families and scope boundaries remain explicit unless Full Bypass is ON.
- A new profile with zero workspaces must be able to reach Add Project from Doctor and recover without restarting.
- Desktop and STDIO Full Bypass controls belong in their own Full Access (Unrestricted) card, never inside Custom Permission Profile.

## Task 1: Establish failing authorization-contract tests

**Files:**

- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Modify: `packages/mcp-server/src/mcp-http.integration.test.ts`
- Modify: `packages/mcp-server/src/stdio.integration.test.ts`
- Modify: `packages/application/src/codex-service.test.ts`
- Add or modify focused backend tests under `packages/capabilities/src/*.test.ts`

1. Add table-driven tests for Full Bypass ON, Full Bypass OFF, and Custom ALLOW/ASK/DENY.
2. Exercise real Shell/Git/File/WSL-style backend authorization rather than a mocked capability facade where possible.
3. Assert outside-workspace access and risky/prohibited commands pass only under Full Bypass.
4. Assert goal-lease enforcement is skipped only under Full Bypass.
5. Assert the first activity event already contains the final authorization mode and that caller input is not rewritten to `userConfirmed: true`.
6. Run the focused tests and record the expected RED failures before production edits.

## Task 2: Introduce honest invocation authorization and propagate it

**Files:**

- Modify: `packages/domain/src/index.ts` and a focused domain type module if appropriate
- Modify: `packages/mcp-server/src/tools/tool-types.ts`
- Modify: `packages/mcp-server/src/tool-registry.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: relevant tool factories under `packages/mcp-server/src/tools/`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/capabilities/src/local-capability-service.ts`
- Modify: Shell, WSL, browser, scheduler, web-fetch, Windows-native and other mutating capability backends
- Modify: `packages/application/src/git-service.ts`
- Modify: `packages/application/src/codex-service.ts`

1. Add one explicit invocation-authorization context with standard/full-bypass mode and provenance.
2. Compute the authorization outcome before activity `begin` and pass it through tool handlers into services/backends.
3. Remove internal mutation of `userConfirmed` for profile automation or Full Bypass.
4. Keep direct service calls fail-closed when no authorization context is provided.
5. Make each backend treat Full Bypass as application authorization while preserving schema, OS, and operational errors.
6. Run the Task 1 tests to GREEN, then run package typechecks.

## Task 3: Fix path, scope, goal-lease, and permission-family semantics

**Files:**

- Modify: `packages/workspace/src/workspace-path-guard.ts`
- Modify: `packages/workspace/src/workspace-locator.ts`
- Modify: `packages/application/src/file-service.ts`
- Modify: `packages/mcp-server/src/tool-registry.ts`
- Modify: `apps/desktop/src/main/desktop-services.ts`
- Modify: `apps/cli/src/runtime/stdio-mcp-runtime.ts`
- Modify: `AGENTS.md`
- Modify: focused workspace/application/runtime tests

1. Write failing tests for exact absolute targets outside registered workspaces under Full Bypass and rejection otherwise.
2. Permit canonical absolute targets outside a workspace only with invocation Full Bypass; keep relative paths anchored to the selected workspace.
3. For outside-workspace destructive file work, avoid pretending a workspace recovery checkpoint exists; retain exact-target and non-recursive safety contracts.
4. Skip application goal-lease and active-scope gates only in Full Bypass.
5. Replace profile-name shortcuts with explicit always-confirm-family classification plus the effective profile decision.
6. Update `AGENTS.md` so scheduled-continuation lease requirements do not contradict user-enabled Full Bypass; preserve the rest of the useful continuation policy.
7. Run focused tests to GREEN and rerun all workspace/application/MCP tests touched by the contract.

## Task 4: Close first-run and bootstrap recovery gaps

**Files:**

- Modify: `apps/desktop/src/main/desktop-services.ts`
- Modify: `apps/desktop/src/main/startup-doctor-state.ts` or its current equivalent
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: Doctor and Projects renderer components
- Modify: desktop tests for Doctor, Projects, bootstrap, and MCP lifecycle

1. Add a clean-profile test proving zero workspaces produces an actionable Doctor state rather than a navigation deadlock.
2. Let Doctor open Projects/Add Project while readiness is blocked, and refresh Doctor after a successful add.
3. Change Add Project rejection handling so UI callers receive a handled failure and no unhandled promise rejection escapes.
4. Show partial bootstrap failures even when dashboard data loads, with retry/log actions.
5. Make the Doctor verify that the configured endpoint is lnwjud, not merely that a port responds.
6. Test a healthy lnwjud endpoint, an occupied non-lnwjud endpoint, a failed add, and recovery without app restart.

## Task 5: Separate and truthfully render Full Access UI

**Files:**

- Modify: `apps/desktop/src/renderer/features/settings/UserConfigPanel.tsx`
- Modify: `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/features/shell/AppShell.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/messages.ts`
- Modify or add focused renderer tests under `apps/desktop/tests/`

1. Add a renderer test that scopes Desktop/STDIO Full Bypass toggles inside a separate Full Access (Unrestricted) section and proves they are absent from Custom Permission Profile.
2. Render the new Full Access card next to/below the Unrestricted profile explanation.
3. Render Custom decisions only in their own separately labelled card.
4. Show Desktop and STDIO bypass state truthfully in the global shell indicator.
5. Update warning/copy so Full Bypass ON is not described as still blocked by application policy.
6. Build the renderer and inspect the resulting Settings view at a representative desktop viewport.

## Task 6: Align public contracts and version 4.28.0

**Files:**

- Modify: all workspace `package.json` files carrying the product version
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/ipc-contracts/src/index.ts`
- Modify: `README.md`, `README_PLAN.md`, `native/windows-ocr/README.md`, `apps/desktop/build/README.md`
- Modify: `.github/RELEASE_CHECKLIST.md`
- Modify: `docs/USAGE_TH.md`
- Modify: `docs/LNWJUD_CAPABILITIES.md`
- Modify: `docs/architecture/TOOL_CONTRACT.md`
- Modify: `docs/architecture/UPGRADE_ARCHITECTURE.md`
- Modify: `docs/architecture/MUTATION_SAFETY_MATRIX.md`
- Modify: packaging/release docs and static tool descriptions

1. Set all product/version constants and version assertions to `4.28.0`.
2. Change static tool descriptions from unconditional confirmation claims to the standard-mode/Full-Bypass contract.
3. Regenerate the README tool catalog with `corepack pnpm@10.15.0 docs:tools`, then verify the generated count rather than guessing it.
4. Search every README and docs tree for stale Full Access, Custom, transport, always-confirm, protected-path, outside-workspace, tool-count, and `4.27.0` claims.
5. Run the documentation/catalog check.

## Task 7: Full verification, rebuild, and local commit

1. Run focused tests after every RED/GREEN group.
2. Run `corepack pnpm@10.15.0 lint`.
3. Run `corepack pnpm@10.15.0 typecheck`.
4. Run `corepack pnpm@10.15.0 test` and the acceptance/integration/packaging/release-gate suites relevant to the change.
5. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1`.
6. Run `corepack pnpm@10.15.0 build` and, if the repository packaging gate is healthy, `corepack pnpm@10.15.0 package:windows` to rebuild the Windows deliverables.
7. Run `git diff --check`, review the complete diff, and verify no `.vscode`, `native/windows-ocr/bin`, `native/windows-ocr/obj`, local artifacts, secrets, or unrelated generated files are staged.
8. Stage only the intentional source, tests, documentation, migrations, and required release metadata already belonging to the approved cumulative work.
9. Create one local commit on `dev` and do not push.
10. Audit the resulting commit contents and report passing gates separately from any external/manual release prerequisites.
