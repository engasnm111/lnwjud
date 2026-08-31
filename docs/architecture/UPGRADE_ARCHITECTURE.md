# lnwjud Upgrade Architecture Contract

Status: God-Tier local-first implementation checkpoint for `v4.0.0`.

This document is the architectural boundary for the upgrade roadmap. It describes
the existing runtime before Phase 01 and the invariants every later phase must
preserve. The upgrade adds speed, context delivery, automation, and observability;
it does not remove capabilities or turn ranking into authorization.

The phase-by-phase implementation checklist is
[`ROADMAP_PHASE_STATUS.md`](./ROADMAP_PHASE_STATUS.md).

## Non-negotiable invariants

1. **Unlimited capability, bounded transport.** Large results may be paged,
   streamed, or continued, but the underlying workspace capability must remain
   available. No new feature may silently discard files, matches, symbols, Git
   state, logs, or child-tool results.
2. **Primitive tools remain callable.** Compound tools, routers, recipes, and
   facades reduce round trips; they never replace `read_file`, search, Git,
   process, shell, browser, Windows, logs, tests, or workspace primitives.
3. **Authorization is independent from ranking.** Context ordering is an
   optimization. In standard mode path guards, command policy, permission
   profiles, ownership, and hard blocks remain authoritative. Explicit trusted
   Full Bypass skips lnwjud application authorization but ranking never enables it.
4. **Deterministic work stays local.** Search, file enumeration, Git parsing,
   symbol extraction, cache lookup, routing, policy checks, and test discovery
   must not require an LLM call.
5. **Every operation is traceable.** MCP calls, compound children, recipes,
   hooks, delegated agents, cache decisions, and failures must remain visible in
   structured activity/audit data and the Live Logs pipeline.
6. **Destructive work is never automatically repeated.** Retries may apply to
   safe reads and transport failures only. Writes, deletes, Git destructive
   commands, input events, and external side effects require explicit policy.

## Runtime topology

```text
MCP clients (ChatGPT / Codex / Claude / other agents)
                         |
                         v
             MCP stdio or loopback Streamable HTTP
                         |
                         v
                  ToolRegistry (231 total definitions; 195 default; 201 with Codex)
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
  Raw tools       Future execution      Extensions / bridge
                 and context engines   skills + child MCP
       |                 |                  |
       +-----------------+------------------+
                         v
              application services + policy
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
  filesystem/search     Git/process/Codex  Windows/browser/media/Office
                         |
                         v
                  storage + audit/activity
                         |
                         v
              Electron IPC -> Live Logs/UI
```

### Package boundaries

| Layer | Current responsibility | Upgrade extension point |
| --- | --- | --- |
| `packages/domain` | IDs, errors, result contracts, policy-neutral types | context/page/task IDs |
| `packages/application` | workspace, file, search, Git, process, project, Codex, doctor use cases | parallel/context/index/recipe services |
| `packages/workspace` | workspace registration, root/path guards, secret policy | index ownership and invalidation |
| `packages/filesystem` | bounded text/binary reads, writes, checkpoints, patching | resumable reads and read-many primitives |
| `packages/search` | executable resolution, direct ripgrep search, and context-economy policy primitives | indexed search, continuation, and deterministic summaries |
| `packages/git` | argument-array Git adapter and structured parsers | change intelligence and diff context |
| `packages/process` | owned process trees, output buffers, cancellation | batch workers and task runtime |
| `packages/codex` | executable/capability discovery and owned Codex tasks | delegation/session handoff |
| `packages/permissions` | safe/balanced/full/custom profiles and hard blocks | Permission System v2 policy graph |
| `packages/audit` | redaction and structured audit events | child-call, cache, hook and planner events |
| `packages/storage` | SQLite database, migrations, repositories | index/cache/session/telemetry stores |
| `packages/mcp-server` | tool definitions, registry, stdio/HTTP transports | batch/context/router/recipe registration |
| `packages/capabilities` | shell, CDP, Windows UI, input, vision, media, Office, scheduler, WSL, OCR boundary | Windows/browser intelligence |
| `packages/extensions` | skills and local MCP bridge discovery/calls | plugin SDK, schema registry, aliases |
| `packages/ipc-contracts` | typed Electron main/preload/renderer contracts | dashboard and Live Logs v2 contracts |
| `apps/cli` | CLI runtime and packaged stdio launcher | benchmark and automation entrypoints |
| `apps/desktop` | Electron lifecycle, local HTTP, tunnel, IPC, renderer | observability, planner and session UI |

`domain` and `application` must not import Electron, React, SQLite
implementations, or MCP transport classes. Transport adapters call application
services; they never bypass path, command, permission, ownership, or audit
boundaries.

## God-Tier local-first vertical slices

The current additive implementation keeps the original primitive pipeline and
builds the high-impact slices on top of it:

| Slice | Runtime boundary | Truthful fallback |
| --- | --- | --- |
| WSL runner | `WslCapabilityBackend` delegates argv/task lifecycle to `ShellCapabilityBackend`; `WslFilesystemCapabilityBackend` only maps paths/metadata | missing `wsl.exe`, distro, timeout, cancellation, and escape are explicit errors/statuses |
| Set-of-Marks | `SetOfMarksService` correlates Accessibility observation + vision PNG, stores TTL/hash, then revalidates the mark before action | unknown, stale, expired, cross-workspace, or unconfirmed actions are rejected |
| WinRT OCR | `VisionCapabilityBackend` routes only `action: ocr` to `WindowsOcrCapabilityBackend` and the packaged C# helper | no package identity/helper/language returns `available: false` |
| Router | deterministic token/tag scorer with primitive visibility, reason codes, permission metadata, and local-rerank fallback | ranking never grants permission and local data never leaves the machine |
| Durable Goal Continuation | `GoalContinuationService` + SQLite `goals`/append-only `goal_checkpoints`; stable client ownership, expiring hashed-token leases, revision CAS, active task IDs | corrupt state, stale revisions, wrong owner/lease, or terminal mutations fail closed; a resumed turn inspects persisted state instead of repeating work |
| Tool Catalog + Doctor | live `ToolRegistry` metadata + cached main-process requirement registry + typed remediation registry feed both renderer surfaces | safe probe failure is `unknown`/`needs_setup`, permission deny is `blocked`, and renderer/external MCP text cannot manufacture trusted commands, URLs, or permission claims |
| Later Windows/dev/productivity waves | catalog descriptors include requirements, availability, cancellation, dry-run, and audit target; Sandbox has an artifact-only WSB plan | missing optional runtime is `optional`/`planned`, never a fake successful execution |

Long-running operations use the existing task handles where a concrete backend
exists. Activity events now carry bounded `traceId`/`traceParent` values into
NDJSON and SQLite audit metadata. The 184-tool snapshot remains a historical
compatibility baseline. The complete inventory contains 231 tool definitions.
Current transports advertise 195 by default or 201 when the six Codex delegation
tools are enabled; planned and feature-disabled definitions remain inventory-only,
and registry additions remain append-only.

Tool readiness is deliberately not an execution probe. Main process checks only owned/read-only dependency and status surfaces with bounded timeouts, caches the result, and projects one snapshot into both the Tools page and Doctor. A selected recheck refreshes the affected requirement and recomputes both surfaces atomically. Required Doctor `fail`/`unknown` blocks the startup gate; optional failures do not. Setup and Portable consume the same compiled main/preload/renderer catalog and Doctor code paths.

## Request and side-effect pipeline

```text
MCP/IPC input
  -> Zod/schema validation
  -> normalized workspace/path/command resolution
  -> workspace and ownership checks
  -> trusted invocation authorization (standard or full_bypass)
  -> permission profile + hard-block decision when Full Bypass is OFF
  -> application service
  -> guarded adapter (shell:false / argument arrays where applicable)
  -> sanitized result + bounded transport metadata
  -> activity tracker + audit sink
  -> renderer/Live Logs event
```

Read operations may be bounded at the transport boundary only when the result
contains explicit truncation/continuation metadata. Future phases must add
continuation rather than lowering an existing limit silently.

## MCP transports and lifecycle

### stdio

- MCP protocol is the only stdout payload; diagnostics go to stderr.
- The packaged direct-node `lnwjud-mcp-stdio.cmd` launcher remains available
  for direct local stdio hosts such as Codex CLI. Secure Tunnel does **not** use
  this headless runtime; it forwards to the Desktop loopback HTTP MCP and uses
  Desktop profile/Full Bypass state. Active Project and native approval remain
  authoritative only while Desktop Full Bypass is OFF.
- Closing the peer is a normal shutdown; owned runtime resources are closed once.

### loopback Streamable HTTP

- Endpoint is `/mcp`.
- Default bind is `127.0.0.1`; an ephemeral port is used when the preferred
  port is unavailable.
- Host and Origin policy rejects non-local origins; body size, method, and
  header validation remain enabled.
- The HTTP server and stdio server share the same `ToolRegistry` and
  application services.

### Secure MCP Tunnel

The desktop owns the `tunnel-client` child it starts, ensures its loopback HTTP
MCP is running, and rewrites the tunnel profile to `mcp.server_urls` using the
current Desktop `/mcp` endpoint. The tunnel therefore shares the same dynamic
Active Project provider, permission profile, activity tracker, and native
exact-action approval provider and Desktop Full Bypass state as local Desktop MCP.
Standalone/headless stdio fails closed for mutations requiring host approval when
its independent STDIO Full Bypass is OFF. The controller records
the persistent tunnel log, distinguishes owned from externally started clients,
and surfaces unexpected exits/reconnect state.

## Security and permission boundary

- Workspace paths are normalized and checked against registered roots and
  reparse/junction traversal rules.
- Secret-file policy is denied by default for sensitive filenames and paths.
- Permission profiles are `safe`, `balanced`, `full`, and `custom`. Desktop MCP
  uses the selected profile; packaged stdio keeps `full` as the backward-compatible
  default and can use a separately configured profile plus optional Strict Roots.
- Desktop HTTP/Secure Tunnel and direct STDIO expose separate Full Bypass toggles
  under Full Access (Unrestricted). They default OFF, require profile `full`, and
  are never inferred merely from selecting Full.
- Trusted Full Bypass skips all lnwjud application prompts/denials, including
  always-confirm tools, host approval, command policy, Active Project/allowed
  roots/protected paths, explicit absolute outside targets, and `goalLease`. The
  authorization travels out-of-band and never rewrites caller `userConfirmed`.
- `READ` is non-mutating, `WRITE` changes workspace data, `EXECUTE` starts or
  controls processes/commands, and `DANGEROUS` covers destructive, interactive,
  external, or full-access meta operations.
- With Full Bypass OFF, disk format, shutdown, workspace-root deletion, and other
  hard-blocked actions remain denied regardless of profile. Full Bypass skips those
  application policies, while schema validation, exact owned-handle/worktree checks,
  Windows ACL/UAC, provider availability, and external policy still apply.
- Child MCP servers reached through `mcp_call` retain their own side-effect
  contract; the bridge does not flatten or silently reclassify them.

## Audit, activity, and Live Logs

`ActivityTracker` assigns a call ID and records start/completion, tool name,
result code, duration, workspace/target summary, and sanitized error metadata.
The file sink writes NDJSON to the application data directory; the audit sink
stores redacted structured events in SQLite. A sink failure must not break the
tool call.

`LogHub` merges three sources:

1. `tunnel`: persistent `lnwjud-tunnel.log` tail;
2. `mcp`: activity NDJSON plus synchronized work-log entries;
3. `process`: owned-process summaries and output metadata.

The desktop main process emits snapshots and incremental IPC events. The
renderer keeps live lines that arrive while a snapshot is in flight, deduplicates
by line ID, and supports source tabs, clear, export, and a pop-out viewer. File
tailing retains partial UTF-8 lines across read chunks so Live Logs never turns
one large JSON log entry into unrelated fragments.

## Phase 00 baseline checkpoint

The automated synthetic benchmark runs seven representative workflows over the
real built MCP HTTP runtime and a disposable Git workspace. The v1.1.4 baseline
recorded:

| Metric | Baseline |
| --- | ---: |
| Tool catalog | 53 tools |
| Runs | 3 per scenario |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 97.38 ms |
| p50 tool latency | 60.93 ms |
| p95 tool latency | 761 ms |
| Average workflow latency | 264.39 ms |
| p50 workflow latency | 177.25 ms |
| p95 workflow latency | 808.65 ms |
| Bytes transferred | 98,340 |
| Result bytes | 53,177 |
| Errors / retries | 0 / 0 |

Full per-scenario measurements and the discovered catalog are in
[`../benchmarks/BASELINE.md`](../benchmarks/BASELINE.md). The runner is
[`../../scripts/benchmark-mcp.mjs`](../../scripts/benchmark-mcp.mjs) and must
remain repeatable after every performance phase.

## Phase 01 safety checkpoint

`tool_batch` is additive and routes every child through `ToolRegistry.invoke`.
That preserves schema validation, application policy, activity/audit start and
completion events, and Live Logs visibility for the parent and every child.
Independent read-only children may run concurrently. A child that is not
strictly `READ` plus read-only and non-destructive is treated as mutation work
and is serialized inside a batch, so one compound request cannot fan out
multiple side effects accidentally. A failed, timed-out, or cancelled child is
reported in the combined result without discarding successful siblings.

## Phase 02 context checkpoint

The local context engine adds `workspace_context` and continuation plus
`workspace_full_scan`, `workspace_snapshot`, `search_all`, and
`read_many_files`. It searches registered workspaces in parallel, ranks without
an LLM, reads selected candidates in parallel, and reports the files scanned,
matches, symbols, Git/test relevance, and remaining context. Page and response
targets shape transport size only; they do not hide a path from direct search or
read. Automatic discovery starts with relevant source/config ranges and filters
vendor/build/cache, binary, and generated paths. Explicit file reads, full
scans, and explicit search/index overrides remain available for every path
allowed by the existing workspace boundary, including environment and vendor
paths.

## Phase 03 streaming checkpoint

`read_file_page` and `read_file_page_continue` provide deterministic line chunks
with explicit `startLine`, `endLine`, `hasMore`, and continuation tokens. The
original `read_file` remains the lossless primitive; paged reads are an additive
transport adapter for large responses. A page can target a response byte size,
and the continuation state advances from the exact returned line so a caller can
resume without silently skipping or overwriting context.

## Phase 04 indexing checkpoint

`WorkspaceIndexService` persists a full structural index outside the repository
data tree and records files, directories, symlinks, hashes, Git blob hashes,
language, tests, package metadata, symbols, imports, exports, functions,
classes, and interfaces. Initial indexing applies the automatic context policy
to vendor/build/cache, binary, and generated paths while retaining metadata for
relevant source/config files. The watcher applies the same policy before
enqueueing and limits active workers. Explicit index options can include a
skipped subtree; a watcher stop drains the queue before closing.

## Phase 05–14 foundation checkpoint

The deterministic upgrade catalog now exposes code-intelligence queries,
compound context routes, intent routing, inspectable recipes, dry-run plans,
Git/test context contracts, cache operations, lifecycle-hook descriptors, and
the Permission v2 policy classes. These tools are additive: the raw tools and
the full-visibility index remain callable, and the context facade reports its
internal plan plus continuation/fallback paths.

The roadmap catalog is intentionally discoverable on demand through
`capabilities`, `tool_search`, `tool_describe`, and `tool_categories`; this
reduces schema pressure on clients without removing any capability from the
runtime catalog.

## Phase 41 context-economy checkpoint

`ContextEconomyRuntime` sits between discovery and context delivery. It applies
deterministic path/content classification, changed-first ranking, metadata or
symbol-range-first delivery, bounded duplicate hashing, and a short-lived
in-memory Context Ledger. The ledger can mark a file `unchanged`, return a
line `diff`, or reference duplicate content; it never persists raw file data or
credentials. `context_economy_stats` and `telemetry_dashboard` expose raw
discovered bytes, delivered bytes, skipped generated/binary paths, duplicate
bytes avoided, ledger hits, and estimated savings. Automatic ignore is not
authorization: `read_file`, `read_many_files`, full scans, and explicit search
or index requests retain full permitted access.

## Upgrade sequencing

The safe dependency direction is:

```text
Phase 00 contract
  -> Phase 01 parallel primitives
  -> Phase 02 context aggregation
  -> Phase 03 continuation/streaming
  -> Phase 04 full-visibility index/watcher
  -> Phase 05 code intelligence
  -> Phase 06 lossless ranking
  -> Phase 13 cache
  -> compound/router/recipe/dry-run/Git/test intelligence
  -> hooks/skills/plugins/schema/capability discovery
  -> browser/Windows/visual validation
  -> session/gateway/task/agent/multi-agent/handoff
  -> response/permission/audit/telemetry/planner/resilience/benchmark hardening
```

Each phase adds tests and preserves the baseline primitive catalog. A later
phase may improve latency or context delivery, but it may not make a previously
working capability unavailable merely because a new compound path exists.

## Multi-workspace concurrency checkpoint

The next architecture wave is specified in
[`MULTI_WORKSPACE_CONCURRENCY.md`](./MULTI_WORKSPACE_CONCURRENCY.md). The key
separation is `selectedWorkspace` (desktop UI state) versus request `workspaceId`
(operation scope) versus MCP `sessionId` (handle/log ownership). The target is one
installation/tunnel/MCP surface serving concurrent sessions and workspaces with
one global settings model. The upgrade must also replace the single-owner STDIO
activity snapshot and shared `upgrade-runtime.json` write path before claiming
full multi-session safety.
