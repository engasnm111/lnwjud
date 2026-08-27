# lnwjud Tool Contract

Status: God-Tier Wave 0–8 additive contract snapshot for `v4.0.0`.

This is the compatibility contract for the current MCP surface. The runtime
advertises the JSON Schema for every input through `tools/list`; the TypeScript
Zod schemas in `packages/mcp-server/src/tools/` are the implementation source
of truth. The existing human-oriented catalog remains useful for field details,
while this document records the primitive/core contract, preserves the earlier
compatibility baseline, and records policy class, annotations, and schema source.
The full configurable v4 registry contains 223 tools; the default runtime advertises 217 because the six `codex_*` delegation tools are opt-in. The additive v4 entries are defined
in `packages/mcp-server/src/upgrade-catalog.ts` and the exact runtime order is
verified by `packages/mcp-server/src/tool-registry.test.ts`.

<!-- BEGIN GENERATED TOOL REGISTRY -->
## Generated live ToolRegistry index

This block is generated from the built `ToolRegistry`. Current count: **223 tools**.
Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.

| # | Tool | Permission | Read-only | Destructive |
| ---: | --- | --- | :---: | :---: |
| 1 | `workspace_list` | READ | yes | no |
| 2 | `workspace_register` | WRITE | no | no |
| 3 | `workspace_info` | READ | yes | no |
| 4 | `workspace_tree` | READ | yes | no |
| 5 | `project_snapshot` | READ | yes | no |
| 6 | `read_file` | READ | yes | no |
| 7 | `read_files` | READ | yes | no |
| 8 | `search_files` | READ | yes | no |
| 9 | `search_text` | READ | yes | no |
| 10 | `git_status` | READ | yes | no |
| 11 | `git_diff` | READ | yes | no |
| 12 | `git_log` | READ | yes | no |
| 13 | `git` | EXECUTE | no | yes |
| 14 | `write_file` | WRITE | no | no |
| 15 | `apply_patch` | WRITE | no | no |
| 16 | `edit_file` | WRITE | no | no |
| 17 | `move_file` | WRITE | no | no |
| 18 | `copy_file` | WRITE | no | no |
| 19 | `delete_file` | DANGEROUS | no | yes |
| 20 | `list_recovery_items` | READ | yes | no |
| 21 | `restore_deleted_file` | WRITE | no | no |
| 22 | `list_checkpoints` | READ | yes | no |
| 23 | `restore_checkpoint` | WRITE | no | yes |
| 24 | `process_start` | EXECUTE | no | no |
| 25 | `process_list` | READ | yes | no |
| 26 | `process_status` | READ | yes | no |
| 27 | `process_logs` | READ | yes | no |
| 28 | `process_stop` | EXECUTE | no | no |
| 29 | `project_dev` | EXECUTE | no | no |
| 30 | `project_test` | EXECUTE | no | no |
| 31 | `project_lint` | EXECUTE | no | no |
| 32 | `project_typecheck` | EXECUTE | no | no |
| 33 | `project_build` | EXECUTE | no | no |
| 34 | `codex_status` | READ | yes | no |
| 35 | `codex_run` | EXECUTE | no | no |
| 36 | `codex_task_list` | READ | yes | no |
| 37 | `codex_task_status` | READ | yes | no |
| 38 | `codex_task_logs` | READ | yes | no |
| 39 | `codex_stop` | EXECUTE | no | no |
| 40 | `shell` | EXECUTE | no | yes |
| 41 | `dom_cdp` | READ | no | yes |
| 42 | `accessibility` | READ | no | yes |
| 43 | `input_event` | EXECUTE | no | yes |
| 44 | `vision` | READ | yes | no |
| 45 | `vision_annotated_capture` | READ | yes | no |
| 46 | `ui_target_action` | EXECUTE | no | yes |
| 47 | `window` | EXECUTE | no | yes |
| 48 | `health` | READ | yes | no |
| 49 | `system_info` | READ | yes | no |
| 50 | `notification` | EXECUTE | no | no |
| 51 | `file_dialog` | EXECUTE | yes | no |
| 52 | `clipboard` | EXECUTE | no | no |
| 53 | `web_fetch` | READ | no | yes |
| 54 | `audio` | EXECUTE | no | yes |
| 55 | `screen_record` | EXECUTE | no | yes |
| 56 | `office` | WRITE | no | no |
| 57 | `scheduler` | EXECUTE | no | yes |
| 58 | `wsl_exec` | EXECUTE | no | yes |
| 59 | `wsl_fs` | READ | yes | no |
| 60 | `skills_list` | READ | yes | no |
| 61 | `skills_read` | READ | yes | no |
| 62 | `mcp_list` | READ | yes | no |
| 63 | `mcp_describe` | READ | yes | no |
| 64 | `mcp_call` | DANGEROUS | no | yes |
| 65 | `workspace_context` | READ | yes | no |
| 66 | `workspace_context_continue` | READ | yes | no |
| 67 | `workspace_full_scan` | READ | yes | no |
| 68 | `workspace_full_scan_continue` | READ | yes | no |
| 69 | `workspace_snapshot` | READ | yes | no |
| 70 | `search_all` | READ | yes | no |
| 71 | `read_many_files` | READ | yes | no |
| 72 | `read_file_page` | READ | yes | no |
| 73 | `read_file_page_continue` | READ | yes | no |
| 74 | `workspace_index` | READ | yes | no |
| 75 | `workspace_index_status` | READ | yes | no |
| 76 | `workspace_index_watch` | READ | yes | no |
| 77 | `workspace_index_stop` | READ | yes | no |
| 78 | `session_handoff` | READ | yes | no |
| 79 | `verify_incremental` | EXECUTE | no | no |
| 80 | `run_goal` | WRITE | no | no |
| 81 | `get_goal` | READ | yes | no |
| 82 | `checkpoint_goal` | WRITE | no | no |
| 83 | `finish_goal` | WRITE | no | no |
| 84 | `list_goals` | READ | yes | no |
| 85 | `symbol_search` | READ | yes | no |
| 86 | `find_definition` | READ | yes | no |
| 87 | `find_references` | READ | yes | no |
| 88 | `find_implementations` | READ | yes | no |
| 89 | `call_hierarchy` | READ | yes | no |
| 90 | `import_graph` | READ | yes | no |
| 91 | `dependency_graph` | READ | yes | no |
| 92 | `module_graph` | READ | yes | no |
| 93 | `type_search` | READ | yes | no |
| 94 | `trace_symbol` | READ | yes | no |
| 95 | `context_ranking` | READ | yes | no |
| 96 | `debug_context` | READ | yes | no |
| 97 | `review_context` | READ | yes | no |
| 98 | `change_context` | READ | yes | no |
| 99 | `symbol_context` | READ | yes | no |
| 100 | `test_context` | READ | yes | no |
| 101 | `dependency_context` | READ | yes | no |
| 102 | `git_context` | READ | yes | no |
| 103 | `frontend_context` | READ | yes | no |
| 104 | `backend_context` | READ | yes | no |
| 105 | `route_intent` | READ | yes | no |
| 106 | `recipe_list` | READ | yes | no |
| 107 | `recipe_describe` | READ | yes | no |
| 108 | `recipe_run` | EXECUTE | no | no |
| 109 | `dry_run` | READ | yes | no |
| 110 | `review_changes` | READ | yes | no |
| 111 | `changed_symbols` | READ | yes | no |
| 112 | `affected_modules` | READ | yes | no |
| 113 | `git_history_context` | READ | yes | no |
| 114 | `git_blame_context` | READ | yes | no |
| 115 | `discover_tests` | READ | yes | no |
| 116 | `run_affected_tests` | EXECUTE | no | no |
| 117 | `test_failures` | READ | yes | no |
| 118 | `coverage_context` | READ | yes | no |
| 119 | `test_history` | READ | yes | no |
| 120 | `cache_stats` | READ | yes | no |
| 121 | `cache_clear` | WRITE | no | no |
| 122 | `cache_invalidate` | WRITE | no | no |
| 123 | `hook_list` | READ | yes | no |
| 124 | `hook_register` | WRITE | no | no |
| 125 | `hook_remove` | WRITE | no | no |
| 126 | `skill_match` | READ | yes | no |
| 127 | `skill_load` | READ | yes | no |
| 128 | `plugin_install` | WRITE | no | no |
| 129 | `plugin_list` | READ | yes | no |
| 130 | `plugin_enable` | WRITE | no | no |
| 131 | `plugin_disable` | WRITE | no | no |
| 132 | `plugin_remove` | DANGEROUS | no | yes |
| 133 | `session_context` | READ | yes | no |
| 134 | `session_checkpoint` | WRITE | no | no |
| 135 | `session_resume` | READ | yes | no |
| 136 | `session_history` | READ | yes | no |
| 137 | `response_mode` | READ | yes | no |
| 138 | `inspect_web_app` | READ | yes | no |
| 139 | `debug_ui` | READ | yes | no |
| 140 | `capture_ui_state` | READ | yes | no |
| 141 | `form_context` | READ | yes | no |
| 142 | `network_context` | READ | yes | no |
| 143 | `console_context` | READ | yes | no |
| 144 | `browser_debug_context` | READ | yes | no |
| 145 | `windows_environment` | READ | yes | no |
| 146 | `service_context` | READ | yes | no |
| 147 | `process_context` | READ | yes | no |
| 148 | `port_context` | READ | yes | no |
| 149 | `registry_context` | READ | yes | no |
| 150 | `event_log_context` | READ | yes | no |
| 151 | `installed_runtime_context` | READ | yes | no |
| 152 | `path_context` | READ | yes | no |
| 153 | `startup_context` | READ | yes | no |
| 154 | `mcp_discover` | READ | yes | no |
| 155 | `mcp_health` | READ | yes | no |
| 156 | `mcp_resources` | READ | yes | no |
| 157 | `task_create` | EXECUTE | no | no |
| 158 | `task_status` | READ | yes | no |
| 159 | `task_cancel` | EXECUTE | no | no |
| 160 | `task_result` | READ | yes | no |
| 161 | `task_list` | READ | yes | no |
| 162 | `delegate` | EXECUTE | no | no |
| 163 | `delegate_status` | READ | yes | no |
| 164 | `delegate_cancel` | EXECUTE | no | no |
| 165 | `delegate_result` | READ | yes | no |
| 166 | `parallel_delegate` | EXECUTE | no | no |
| 167 | `permission_check` | READ | yes | no |
| 168 | `permission_profile` | READ | yes | no |
| 169 | `live_logs_query` | READ | yes | no |
| 170 | `live_logs_status` | READ | yes | no |
| 171 | `telemetry_dashboard` | READ | yes | no |
| 172 | `context_economy_stats` | READ | yes | no |
| 173 | `execution_plan` | READ | yes | no |
| 174 | `repo_map` | READ | yes | no |
| 175 | `context_expand` | READ | yes | no |
| 176 | `recovery_status` | READ | yes | no |
| 177 | `tool_schema_list` | READ | yes | no |
| 178 | `tool_schema_register` | WRITE | no | no |
| 179 | `capabilities` | READ | yes | no |
| 180 | `tool_search` | READ | yes | no |
| 181 | `tool_dynamic_filter` | READ | yes | no |
| 182 | `tool_describe` | READ | yes | no |
| 183 | `tool_categories` | READ | yes | no |
| 184 | `tool_function_find` | READ | yes | no |
| 185 | `tool_aliases` | READ | yes | no |
| 186 | `mcp_hub` | READ | yes | no |
| 187 | `dev_context` | READ | yes | no |
| 188 | `recipe_catalog` | READ | yes | no |
| 189 | `capture_screenshot` | READ | yes | no |
| 190 | `compare_screenshot` | READ | yes | no |
| 191 | `dom_snapshot` | READ | yes | no |
| 192 | `layout_metadata` | READ | yes | no |
| 193 | `visual_context` | READ | yes | no |
| 194 | `inspect_workbook` | READ | yes | no |
| 195 | `compare_workbook_layout` | READ | yes | no |
| 196 | `render_excel_preview` | READ | yes | no |
| 197 | `inspect_pdf` | READ | yes | no |
| 198 | `compare_pdf_pages` | READ | yes | no |
| 199 | `project_profile_get` | READ | yes | no |
| 200 | `project_profile_set` | WRITE | no | no |
| 201 | `handoff_context` | READ | yes | no |
| 202 | `benchmark_run` | EXECUTE | no | no |
| 203 | `regression_report` | READ | yes | no |
| 204 | `sandbox_exec` | EXECUTE | no | no |
| 205 | `event_watch` | EXECUTE | no | no |
| 206 | `crash_trace` | READ | yes | no |
| 207 | `lsp_diagnostics` | READ | yes | no |
| 208 | `lsp_rename` | WRITE | no | no |
| 209 | `debug_attach` | EXECUTE | no | no |
| 210 | `debug_step` | EXECUTE | no | no |
| 211 | `git_worktree_spawn` | WRITE | no | no |
| 212 | `git_worktree_remove` | DANGEROUS | no | yes |
| 213 | `db_inspect` | READ | yes | no |
| 214 | `db_query` | READ | yes | no |
| 215 | `office_ppt` | WRITE | no | no |
| 216 | `office_outlook` | READ | yes | no |
| 217 | `pdf_extract_tables` | READ | yes | no |
| 218 | `docx_merge` | WRITE | no | no |
| 219 | `self_heal_plan` | READ | yes | no |
| 220 | `self_heal_apply` | DANGEROUS | no | yes |
| 221 | `skills_import` | WRITE | no | no |
| 222 | `agent_swarm_run` | EXECUTE | no | no |
| 223 | `tool_batch` | EXECUTE | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names and registry order are deterministic.
- Every request is schema-validated before the application service runs.
- Every result is structured JSON-compatible MCP content; errors use the
  repository error/result mapping and do not expose secrets or raw stack traces.
- `readOnlyHint` is advisory metadata for clients. It never grants permission.
- `destructiveHint` is advisory metadata for clients. Permission policy and hard
  blocks remain authoritative.
- A bounded result must report truncation, continuation, or a bounded-window
  contract. A new compound tool cannot hide data that a primitive tool can read.
- `workspaceId` is required where the operation is workspace-scoped unless an
  explicitly normalized absolute path is accepted by that tool's schema.

## Permission classes

| Class | Meaning | Existing profile behavior |
| --- | --- | --- |
| `READ` | No intentional mutation; inspection or local diagnostics | allowed by Safe/Balanced/Full |
| `WRITE` | Changes workspace files or registration state | prompts in Safe; allowed in Balanced/Full |
| `EXECUTE` | Starts/controls an owned command, process, project, or Codex task | prompts in Safe; allowed in Balanced/Full |
| `DANGEROUS` | Destructive, interactive, external, or full-access meta capability | denied in Safe; prompts in Balanced; allowed in Full subject to hard blocks |

Desktop uses its configured local permission profile. Packaged stdio keeps `full` as the backward-compatible default but accepts `safe|balanced|full|custom` through the launcher, environment, or Desktop STDIO policy settings. Optional strict-root mode suppresses automatic whole-drive registration and exposes only explicit canonical allowed roots. These controls do not disable ownership checks, realpath/reparse-point guards, Active Project mutation scope, independent host exact-action approval, or hard blocks, and strict roots are not an OS sandbox.

Mutations still require typed policy classification and explicit chat confirmation when required. The only configurable auto-approval exception is the exact `delete_file` operation when **AI File Delete Policy** is enabled and the target is a proven recoverable item inside the host Active Project. Every other approval-required mutation needs independent trusted host exact-action approval; providerless standalone/headless runtimes fail closed before dispatch. Arbitrary commands and project-owned scripts are opaque execution, not an OS sandbox, and are not automatically recoverable through Recovery Trash.

## Core primitive runtime catalog

The generated live `ToolRegistry` index above is the authoritative runtime catalog for all **223 configurable tools**. It is generated from the built registry and checked in CI. This section intentionally does not maintain a second hand-numbered primitive table, because duplicate permission/schema tables can drift from `tools/list`. The Zod schemas in `packages/mcp-server/src/tools/` and the generated table above remain the source of truth for names, permissions, annotations, ordering, and input JSON Schema.

## Schema groups and contract examples

The following examples make the required shape explicit without duplicating the
generated JSON Schema. Optional fields and bounds must remain aligned with the
source schema and the runtime `tools/list` response.

### Workspace and filesystem

```ts
workspace_list: {}
workspace_register: {
  parentWorkspaceId: string;
  path: string;
  displayName?: string;
}
workspace_info: { workspaceId: string }
workspace_tree: {
  workspaceId?: string;
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}
project_snapshot: { workspaceId: string }
read_file: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
read_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
search_files: { workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
search_text: {
  workspaceId?: string;
  path?: string;
  query: string;
  glob?: string;
  maxResults?: number;
  includeIgnored?: boolean;
}
```

`write_file`, `apply_patch`, `edit_file`, `move_file`, `copy_file`, `delete_file`,
`restore_deleted_file`, and `restore_checkpoint` retain their checkpoint/recovery,
same-workspace, secret-policy, confirmation, host-approval, and canonical
path-guard contracts. They must not acquire implicit recursive or arbitrary-root
mutation behavior.

### Git, process, project, and Codex

```ts
git_status: { workspaceId: string }
git_diff: { workspaceId: string; path?: string; staged?: boolean; maxBytes?: number }
git_log: { workspaceId: string; maxCommits?: number; maxBytes?: number }
git: { workspaceId?: string; cwd?: string; args: string[]; timeoutSeconds?: number }
process_start: { workspaceId: string; executable: string; args: string[]; cwd?: string; timeoutMs?: number }
process_list: { workspaceId: string }
process_status: { workspaceId: string; processId: string }
process_logs: { workspaceId: string; processId: string; tailLines?: number; sinceSequence?: number }
process_stop: { workspaceId: string; processId: string }
project_dev: { workspaceId: string }
project_test: { workspaceId: string }
project_lint: { workspaceId: string }
project_typecheck: { workspaceId: string }
project_build: { workspaceId: string }
codex_status: {}
codex_run: { workspaceId: string; instruction: string }
codex_task_list: { workspaceId: string }
codex_task_status: { workspaceId: string; codexTaskId: string }
codex_task_logs: { workspaceId: string; codexTaskId: string; tailLines?: number; sinceSequence?: number }
codex_stop: { workspaceId: string; codexTaskId: string }
```

Project tools take the workspace scope and use the detected project profile;
they do not accept arbitrary shell command strings. The gateway previews exact
executable/argv for approval and re-resolves immediately before spawn so a
changed command requires fresh approval.

### Local capability and extension tools

The detailed action enums and bounds are defined in `schemas.ts` and the
capability backends. Important invariants are:

- `shell` receives an executable plus an argument array, never a composed shell
  string, and retains foreground/background, timeout, dry-run, and task actions;
- `dom_cdp`, `accessibility`, `input_event`, `window`, `audio`, `office`, and
  scheduler operations retain their existing interactive/destructive policy;
- `vision`, `health`, and `system_info` remain truthful read-only diagnostics;
- `web_fetch` remains HTTP(S)-only and bounded by explicit byte/timeout fields;
- `skills_*` and `mcp_*` remain bridge tools and do not silently flatten
  child-server tools into the 223-tool configurable catalog; `mcp_list` and
  `mcp_describe` are read-only inspection while `mcp_call` is opaque mutation.

The additive Windows gateway contract is:

```ts
wsl_exec: {
  workspaceId: string;
  distro?: string;
  executable?: string;
  arguments?: string[];
  cwd?: string;                 // registered absolute Windows path
  environment?: Record<string, string>;
  operation?: 'run' | 'status' | 'wait' | 'logs' | 'result' | 'cancel';
  execution?: 'foreground' | 'background' | 'auto';
  task_id?: string;
}
wsl_fs: {
  workspaceId?: string;
  operation?: 'status' | 'translate' | 'metadata';
  direction?: 'windows_to_wsl' | 'wsl_to_windows';
  distro?: string;
  path?: string;
}
vision_annotated_capture: {
  workspaceId: string;
  capture?: 'display' | 'region' | 'window';
  max_depth?: number;
  max_marks?: number;
  ttl_seconds?: number;
}
ui_target_action: {
  workspaceId: string;
  observationId: string;
  markId: string;
  observationHash?: string;
  action?: 'click' | 'focus' | 'read_value' | 'set_value' | 'select_item' | 'menu_select';
  value?: string;
  userConfirmed?: boolean;
}
```

`wsl_exec` is argv-only and delegates task lifecycle to the existing bounded
shell runner. It records workspace ownership, rejects shell-string flags, and
does not expose arbitrary host paths. `wsl_fs` only translates paths or reads
metadata; it never opens raw `\\wsl$`/`\\wsl.localhost` files. A WSL status
failure is returned as `available: false`, not as a successful empty task.

SoM observations return `observationId`, `observationHash`, annotated PNG data,
`marks[]`, and `expiresAt`. `ui_target_action` checks owner, TTL, optional hash,
mark identity, and a fresh Accessibility lookup before forwarding an action.
Coordinates are screen-pixel metadata; action execution uses semantic element
identifiers so DPI and multi-monitor offsets do not become authorization.

`vision` keeps its existing public OCR action. WinRT OCR is routed to the
separate packaged-helper boundary and returns a truthful unavailable result when
package identity, a supported profile language, or the helper is absent. The
NSIS application remains the primary installer; sparse-package registration is
an optional release step.

The router adds `tool_dynamic_filter` and extends `tool_search`/`route_intent`
with ranked candidates, deterministic scores, reason codes, selected model,
permission metadata, and `authorizationUnchanged: true`. Local rerank is
opt-in; when no local model is configured it falls back to deterministic scoring
without sending prompt or file data off-machine.

### Context aggregation

```ts
workspace_context: {
  query: string;
  workspaceId?: string;
  path?: string;
  intent?: 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
  mode?: 'optimized' | 'full' | 'exhaustive';
  includeIgnored?: boolean;
  responseTargetBytes?: number;
  pageSize?: number;
}
workspace_context_continue: { continuationToken: string; pageSize?: number }
workspace_full_scan: { workspaceId?: string; path?: string; glob?: string; pageSize?: number; includeIgnored?: boolean }
workspace_full_scan_continue: { continuationToken: string; pageSize?: number }
workspace_snapshot: { workspaceId: string }
search_all: { query: string; workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
read_many_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
```

Context pages are transport windows, not capability limits. The engine keeps
continuation state and preserves the full primitive search/read tools.

`includeIgnored` is an explicit discovery override. Automatic mode is a quota
optimization, not authorization. `context_economy_stats` reports raw versus
delivered context bytes, skipped generated/binary paths, duplicate/previously
seen bytes avoided, ledger hits, and the bounded ledger size. The ledger is
in-memory and does not persist file contents or credentials.

### Lossless file paging

```ts
read_file_page: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  pageSize?: number;
  responseTargetBytes?: number;
}
read_file_page_continue: { continuationToken: string; pageSize?: number }
```

Paged responses always expose whether more content remains. The page adapter
does not replace or reduce the existing unrestricted trusted-workspace read
path.

### Full-visibility indexing

```ts
workspace_index: { workspaceId: string; rebuild?: boolean; includeIgnored?: boolean }
workspace_index_status: { workspaceId: string }
workspace_index_watch: { workspaceId: string; debounceMs?: number; concurrency?: number }
workspace_index_stop: { workspaceId: string }
```

Index scheduling uses the automatic context-economy policy for vendor/build,
binary, and generated paths. It must not be treated as an access denial:
explicit index/search requests and direct file reads can still inspect any path
allowed by the existing workspace boundary, including hidden, ignored,
generated, dependency, and environment files.

### Roadmap extension catalog

The Phase 05–41 additive tools are defined in
[`../../packages/mcp-server/src/upgrade-catalog.ts`](../../packages/mcp-server/src/upgrade-catalog.ts).
Each entry carries its phase, permission class, tags, streamability, and
parallel-safety metadata. `tool_search` and `tool_describe` expose this metadata
without replacing the full `tools/list` contract.

### Compound execution

```ts
tool_batch: {
  parallel?: boolean;
  calls?: Array<{
    id?: string;
    tool: string;
    arguments?: Record<string, unknown>;
    dependsOn?: string[];
    timeoutMs?: number;
  }>;
  groups?: Array<{
    id?: string;
    parallel?: boolean;
    calls: Array<{
      id?: string;
      tool: string;
      arguments?: Record<string, unknown>;
      dependsOn?: string[];
      timeoutMs?: number;
    }>;
  }>;
}
```

The input contains at most 50 child calls. Results retain input order and
include per-child status, duration, error, and returned MCP response. Read-only
children can run in parallel; side-effecting children are serialized by the
early compound safety guard. Nested `tool_batch` calls are rejected, and every
child still traverses the normal registry confirmation/host-approval boundary;
a parent batch never grants mutation privilege to a child.

## Change protocol

Any tool contract change must include:

1. a schema/source change;
2. a registry/tool-list test asserting the tool remains discoverable;
3. permission and annotation assertions;
4. success and failure tests for the application behavior;
5. an audit/Live Logs assertion for new compound children or side effects;
6. a fresh benchmark or regression comparison when latency, bytes, or result
   shape can change;
7. an update to this file and `docs/mcp/MCP_TOOL_CATALOG.md`.

Adding a compound tool is additive. Removing or narrowing a primitive tool is a
breaking change and is outside this upgrade roadmap.
