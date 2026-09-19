# lnwjud coding conventions

Audit date: 2026-09-19

## Language and typing

- TypeScript is strict and uses NodeNext ESM.
- Public functions/methods are expected to have explicit return types.
- Explicit `any` is rejected by ESLint.
- Optional fields are treated precisely through `exactOptionalPropertyTypes`.
- Indexed reads must handle undefined through `noUncheckedIndexedAccess`.

## Error handling

Core packages commonly use the domain `Result` contract with `ok(...)`, `err(...)` and typed `appError(...)` rather than throwing across package/service boundaries.

Throwing remains appropriate inside narrowly scoped startup, parsing or native-provider code when the caller converts the failure into the product's structured status/error contract.

External boundaries must sanitize/redact diagnostic text before it is exposed or persisted.

## Naming and files

The repository predominantly uses:
- kebab-case filenames,
- PascalCase React components/classes/types,
- camelCase functions/variables,
- explicit service/repository/backend suffixes where ownership matters,
- colocated `*.test.ts` unit/service tests and `apps/desktop/tests` for Desktop acceptance/service tests.

## Shared-code policy

Shared abstractions should be created when the same semantic rule is duplicated and has one stable owner. Examples worth consolidating include duplicated durable-goal helpers such as:
- bounded text normalization,
- bounded string-array normalization,
- lease-token hashing.

Do not centralize trivial local structural guards merely to reduce duplicate lines. For example, many modules define a one-line `isRecord()` at independent trust boundaries. Moving all of them into one shared dependency would increase coupling with little behavioral value.

Renderer shared primitives already exist. New pages should reuse those primitives when semantics match, but a component should not be generalized solely because two screens happen to share CSS.

## Validation boundaries

Boundary data is validated close to the boundary:
- Zod schemas for MCP tool input.
- IPC decoding/guards between main, preload and renderer.
- External MCP tool catalog/schema validation.
- Native-host protocol validation.
- Workspace/path guards before file or process mutation.

The current working tree also moves incident classification validation into the IPC contract package so producer and preload consumer share one definition. That is consistent with the repository's preferred ownership model.

## Testing rule

Add or change tests when behavior, validation, workflow, API/integration contracts or a meaningful regression changes. Do not create tests merely for text, CSS, formatting, comments or implementation details.

For bug fixes, first create or identify a red-capable feedback loop at the actual seam. The Serena lifecycle and skill-routing changes in this audit followed that rule.

## Refactoring rule

Before changing important logic:
1. locate the authoritative symbol,
2. inspect references/implementations,
3. identify state ownership,
4. preserve or deliberately migrate the public contract,
5. run the smallest sufficient verification,
6. then check cross-file diagnostics/impact.

Large-file refactors should be staged as contract-preserving extractions before behavior changes.
