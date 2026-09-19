# lnwjud tech stack

Audit date: 2026-09-19
Scope: Git-tracked source and release configuration in `E:\lnwjud`. Generated/local artifacts are excluded from source metrics.

## Runtime and language baseline

- Node.js: `>=24.0.0 <25`.
- Package manager: `pnpm@10.15.0` through Corepack.
- Primary language: TypeScript, target ES2022, NodeNext modules.
- TypeScript: `6.0.2`.
- Desktop UI: React `19.1.1` / React DOM `19.1.1`.
- Desktop shell: Electron `45.0.0-alpha.7`.
- Desktop bundling: esbuild `0.25.12`, Vite `7.3.6`.
- Unit/service tests: Vitest `3.2.4`.
- Packaged desktop E2E: Playwright `1.55.0`.
- MCP SDK: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` `2.0.0`.
- Validation: Zod `4.2.0`.
- Persistent state: Node `node:sqlite` via the storage package.
- Native hosts: Swift package for macOS and Rust/Cargo host for Linux; Windows native helpers/providers are composed separately.

Authoritative manifests: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/desktop/package.json`, package-local `package.json` files.

## TypeScript and lint policy

`tsconfig.base.json` enables:
- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `verbatimModuleSyntax`
- `isolatedModules`
- `forceConsistentCasingInFileNames`

`eslint.config.mjs` additionally enforces:
- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/explicit-function-return-type: error`

Build output, dependencies, coverage, local artifacts, worktrees and temporary directories are excluded from lint.

## Workspace shape

The pnpm workspace currently contains 19 apps/packages. A dependency-graph scan on 2026-09-19 found no workspace-package cycles.

Major layers:
- `apps/desktop`: Electron application and packaged runtime.
- `apps/cli`: local stdio/CLI composition root.
- `packages/application`: application services/workflows.
- `packages/domain`: shared domain/result types.
- `packages/storage`: SQLite-backed repositories, backup/recovery and durable state.
- `packages/mcp-server`: MCP tool registry, HTTP transport, upgrade/runtime facades.
- `packages/extensions`: local skills and external MCP bridge.
- `packages/capabilities`: platform/native capability backends.
- `packages/process`, `filesystem`, `git`, `search`, `permissions`, `workspace`, `shared`, etc.

## Release and packaging tools

- Windows: PowerShell release scripts plus electron-builder NSIS/portable packaging.
- macOS: target-native DMG/ZIP packaging and target-native verification.
- Linux: target-native AppImage/DEB packaging.
- Secure tunnel binary provenance: cosign/SLSA verification in release CI.
- Runtime tools include pinned external binaries such as tunnel-client, ripgrep and the optional PDF/Poppler provider.

## Dependency state observed during this audit

`pnpm outdated -r --format json` reported available updates including:
- `ecc-agentshield 1.4.0 -> 1.6.0`
- `electron-builder 26.0.12 -> 26.15.3`
- `@playwright/test 1.55.0 -> 1.63.0`
- `react/react-dom 19.1.1 -> 19.3.0`
- `zod 4.2.0 -> 4.6.5`
- `typescript-eslint 8.67.0 -> 8.70.0`

Major-version updates also exist for ESLint, TypeScript, Vite and Vitest. They should be handled as isolated migration work, not bundled into reliability/security fixes.

Electron `45.0.0-alpha.7` is intentionally pinned by current crash-diagnostics work and must not be changed merely because a different version is newer.
