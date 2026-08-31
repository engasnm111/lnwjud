# lnwjud Tool Contract

Status: God-Tier Wave 0–8 additive contract snapshot for `v4.0.0`.

This is the compatibility contract for the current MCP surface. The runtime
advertises the JSON Schema for every input through `tools/list`; the TypeScript
Zod schemas in `packages/mcp-server/src/tools/` are the implementation source
of truth. The existing human-oriented catalog remains useful for field details,
while this document records the primitive/core contract, preserves the earlier
compatibility baseline, and records policy class, annotations, and schema source.
The complete v4 inventory contains 231 tool definitions. The default runtime currently advertises 195 through `tools/list`, or 201 when the six `codex_*` delegation tools are enabled; unavailable/planned definitions remain inventory-only rather than returning fake success. The additive v4 entries are defined
in `packages/mcp-server/src/upgrade-catalog.ts` and the exact runtime order is
verified by `packages/mcp-server/src/tool-registry.test.ts`.

Desktop readiness is a separate presentation contract built from the same live definitions. Main-process requirement probes are read-only, timeout-bounded, cached, and shared by the Tools catalog and structured Doctor report. Readiness never grants permission or bypasses workspace/command policy. External MCP descriptors remain a separate origin and use `UNKNOWN` for child-server permission/readiness semantics lnwjud cannot verify.

**Active Workspace Set boundary:** Primary/Selected Project is only the default. Every tool may target any registered workspace currently in the host Active Projects set. When an input contains an absolute path/cwd/database target/native path that belongs to another active root, the registry routes the effective `workspaceId` to the most-specific matching active workspace before policy and handler dispatch. Targets outside the active set remain guarded; one call is not allowed to silently span multiple active roots.

**Managed-browser target boundary:** page-targeted `dom_cdp` work is fail-closed and ID-pinned. The caller must first `list_tabs`, select the intended exact returned ID after inspecting URL/title, or create a safe target with `new_tab`; every target-scoped action and `steps` batch then carries that same top-level `tab_id`. A missing/closed ID is an error, never permission to select the first or OS-active tab. Native address-bar typing is not a browser-navigation fallback. Mutating a ChatGPT tab additionally requires both `allow_protected_tab_action: true` and real `userConfirmed: true`; Full Bypass does not satisfy that explicit-user condition.

<!-- BEGIN GENERATED TOOL REGISTRY -->
## Generated live ToolRegistry index

This complete inventory is generated from `ToolRegistry.listAll()`: **231 total tool definitions**. The runtime advertises **195 tools by default** and **201 tools when Codex delegation is enabled** through `tools/list`.
Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.

| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Read-only | Destructive |
| ---: | --- | --- | --- | --- | --- | :---: | :---: |
| 1 | `workspace_list` | READ | default | operational | service_dispatch | yes | no |
| 2 | `workspace_register` | WRITE | default | operational | service_dispatch | no | no |
| 3 | `workspace_info` | READ | default | operational | service_dispatch | yes | no |
| 4 | `workspace_tree` | READ | default | operational | service_dispatch | yes | no |
| 5 | `project_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 6 | `read_file` | READ | default | operational | service_dispatch | yes | no |
| 7 | `read_files` | READ | default | operational | service_dispatch | yes | no |
| 8 | `search_files` | READ | default | operational | service_dispatch | yes | no |
| 9 | `search_text` | READ | default | operational | service_dispatch | yes | no |
| 10 | `git_status` | READ | default | operational | service_dispatch | yes | no |
| 11 | `git_diff` | READ | default | operational | service_dispatch | yes | no |
| 12 | `git_log` | READ | default | operational | service_dispatch | yes | no |
| 13 | `git` | EXECUTE | default | operational | service_dispatch | no | yes |
| 14 | `write_file` | WRITE | default | operational | service_dispatch | no | no |
| 15 | `apply_patch` | WRITE | default | operational | service_dispatch | no | no |
| 16 | `edit_file` | WRITE | default | operational | service_dispatch | no | no |
| 17 | `move_file` | WRITE | default | operational | service_dispatch | no | no |
| 18 | `copy_file` | WRITE | default | operational | service_dispatch | no | no |
| 19 | `delete_file` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 20 | `list_recovery_items` | READ | default | operational | service_dispatch | yes | no |
| 21 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | no | no |
| 22 | `list_checkpoints` | READ | default | operational | service_dispatch | yes | no |
| 23 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | no | yes |
| 24 | `process_start` | EXECUTE | default | operational | service_dispatch | no | no |
| 25 | `process_list` | READ | default | operational | service_dispatch | yes | no |
| 26 | `process_status` | READ | default | operational | service_dispatch | yes | no |
| 27 | `process_logs` | READ | default | operational | service_dispatch | yes | no |
| 28 | `process_stop` | EXECUTE | default | operational | service_dispatch | no | no |
| 29 | `project_dev` | EXECUTE | default | operational | service_dispatch | no | no |
| 30 | `project_test` | EXECUTE | default | operational | service_dispatch | no | no |
| 31 | `project_lint` | EXECUTE | default | operational | service_dispatch | no | no |
| 32 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | no | no |
| 33 | `project_build` | EXECUTE | default | operational | service_dispatch | no | no |
| 34 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 35 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 36 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 37 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 38 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 39 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 40 | `shell` | EXECUTE | default | operational | service_dispatch | no | yes |
| 41 | `dom_cdp` | READ | default | operational | service_dispatch | no | yes |
| 42 | `computer_use` | EXECUTE | default | operational | service_dispatch | no | yes |
| 43 | `accessibility` | READ | default | operational | service_dispatch | no | yes |
| 44 | `input_event` | EXECUTE | default | operational | service_dispatch | no | yes |
| 45 | `vision` | READ | default | operational | service_dispatch | yes | no |
| 46 | `vision_annotated_capture` | READ | default | operational | service_dispatch | yes | no |
| 47 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | no | yes |
| 48 | `window` | EXECUTE | default | operational | service_dispatch | no | yes |
| 49 | `health` | READ | default | operational | service_dispatch | yes | no |
| 50 | `system_info` | READ | default | operational | service_dispatch | yes | no |
| 51 | `notification` | EXECUTE | default | operational | service_dispatch | no | no |
| 52 | `file_dialog` | EXECUTE | default | operational | service_dispatch | yes | no |
| 53 | `clipboard` | EXECUTE | default | operational | service_dispatch | no | no |
| 54 | `web_fetch` | READ | default | operational | service_dispatch | no | yes |
| 55 | `audio` | EXECUTE | default | operational | service_dispatch | no | yes |
| 56 | `screen_record` | EXECUTE | default | operational | service_dispatch | no | yes |
| 57 | `office` | WRITE | default | operational | service_dispatch | no | no |
| 58 | `scheduler` | EXECUTE | default | operational | service_dispatch | no | yes |
| 59 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | no | yes |
| 60 | `wsl_fs` | READ | default | operational | service_dispatch | yes | no |
| 61 | `skills_list` | READ | default | operational | service_dispatch | yes | no |
| 62 | `skills_read` | READ | default | operational | service_dispatch | yes | no |
| 63 | `mcp_list` | READ | default | operational | service_dispatch | yes | no |
| 64 | `mcp_describe` | READ | default | operational | service_dispatch | yes | no |
| 65 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 66 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 67 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 68 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 69 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 70 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 71 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 72 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 73 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 74 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 75 | `workspace_index` | READ | default | operational | service_dispatch | yes | no |
| 76 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 77 | `workspace_index_watch` | READ | default | operational | service_dispatch | yes | no |
| 78 | `workspace_index_stop` | READ | default | operational | service_dispatch | yes | no |
| 79 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 80 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 81 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 82 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 83 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 84 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 85 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 86 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 87 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 88 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 89 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 90 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 91 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 92 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 93 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 94 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 95 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 96 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 97 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 98 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 99 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 100 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 101 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 102 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 103 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 104 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 105 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 106 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 107 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 108 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 109 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 110 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 111 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 112 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 113 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 114 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 115 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 116 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 117 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 118 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 119 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 120 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 121 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 122 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 123 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 124 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 125 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 126 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 127 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 128 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 129 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 130 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 131 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 132 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 133 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 134 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 135 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 136 | `plugin_install` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 137 | `plugin_list` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 138 | `plugin_enable` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 139 | `plugin_disable` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 140 | `plugin_remove` | DANGEROUS | no | feature_disabled | truthful_unavailable | no | yes |
| 141 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 142 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 143 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 144 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 145 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 146 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 147 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 148 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 149 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 150 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 151 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 152 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 153 | `windows_environment` | READ | default | operational | service_dispatch | yes | no |
| 154 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 155 | `process_context` | READ | default | operational | service_dispatch | yes | no |
| 156 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 157 | `registry_context` | READ | default | operational | deterministic_operation | yes | no |
| 158 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 159 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 160 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 161 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 162 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 163 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 164 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 165 | `task_create` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 166 | `task_status` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 167 | `task_cancel` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 168 | `task_result` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 169 | `task_list` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 170 | `delegate` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 171 | `delegate_status` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 172 | `delegate_cancel` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 173 | `delegate_result` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 174 | `parallel_delegate` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 175 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 176 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 177 | `live_logs_query` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 178 | `live_logs_status` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 179 | `telemetry_dashboard` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 180 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 181 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 182 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 183 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 184 | `recovery_status` | READ | default | operational | deterministic_operation | yes | no |
| 185 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 186 | `tool_schema_register` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 187 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 188 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 189 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 190 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 191 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 192 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 193 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 194 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 195 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 196 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 197 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 198 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 199 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 200 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 201 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 202 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 203 | `compare_workbook_layout` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 204 | `render_excel_preview` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 205 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 206 | `compare_pdf_pages` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 207 | `project_profile_get` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 208 | `project_profile_set` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 209 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 210 | `benchmark_run` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 211 | `regression_report` | READ | no | feature_disabled | truthful_unavailable | yes | no |
| 212 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 213 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 214 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 215 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 216 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 217 | `debug_attach` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 218 | `debug_step` | EXECUTE | no | feature_disabled | truthful_unavailable | no | no |
| 219 | `git_worktree_spawn` | WRITE | default | dependency_gated | deterministic_operation | no | no |
| 220 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | deterministic_operation | no | yes |
| 221 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 222 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 223 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 224 | `office_outlook` | READ | default | dependency_gated | service_dispatch | yes | no |
| 225 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 226 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 227 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 228 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 229 | `skills_import` | WRITE | no | feature_disabled | truthful_unavailable | no | no |
| 230 | `agent_swarm_run` | EXECUTE | no | planned | truthful_unavailable | no | no |
| 231 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names and registry order are deterministic.
- Every request is schema-validated before the application service runs.
- Every result is structured JSON-compatible MCP content; errors use the
  repository error/result mapping and do not expose secrets or raw stack traces.
- `readOnlyHint` is advisory metadata for clients. It never grants permission.
- `destructiveHint` is advisory metadata for clients. In standard mode permission
  policy and application hard blocks remain authoritative; trusted Full Bypass
  intentionally skips those lnwjud checks.
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
| `DANGEROUS` | Destructive, interactive, external, or full-access meta capability | denied in Safe; prompts in Balanced; allowed in Full subject to standard-mode policy, or dispatched without lnwjud approval when Full Bypass is ON |

Desktop uses its configured local permission profile. Packaged stdio keeps `full` as the backward-compatible default but accepts `safe|balanced|full|custom` through the launcher, environment, or Desktop STDIO policy settings. Desktop HTTP/Secure Tunnel and direct STDIO have independent Full Bypass toggles under the Full Access (Unrestricted) group; both default OFF and are effective only with profile `full`.

No mode scans or registers drive letters automatically. With Full Bypass OFF, optional strict-root mode constrains access to explicit canonical roots and the normal ownership/path/Active Project/host approval/command-policy boundaries remain enforced. With Full Bypass ON, the gateway and inner runtimes skip every lnwjud application approval and scope check, including always-confirm tools, protected paths, explicit absolute outside paths, and `goalLease`. The authorization is carried separately from tool input and must never be forged as caller `userConfirmed: true`. Schema validation, relative-traversal rejection, exact task/process/worktree ownership, Windows ACL/UAC, provider availability, remote/child policy, and runtime errors remain.

Mutations still receive typed policy classification for audit/dispatch behavior. With Full Bypass OFF, the only configurable scoped auto-approval exception is exact recoverable `delete_file`; every other approval-required mutation needs independent trusted host exact-action approval and providerless runtimes fail closed. Full Bypass ON supersedes those lnwjud authorization checks for its transport. Arbitrary commands and project-owned scripts remain opaque execution, not an OS sandbox, and outside-project changes are not automatically recoverable through Recovery Trash.

## Core primitive runtime catalog

The generated live `ToolRegistry.listAll()` index above is the authoritative complete catalog for all **231 tool definitions**. It is generated from the built registry and checked in CI. This section intentionally does not maintain a second hand-numbered primitive table, because duplicate permission/schema tables can drift from the registry. The Zod schemas in `packages/mcp-server/src/tools/` and the generated table above remain the source of truth for names, permissions, annotations, ordering, and input JSON Schema; `tools/list` exposes only the currently advertised subset.

## Schema groups and contract examples

The following examples make the required shape explicit without duplicating the
generated JSON Schema. Optional fields and bounds must remain aligned with the
source schema and the runtime `tools/list` response.

### Workspace and filesystem

```ts
workspace_list: {}
workspace_register: {
  parentWorkspaceId?: string; // legacy explicit machine-root-relative registration
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
  child-server tools into the 231-definition complete inventory; `mcp_list` and
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
