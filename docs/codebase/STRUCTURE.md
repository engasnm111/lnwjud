# lnwjud repository structure

Audit date: 2026-09-19

## Top-level layout

```text
apps/
  cli/                 CLI/stdio MCP host
  desktop/             Electron desktop application
packages/
  application/         use-case/application services
  audit/               audit event model/redaction
  capabilities/        local/native capability implementations
  codex/               Codex integration
  domain/              result/error/domain contracts
  extensions/          skill catalog + external MCP sessions
  filesystem/          guarded file operations
  git/                 Git service
  ipc-contracts/       main/preload/renderer IPC contracts
  mcp-server/          MCP registry/transports/runtime facades
  permissions/         permission profiles/policies
  process/             process execution/tree termination
  project/             project services
  search/              indexing/context-economy/search
  shared/              low-coupling shared contracts/helpers
  storage/             SQLite repositories/backup/recovery
  workspace/           workspace path/scope model
native/
  linux-host/
  macos-host/
  windows-*/
scripts/                build, packaging, release, runtime-tool scripts
tests/                  cross-package integration/release/packaging tests
docs/                   architecture, development, benchmarks and plans
.github/workflows/      CI, release and runtime-dependency automation
.agents/skills/         workspace agent skills
```

## Composition roots

Desktop production composition is concentrated in `apps/desktop/src/main/desktop-services.ts`, especially `createDesktopRuntime`. It constructs repositories, application services, capability providers, external MCP/skill services, durable goals, tunnel/auth services, Doctor/readiness state and the public Desktop runtime facade.

CLI/stdio composition lives in `apps/cli/src/runtime/stdio-mcp-runtime.ts` and constructs the same core services without Electron renderer/main-process concerns.

The MCP tool surface is composed in `packages/mcp-server`, with `ToolRegistry` applying schemas, workspace routing, permissions, mutation policy, activity/telemetry and Ponytail policy before tool execution.

## Renderer structure

The renderer is feature-oriented under `apps/desktop/src/renderer/features/*`. Shared renderer primitives already exist, notably:
- `features/ui/UiPrimitives.tsx`
- `features/settings/SettingSwitch.tsx`
- tool-readiness/catalog presentation helpers
- shared date/time and clipboard helpers

The renderer is therefore not missing a shared-component layer entirely. Remaining maintainability work should target state ownership and large page/application coordinators rather than mechanically moving every component into a global UI folder.

## Generated/local data boundaries

Automatic code/search context must exclude generated and local-only trees. Existing context-economy work covers directories such as:
- `.codegraph`
- `.local-artifacts`
- `.pnpm-store`
- `.serena`
- `.superpowers`
- `.worktrees`
- `playwright-report`
- `test-results`

Explicit user reads can still address ignored content when intentionally requested.

A generic scanner used during this audit initially counted local artifacts and reported more than two million lines. That figure is not a source-code metric. For architecture findings, Git-tracked files are the authoritative source set.

## Current structural hotspots

Largest Git-tracked implementation files observed:
- `packages/mcp-server/src/upgrade-runtime.ts`: about 3,130 lines.
- `packages/storage/src/goal-repository.ts`: about 3,077 lines.
- `apps/desktop/src/main/main.ts`: about 2,662 lines.
- `apps/desktop/src/main/desktop-services.ts`: about 2,570 lines.
- `apps/desktop/src/main/tunnel-controller.ts`: about 1,882 lines.
- `packages/mcp-server/src/tool-registry.ts`: about 1,419 lines.
- `apps/desktop/src/preload/index.ts`: about 1,418 lines.
- `packages/application/src/goal-continuation-service.ts`: about 1,392 lines.
- `packages/application/src/scheduled-continuation-service.ts`: about 1,259 lines.

High-churn source files over the last 90 days include `desktop-services.ts`, `main.ts`, `tool-registry.ts`, preload and IPC contracts. This combination of size + churn is a stronger refactor signal than line count alone.

## Structural rule for future refactors

Split by stable responsibility and state ownership, not by arbitrary line count. A useful extraction should:
1. have a clear input/output contract,
2. remove state or policy from a composition root,
3. be independently testable,
4. avoid introducing a reverse dependency,
5. preserve one authoritative source of truth.
