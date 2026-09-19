# Mutation Safety Matrix

This document is the release-time inventory for every MCP tool advertised by `ToolRegistry` when optional Codex tools are enabled. The executable policy remains authoritative; this matrix documents the reviewed safety family for each advertised name and is machine-checked by `packages/mcp-server/src/mutation-inventory.test.ts` so a newly advertised tool cannot silently escape this inventory.

## Safety contract

The Desktop Tool Catalog/Doctor readiness layer is observational only and is not a new mutation authority. Its probes may inspect owned/read-only dependency/status surfaces with bounded timeouts, but may not invoke a tool to test it, create project files, run project commands, control input, or open Office documents. Remediation is limited to typed allowlisted actions (`open_settings`, official URL, copy command, recheck); every later mutation still re-enters the normal policy described below.

Unless a row explicitly says otherwise, the matrix below describes **standard mode / Full Bypass OFF**. With a Full profile and the transport-specific Full Bypass toggle ON, `ToolRegistry` creates a trusted per-invocation authorization and skips lnwjud application approvals and ordinary scope enforcement: chat confirmation, host exact-action approval, profile/command policy, Active Project/allowed roots/protected paths, and always-confirm families. A live rolling scheduled-goal mutation fence is different from ordinary authorization: it still requires the current `goalLease` ownership proof so a stale worker cannot mutate after handoff. That authorization is propagated to inner services/backends and is never represented as forged `userConfirmed: true`.

Full Bypass does not disable schema/input validation, existence checks, task/process/worktree ownership, concurrency ledgers, Windows ACL/UAC, antivirus/locks, missing providers, Git/Office/WSL/runtime failures, remote/child-MCP policy, or network/authentication errors. Explicit absolute outside paths may dispatch; relative traversal remains invalid. Outside-workspace mutation may have no Recovery Trash/checkpoint pre-image.

| Field | Meaning |
| --- | --- |
| Mutation kind | `read`, `create`, `replace`, `delete`, or `opaque`; mixed tools are operation-dependent. `opaque` means the implementation cannot prove a narrower side effect before dispatch. |
| Chat confirmation | With Full Bypass OFF, profile-aware. Full Access does not prompt for ordinary work; always-confirm and destructive/data-loss actions ask unless an enabled exact-scope destructive family can be proven safe. Full Bypass ON skips this application prompt. |
| Host approval | With Full Bypass OFF, used when the active profile/action requires confirmation. Full Bypass ON skips the lnwjud host approval provider. |
| Recoverable | `yes` means lnwjud owns a pre-image/recovery path before replacement/deletion. `external/unknown` means the remote/native side effect cannot be restored by lnwjud. |
| Auto-approvable | Saved destructive-family switches may auto-approve only exact targets proven inside the host Active Project: recoverable `delete_file`, Git rm/clean/exact restore forms, shell rm/rmdir/del, and WSL rm/rmdir. Root, critical, wildcard, recursive/broad, outside-project, and unparseable forms never gain auto-approval. |
| Active Project | With Full Bypass OFF, user/workspace file and command mutations are bound to the host-owned Active Project. Full Bypass ON accepts explicit absolute outside targets; relative traversal remains invalid. |
| Command policy | With Full Bypass OFF, command-bearing tools share prohibited/risky command policy. Full Bypass ON skips this lnwjud policy; argv/schema and OS/runtime checks remain. |
| Packaged transports | Desktop HTTP and Desktop `--mcp-stdio` install the native approval provider. Standalone CLI/HTTP/STDIO traverse the same registry policy but, without a trusted provider, deny mutations requiring host approval. |

## Reviewed families

### 1. Workspace, source, search, Git-read, context, index, diagnostics, telemetry and schema reads

**Covered tools:** `workspace_list`, `workspace_info`, `workspace_tree`, `project_snapshot`, `read_file`, `read_files`, `search_files`, `search_text`, `git_status`, `git_diff`, `git_log`, `process_list`, `process_status`, `process_logs`, `codex_status`, `codex_task_list`, `codex_task_status`, `codex_task_logs`, `accessibility`, `vision`, `vision_annotated_capture`, `health`, `system_info`, `skills_list`, `skills_read`, `mcp_list`, `mcp_describe`, `workspace_context`, `workspace_context_continue`, `workspace_full_scan`, `workspace_full_scan_continue`, `workspace_snapshot`, `search_all`, `read_many_files`, `read_file_page`, `read_file_page_continue`, `workspace_index_status`, `automation_status`, `automation_events`, `symbol_search`, `find_definition`, `find_references`, `find_implementations`, `call_hierarchy`, `import_graph`, `dependency_graph`, `module_graph`, `type_search`, `trace_symbol`, `context_ranking`, `debug_context`, `review_context`, `change_context`, `symbol_context`, `test_context`, `dependency_context`, `git_context`, `frontend_context`, `backend_context`, `route_intent`, `recipe_list`, `recipe_describe`, `dry_run`, `review_changes`, `changed_symbols`, `affected_modules`, `git_history_context`, `git_blame_context`, `discover_tests`, `test_failures`, `coverage_context`, `test_history`, `cache_stats`, `hook_list`, `skill_match`, `skill_load`, `plugin_list`, `session_context`, `session_resume`, `session_history`, `response_mode`, `inspect_web_app`, `debug_ui`, `capture_ui_state`, `form_context`, `network_context`, `console_context`, `browser_debug_context`, `windows_environment`, `service_context`, `process_context`, `port_context`, `registry_context`, `event_log_context`, `installed_runtime_context`, `path_context`, `startup_context`, `mcp_discover`, `mcp_health`, `mcp_resources`, `task_status`, `task_result`, `task_list`, `delegate_status`, `delegate_result`, `permission_check`, `permission_profile`, `live_logs_query`, `live_logs_status`, `telemetry_dashboard`, `context_economy_stats`, `execution_plan`, `repo_map`, `context_expand`, `recovery_status`, `tool_schema_list`, `capabilities`, `tool_search`, `tool_dynamic_filter`, `tool_describe`, `tool_categories`, `tool_function_find`, `tool_aliases`, `mcp_hub`, `dev_context`, `recipe_catalog`, `capture_screenshot`, `compare_screenshot`, `dom_snapshot`, `layout_metadata`, `visual_context`, `inspect_workbook`, `compare_workbook_layout`, `render_excel_preview`, `inspect_pdf`, `compare_pdf_pages`, `project_profile_get`, `handoff_context`, `benchmark_run`, `regression_report`, `event_watch`, `crash_trace`, `lsp_diagnostics`, `db_inspect`, `office_outlook`, `pdf_extract_tables`, `self_heal_plan`, `ecc_status`, `ecc_catalog`, `ecc_load`, `ecc_memory_search`, `ecc_memory_read`, `ecc_memory_doctor`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read` for the reviewed read operation; mixed names are reclassified per invocation before execution | no for read | no for read | n/a | no | Reads remain constrained by registered/canonical workspace boundaries where they carry paths | no process dispatch, except metadata probes owned by the implementation | all transports |

### 2. Workspace registration and internal runtime/configuration state

**Covered tools:** `workspace_register`, `workspace_index`, `workspace_index_watch`, `workspace_index_stop`, `session_handoff`, `verify_incremental`, `recipe_run`, `run_affected_tests`, `cache_clear`, `cache_invalidate`, `hook_register`, `hook_remove`, `plugin_install`, `plugin_enable`, `plugin_disable`, `plugin_remove`, `session_checkpoint`, `ponytail_session`, `project_profile_set`, `tool_schema_register`, `task_create`, `task_cancel`, `delegate`, `delegate_cancel`, `parallel_delegate`, `debug_attach`, `debug_step`, `skills_import`, `agent_swarm_run`, `ecc_configure`, `ecc_memory_save`, `automation_create`, `automation_run`, `automation_observe`, `automation_recover`, `automation_verify`, `automation_finalize`, `automation_pause`, `automation_resume`.

**Durable Goal Continuation:** `get_goal`, `get_goal_plan`, `get_context_capsule`, `list_context_capsules`, `context_pressure`, `list_delivery_receipts`, and `list_goals` are bounded `read` operations. `run_goal` performs app-owned create/resume plus lease acquisition. `update_goal_plan`, `update_goal_acceptance`, `revise_goal_intent`, `create_context_capsule`, `record_delivery_receipt`, `advance_goal_iteration`, `checkpoint_goal`, and `finish_goal` mutate only matching app-owned durable goal/orchestration state under the applicable lease/revision/intent fences. New accepted user steering increments `userIntentRevision`; older non-terminal delivery receipts are retired so stale generated work cannot outrank newer user instructions. Context capsules are bounded immutable local state containing task/decision/result summaries, never private chain-of-thought, and are not a browser transport. Delivery receipts represent explicit lifecycle facts including ambiguous dispatch states; they do not turn an uncertain send into success and must not trigger blind replay. Bounded iteration cannot exceed its configured iteration count and does not send ChatGPT browser messages. `reconcile_goals` previews by default and, only with `apply=true`, performs an idempotent app-owned reconciliation of explicitly selected abandoned/superseded goals after runtime-liveness checks; it does not grant workspace mutation authority or silently terminate live work. `cancel_goal` is a destructive app-owned mutation that records cancellation under revision CAS and attempts to stop only goal-relative `trackedTasks` whose `cancelWithGoal` policy is true; shared `supporting_service` or non-owned entries remain running by default and are returned as `taskCancellations` with `status=skipped`. An explicitly bound unavailable provider or unverifiable termination is returned as `failed`, so `allTasksStopped` remains false until the unresolved task is inspected. It does not by itself delete a scheduled successor. Their authoritative SQLite rows/checkpoint history are internal state, not authority to mutate source files; lease tokens are hashed at rest and never logged. ChatGPT continuation remains host-native: no browser/DOM automation is an approved continuation path.

**Covered goal tools:** `run_goal`, `get_goal`, `get_goal_plan`, `update_goal_plan`, `update_goal_acceptance`, `revise_goal_intent`, `create_context_capsule`, `get_context_capsule`, `list_context_capsules`, `context_pressure`, `record_delivery_receipt`, `list_delivery_receipts`, `advance_goal_iteration`, `checkpoint_goal`, `finish_goal`, `cancel_goal`, `reconcile_goals`, `list_goals`, `prepare_scheduled_continuation`, `record_scheduled_continuation_receipt`, `cancel_scheduled_continuation`, `claim_scheduled_continuation`, `get_scheduled_continuation`, `expedite_scheduled_continuation`.

**Native Automation Engine:** `automation_status` and `automation_events` are bounded reads over the authoritative SQLite run/journal state. `automation_create` creates or replays one run bound 1:1 to an existing durable goal. `automation_run`, `automation_observe`, `automation_recover`, `automation_verify`, `automation_finalize`, `automation_pause`, and `automation_resume` mutate only app-owned orchestration state under run-revision plus durable-goal authority cursors. Successful task dispatch is checkpointed into GoalRecord tracked tasks; successful milestone verification checkpoints durable goal progress before the automation milestone is completed. `automation_finalize` requires explicit final-review evidence, completed durable acceptance, no blockers, no unresolved dispatches, and no live/unknown blocking job; it invokes the existing goal completion path and marks the automation completed only after a terminal GoalRecord readback confirms success. Workspace/process/Codex effects are never executed directly by the wrapper: an allowed execution descriptor is dispatched back through the normal `ToolRegistry`, so Active Project, command policy, approval, ownership, and live goal-lease fencing are re-applied at the child boundary. The default `coding_guarded` policy is intentionally stricter than Full Bypass: browser/desktop/input automation and destructive repository/workspace cleanup remain hard-denied, while push/merge/tag/publish/release/deploy and opaque Codex execution require explicit user authorization. Ambiguous dispatch outcomes become durable unresolved receipts and are reconciled before any retry; missing provider idempotency lookup remains fail-closed rather than blindly replaying a side effect.

**Scheduled-continuation ownership:** `get_scheduled_continuation` is bounded `read`; prepare/receipt/claim/expedite mutate only app-owned durable continuation/lease state. `cancel_scheduled_continuation` is an independent destructive mutation: it marks the exact/latest continuation for host deletion and returns a receipt-required instruction, without cancelling the goal or its running tasks. `expedite_scheduled_continuation` only advances the durable due time/version and returns an update request for the exact existing native task; it never creates a replacement task or reaches file/Git/process backends. For a goal with a native AutomationRun, `claim_scheduled_continuation` may additionally project `automationResume` only after the existing recurring-claim lease/liveness contract has run. `recurring_acquired` may observe the exact persisted blocking task, reconcile an unresolved dispatch, recover a checkpoint-before-milestone crash, or advance deterministic state only to a dispatch boundary; it does not infer or relaunch an external payload. Busy/duplicate/legacy-handoff outcomes perform no automation mutation. A live rolling scheduled-goal `goalLease` token/generation fence is checked before workspace-changing dispatch in both standard mode and Full Bypass. This is an ownership/concurrency fence rather than an approval prompt, so Full Bypass does not disable it.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `create`/`replace`/`opaque` depending on the registered operation; unknown operations remain fail-closed | profile/action dependent; Full ordinary mutations do not prompt | only when the action requires approval | app-owned runtime state uses atomic writes/recovery snapshots where persisted; optional/contract-only providers are `external/unknown` | only explicitly modelled destructive families; generic internal mutation is no | Workspace-bearing mutations must match the host Active Project; internal state is app-owned | any command-bearing child action is still checked at its actual execution boundary | Full ordinary actions can run without duplicate approval; approval-required actions use the trusted provider or fail closed |

### 3. User/workspace file create, replacement, move/copy and deletion

**Covered tools:** `write_file`, `apply_patch`, `edit_file`, `move_file`, `copy_file`, `delete_file`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `create` when the target is proven absent; otherwise `replace`; `delete_file` is `delete` | Full ordinary create/edit/replace/move does not prompt; destructive deletion asks unless exact `delete_file` auto-approval is enabled | only when the active profile/action requires approval | yes for supported replacement/delete: checkpoint/Recovery Trash pre-image is created before authoritative mutation | exact recoverable `delete_file` only within this file-tool family; command families are documented separately | mandatory canonical Active Project match; symlink/junction escapes fail closed | n/a unless the operation delegates to another command-bearing tool | Full ordinary file mutation needs no duplicate native prompt; approval-required deletion uses the trusted provider |

### 4. Recovery and checkpoint operations

**Covered tools:** `list_recovery_items`, `restore_deleted_file`, `list_checkpoints`, `restore_checkpoint`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| list operations are `read`; restore is `replace`/`create` | Full performs ordinary recoverable restore without an extra prompt; stricter profiles may ask | only when the active profile/action requires approval | yes; recovery item/checkpoint is the source and replacement safety preserves the current pre-image where applicable | no | restore target must resolve inside the matching workspace/Active Project | n/a | same profile-aware registry behavior on every transport |

### 5. Git mutation and worktree ownership

**Covered tools:** `git`, `git_worktree_spawn`, `git_worktree_remove`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read Git subcommands are `read`; ordinary repository changes are replace/opaque; data-loss forms are `delete` or destructive replace | Full ordinary Git mutations do not prompt; destructive forms ask unless an enabled exact-scope Git family applies | only when the action remains approval-required | arbitrary Git mutation is not promised Recovery Trash coverage | exact scoped `git_rm`, `git_clean`, and supported exact restore forms may be auto-approved; broad reset/restore and remote/history deletion are not | workspaceId must match Active Project for mutation; worktrees are restricted to owned `.worktrees`/`.lnwjud/worktrees` entries | scope overrides/aliases and dangerous remote/history rewrites remain denied; project data-loss forms are confirmation-gated | Full ordinary Git needs no duplicate native prompt; interactive destructive forms use the trusted provider |

### 6. Process, project command, Codex, shell, WSL and sandbox execution

**Covered tools:** `process_start`, `process_stop`, `project_dev`, `project_test`, `project_lint`, `project_typecheck`, `project_build`, `codex_run`, `codex_stop`, `shell`, `wsl_exec`, `sandbox_exec`, `ecc_security_scan`.

`ecc_security_scan` is a bounded execute-only wrapper around the pinned bundled AgentShield scanner. It scans selected ECC resources or one registered workspace, emits bounded JSON, and does not enable scanner auto-fix, network expansion, or imported hook/workflow execution.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| status/list modes are `read`; explicit ordinary argv start/run is `execute`; detected data-loss or unclassifiable command forms are destructive/opaque | Full ordinary execution does not prompt; detected dangerous forms ask unless an exact shell/WSL family is enabled | only when the action remains approval-required | external/unknown; process cancellation uses verified settlement and `termination_unverified` rather than claiming success | exact scoped shell/WSL rm/rmdir/del families only; generic process/Codex execution is not auto-approved as destructive | Active Project is the default cwd/ownership scope; explicitly requested external cwd is separately policy-gated | machine-level commands/scope bypasses are denied; destructive filesystem/Git/sync forms are confirmation-gated and ordinary argv runs are allowed | Full ordinary execution needs no duplicate native prompt; interactive dangerous forms use the trusted provider |

`tasks/result`-style waiting never restarts the payload. Durable shell metadata retries are read/settlement retries only. Codex `autoRetry` is limited to terminating the same already-created process when a cancellation races launch; it never retries Codex start.

### 7. Mixed native desktop/UI/media capabilities

**Covered tools:** `dom_cdp`, `computer_use`, `input_event`, `ui_target_action`, `window`, `notification`, `file_dialog`, `clipboard`, `audio`, `screen_record`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| inspection/status/query modes are `read`; input/action/record/write modes are bounded/replace/opaque by action | Full ordinary UI/media mutations do not prompt; destructive/data-loss actions remain interactive | only when the action requires approval | external/unknown unless a sub-operation routes through FileService | no generic UI auto-approval | path-bearing targets use Active Project policy; non-path UI actions stay action-classified | command policy applies if a backend delegates to command execution | Full ordinary actions do not need duplicate native approval; approval-required actions use the Desktop provider |

### 8. HTTP/network and child MCP bridge

**Covered tools:** `web_fetch`, `mcp_call`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HTTP GET/HEAD and child-MCP discovery are `read`; HTTP POST is `opaque`, PUT is `replace`, DELETE is `delete`; `mcp_call` is action-classified/opaque when child effects cannot be proven | Full ordinary remote mutation does not prompt; DELETE or other detected data-loss remains interactive | only when the action requires approval | external/unknown | no remote destructive auto-approval | workspace metadata cannot widen host scope; child calls cannot inherit/escalate parent approval | child execution remains subject to the child/tool policy; no parent privilege escalation | profile-aware central registry; approval-required remote actions fail closed without a trusted approval path |

After a dispatched HTTP mutation fails/times out, the error explicitly states that the remote outcome may be unknown, instructs state inspection, and says **do not retry automatically**. The backend issues one `fetch` dispatch only.

### 9. Scheduler mutation

**Covered tools:** `scheduler`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| list is `read`; create is `create`; run/delete are `opaque`/`delete` | required for create/run/delete | required for mutation | external/unknown Windows Task Scheduler state | no | not a workspace path mutation, but exact host action is mandatory | scheduled command creation remains opaque and cannot use host approval to bypass prohibited execution policy elsewhere | Desktop can approve; providerless mutation denies |

A scheduler mutation dispatches `schtasks.exe` once. If dispatch returns an error or cancellation after launch, the result says the outcome may be unknown, requires inspecting current task state, and says **do not retry automatically**.

### 10. Office/document replacement and merge

**Covered tools:** `office`, `office_ppt`, `docx_merge`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read modes are `read`; save/save-as/merge to target is `create` or `replace` | replacement/mutating mode requires chat confirmation | mutation requires exact host approval | yes for workspace-owned replacement: FileService prepares a replacement pre-image before native/Office dispatch | no | source/target paths are canonicalized under the matching Active Project | n/a for COM/native calls; any command-backed helper is still independently guarded | Desktop provider can approve; standalone providerless mutation denies |

### 11. WSL filesystem translation

**Covered tools:** `wsl_fs`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read`/translation/metadata only | no | no | n/a | no | Windows paths are checked with segment-aware `path.win32.relative`; raw access outside registered roots is refused | no command execution | all transports |

### 12. Database inspection/query

**Covered tools:** `db_query`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read` only in the current runtime | no | no | n/a | no | target DB remains workspace-scoped | n/a | all transports |

The database runtime rejects DML/DDL such as `DELETE`, `UPDATE`, `DROP`, and multi-statement mutation rather than relying on approval.

### 13. LSP rename planning

**Covered tools:** `lsp_rename`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read` plan generation; returned workspace edit is not applied | no for plan | no for plan | n/a until a later FileService/apply_patch mutation | no | requested files are canonicalized under Active Project/registered workspace | language-server process is configured argv, while any later mutation goes through normal policy | all transports |

### 14. Optional/contract-level tools whose current implementation does not directly apply a user file mutation

**Covered tools:** `compare_workbook_layout`, `render_excel_preview`, `compare_pdf_pages` are read/render helpers already covered above; the remaining execution/planning surfaces `agent_swarm_run` and `debug_step` remain centrally fail-closed if/when their optional provider becomes mutating. They are explicitly listed in their primary family so there is no untracked optional tool.

### 15. Recovery execution and batch orchestration

**Covered tools:** `self_heal_apply`, `tool_batch`.

| Mutation kind | Chat confirmation | Host approval | Recoverable | Auto-approvable | Active Project | Command policy | Packaged transports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `self_heal_apply` is `opaque` at the wrapper and only executes allowlisted reviewed fixes from a fresh matching plan; `tool_batch` is `read` only when every child is read and becomes `opaque` when any child can mutate | required for mutating apply/batch child | required for every mutation; parent confirmation/approval cannot be used to escalate a child | self-heal preserves the recovery semantics of each allowlisted fix; batch recovery is the child tool's contract | no | each selected fix/child remains independently bound to the host Active Project where applicable | each command-bearing child is independently prohibited/approved; the batch wrapper cannot bypass command policy | same central registry on all transports; providerless mutation denies |

`self_heal_apply` regenerates evidence and requires the caller's `planId` to match before applying each selected fix once. It reports `automaticDestructiveRetry: false`. `tool_batch` dispatches every child back through `ToolRegistry.invoke`: in standard mode each child keeps its own scope/confirmation/host/command checks; while the transport is in Full Bypass, each child independently recomputes the same trusted bypass mode.

## Primitive inventory audit

| Class | Reviewed production examples | Safety disposition |
| --- | --- | --- |
| A — user/workspace-owned | FileService write/edit/move/copy/delete; native Office save-as/merge targets; workspace sandbox staging | Replacement/deletion gets a pre-image/checkpoint/Recovery Trash entry before authoritative mutation. Canonical real-path containment is mandatory. |
| B — internal/app-owned | backup manifests/locks, runtime state store, activity leases, tunnel lock, workspace index, durable-task metadata, updater state/temp files | App-owned paths only; atomic write/quarantine/owner-token or retention/recovery scheme used where authoritative state is replaced. These paths do not authorize arbitrary workspace mutation. |
| C — opaque external | process execution, Codex, shell/WSL, browser/UI input, remote HTTP mutation, child MCP mutation, Task Scheduler | Explicit chat + independent trusted host approval; no auto approval; no automatic mutation retry after uncertain completion. |
| D — test/build-only | fixture cleanup, test temporary directories, generated installer/doc/version staging | Not an advertised runtime mutation entrypoint. Build scripts remain subject to release-gate review and do not widen runtime authorization. |

## Retry and timeout audit

| Surface | Reviewed behavior |
| --- | --- |
| MCP Tasks protocol | `tasks/result` polls status only. It never restarts the task. When the bounded wait expires it instructs the client to preserve the task ID and poll later. |
| Durable shell | Worker launch occurs once. Metadata read retries retry reads only. Cancellation retries termination/settlement against the same PIDs and emits `termination_unverified` when termination cannot be proven. |
| Process manager / Codex stop | `autoRetry` retries termination of the same known child only and deduplicates concurrent termination through a stored termination attempt. It never reruns the command/Codex instruction. |
| Scheduler | One `schtasks` mutation dispatch. Error after dispatch reports unknown outcome, state inspection requirement, and no automatic retry. |
| HTTP mutation | One `fetch` mutation dispatch. Timeout/failure after dispatch reports unknown outcome, remote-state inspection requirement, and no automatic retry. |
| Self-heal | A fresh evidence plan and matching `planId` are required. Selected fixes are each applied once; `automaticDestructiveRetry` is false. |
| Updater | Duplicate install requests are suppressed while pending. Installation waits for trustworthy zero activity plus a quiet period and invokes install once. Update *checks* can recur because they are read/network checks, not installation mutation. |

## Verification hooks

- `packages/mcp-server/src/mutation-inventory.test.ts` asserts that every advertised `ToolRegistry` name appears in this document.
- `tests/release/path-boundary-source-policy.test.ts` rejects reviewed authorization sources that use string-prefix path authorization.
- Mutation/host-approval integration tests verify that standalone providerless runtimes fail closed before dispatch while Desktop provider paths can approve exact actions.
- The exhaustive source inventory is rerun during Task 9 for delete primitives, replacement primitives, database mutation markers, remote HTTP mutation methods, destructive Git flags, and mirror/delete synchronization flags.
