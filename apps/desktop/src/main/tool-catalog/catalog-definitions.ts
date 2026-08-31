import type { ToolCatalogDefinition, ToolCategory, ToolRiskMode } from '@lnwjud/ipc-contracts';
import { ToolRegistry, upgradeCatalogEntry, type McpToolDefinition } from '@lnwjud/mcp-server';

export const KNOWN_TOOL_REQUIREMENT_IDS = Object.freeze([
  'platform_windows',
  'registered_workspace',
  'active_project',
  'executable_git',
  'executable_ripgrep',
  'codex_runtime',
  'wsl_runtime',
  'local_mcp_listener',
  'browser_cdp',
  'windows_ui_automation',
  'windows_input',
  'windows_window',
  'windows_ocr',
  'office_desktop',
  'network_access',
  'scheduler_runtime',
  'tunnel_runtime',
  'external_mcp_connection',
  'local_pdf_provider',
  'configured_lsp',
  'database_target',
  'windows_sandbox',
  'browser_event_stream',
  'feature_delivery',
] as const);

const INPUT_DEPENDENT_TOOLS = new Set([
  'git', 'shell', 'wsl_exec', 'scheduler', 'accessibility', 'input_event', 'window', 'office',
  'file_dialog', 'clipboard', 'workspace_index_watch', 'workspace_index_stop', 'recipe_run', 'dry_run',
  'cache_clear', 'cache_invalidate', 'hook_register', 'hook_remove', 'plugin_install', 'plugin_enable',
  'plugin_disable', 'plugin_remove', 'project_profile_set', 'git_worktree_spawn', 'git_worktree_remove',
  'lsp_rename', 'debug_attach', 'debug_step', 'docx_merge', 'self_heal_apply', 'skills_import', 'agent_swarm_run',
]);

const CANCEL_TOOLS = new Set([
  'process_start', 'process_stop', 'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
  'codex_run', 'codex_stop', 'task_create', 'task_cancel', 'delegate', 'delegate_cancel', 'parallel_delegate',
  'workspace_index_watch', 'workspace_index_stop', 'debug_attach', 'debug_step', 'agent_swarm_run',
]);

const DRY_RUN_TOOLS = new Set([
  'git', 'shell', 'wsl_exec', 'scheduler', 'accessibility', 'input_event', 'window', 'office', 'file_dialog',
  'clipboard', 'dry_run', 'git_worktree_spawn', 'git_worktree_remove', 'project_profile_set', 'docx_merge',
  'self_heal_apply', 'skills_import',
]);

const actor = { clientId: 'desktop-tool-catalog', clientName: 'lnwjud Desktop Tool Catalog' };
const definitions = new ToolRegistry({}, actor, { codexToolsEnabled: true }).listAll();

export const catalogSourceDescriptions: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [definition.name, definition.description]),
));

export const catalogDefinitions: Readonly<Record<string, ToolCatalogDefinition>> = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [definition.name, buildCatalogDefinition(definition)]),
));

function buildCatalogDefinition(definition: McpToolDefinition): ToolCatalogDefinition {
  const category = categoryFor(definition.name);
  const requirementIds = requirementsFor(definition.name, category);
  return Object.freeze({
    name: definition.name,
    category,
    titleKey: `tool.${definition.name}.title`,
    shortDescriptionKey: `tool.${definition.name}.short`,
    longDescriptionKey: `tool.${definition.name}.long`,
    requirementIds,
    riskMode: riskModeFor(definition.name),
    supportsCancel: CANCEL_TOOLS.has(definition.name),
    supportsDryRun: DRY_RUN_TOOLS.has(definition.name),
    documentationTarget: `docs/LNWJUD_CAPABILITIES.md#${definition.name.replaceAll('_', '-')}`,
  } satisfies ToolCatalogDefinition);
}

function categoryFor(name: string): ToolCategory {
  if (/^(workspace_|project_snapshot$)/.test(name)) return 'workspace';
  if (/^(read_|write_file$|apply_patch$|edit_file$|move_file$|copy_file$|delete_file$|list_recovery_items$|restore_deleted_file$|list_checkpoints$|restore_checkpoint$)/.test(name)) return 'files';
  if (/^(search_|symbol_|find_|call_hierarchy$|import_graph$|dependency_graph$|module_graph$|type_search$|trace_symbol$|context_|debug_context$|review_context$|change_context$|test_context$|git_context$|frontend_context$|backend_context$|dependency_context$|repo_map$|changed_symbols$|affected_modules$|git_history_context$|git_blame_context$|discover_tests$|test_failures$|coverage_context$|test_history$|tool_function_find$|dev_context$|handoff_context$)/.test(name)) return 'search_context';
  if (/^git(?:_|$)/.test(name)) return 'git';
  if (/^(process_|project_dev$|project_test$|project_lint$|project_typecheck$|project_build$|shell$|wsl_exec$)/.test(name)) return 'process';
  if (/^(dom_cdp$|computer_use$|accessibility$|input_event$|vision(?:_|$)|ui_target_action$|window$|inspect_web_app$|debug_ui$|capture_ui_state$|form_context$|network_context$|console_context$|browser_debug_context$|capture_screenshot$|compare_screenshot$|dom_snapshot$|layout_metadata$|visual_context$)/.test(name)) return 'browser_desktop';
  if (/^(audio$|screen_record$|office(?:_|$)|inspect_workbook$|compare_workbook_layout$|render_excel_preview$|inspect_pdf$|compare_pdf_pages$|pdf_extract_tables$|docx_merge$)/.test(name)) return 'office_media';
  if (/^(tool_batch$|route_intent$|recipe_|dry_run$|review_changes$|run_affected_tests$|cache_|hook_|response_mode$|execution_plan$|benchmark_run$|regression_report$|sandbox_exec$|event_watch$|crash_trace$|lsp_|db_|self_heal_)/.test(name)) return 'automation';
  if (/^(codex_|run_goal$|get_goal$|checkpoint_goal$|finish_goal$|cancel_goal$|list_goals$|prepare_scheduled_continuation$|record_scheduled_continuation_receipt$|claim_scheduled_continuation$|get_scheduled_continuation$|expedite_scheduled_continuation$|cancel_scheduled_continuation$|task_|delegate(?:_|$)|parallel_delegate$|agent_swarm_run$|session_)/.test(name)) return 'agent_goals';
  if (/^(skills_|skill_|mcp_|plugin_|capabilities$|tool_schema_|tool_search$|tool_dynamic_filter$|tool_describe$|tool_categories$|tool_aliases$|mcp_hub$)/.test(name)) return 'extensions';
  return 'system';
}

function requirementsFor(name: string, category: ToolCategory): readonly string[] {
  const ids = new Set<string>();
  if (['workspace', 'files', 'search_context', 'git', 'process'].includes(category)) ids.add('registered_workspace');
  if (['files', 'git', 'process'].includes(category) && !/^(read_|search_|git_status$|git_diff$|git_log$|process_list$|process_status$|process_logs$)/.test(name)) ids.add('active_project');
  if (/^git(?:_|$)/.test(name)) ids.add('executable_git');
  if (/^(search_files|search_text|search_all)$/.test(name)) ids.add('executable_ripgrep');
  if (/^codex_/.test(name)) ids.add('codex_runtime');
  if (/^wsl_/.test(name)) ids.add('wsl_runtime');
  if (/^(mcp_|mcp_hub$)/.test(name)) ids.add('external_mcp_connection');
  if (/^(dom_cdp$|inspect_web_app$|debug_ui$|capture_ui_state$|form_context$|network_context$|console_context$|browser_debug_context$|capture_screenshot$|dom_snapshot$|layout_metadata$|visual_context$)/.test(name)) ids.add('browser_cdp');
  if (/^(accessibility$|computer_use$|ui_target_action$)/.test(name)) { ids.add('platform_windows'); ids.add('windows_ui_automation'); }
  if (/^input_event$/.test(name)) { ids.add('platform_windows'); ids.add('windows_input'); }
  if (/^window$/.test(name)) { ids.add('platform_windows'); ids.add('windows_window'); }
  if (/^vision/.test(name)) { ids.add('platform_windows'); ids.add('windows_ocr'); }
  if (name === 'office' || /^office_(ppt|outlook)$/.test(name) || name === 'inspect_workbook' || name === 'docx_merge') ids.add('office_desktop');
  if (name === 'inspect_pdf' || name === 'pdf_extract_tables') ids.add('local_pdf_provider');
  if (name === 'lsp_diagnostics' || name === 'lsp_rename') ids.add('configured_lsp');
  if (name === 'db_inspect' || name === 'db_query') ids.add('database_target');
  if (name === 'sandbox_exec') ids.add('windows_sandbox');
  if (name === 'network_context' || name === 'console_context') ids.add('browser_event_stream');
  if (/^(web_fetch$|network_context$|mcp_)/.test(name)) ids.add('network_access');
  if (/^scheduler$/.test(name)) { ids.add('platform_windows'); ids.add('scheduler_runtime'); }
  if (/^(windows_environment$|service_context$|process_context$|port_context$|registry_context$|event_log_context$|installed_runtime_context$|path_context$|startup_context$|event_watch$|crash_trace$|sandbox_exec$)/.test(name)) ids.add('platform_windows');
  const upgrade = upgradeCatalogEntry(name);
  if (upgrade !== undefined && (upgrade.deliveryState === 'feature_disabled' || upgrade.deliveryState === 'planned')) ids.add('feature_delivery');
  return Object.freeze([...ids]);
}

function riskModeFor(name: string): ToolRiskMode {
  return INPUT_DEPENDENT_TOOLS.has(name) ? 'input_dependent' : 'fixed';
}
