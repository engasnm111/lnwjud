import { z } from 'zod';

export const OFFICE_SEMANTIC_TOOL_NAMES = [
  'office_status',
  'office_word',
  'office_excel',
  'office_powerpoint',
  'office_outlook',
  'office_calendar',
  'office_contacts',
  'office_tasks',
  'office_onenote',
  'office_onedrive',
  'office_sharepoint',
  'office_teams',
  'office_access',
  'office_visio',
  'office_project',
  'office_publisher',
  'office_convert',
  'office_batch',
] as const;

export type OfficeSemanticToolName = (typeof OFFICE_SEMANTIC_TOOL_NAMES)[number];

const workspaceId = z.string().min(1).max(128).optional();
const pathField = z.string().min(1).max(4096).optional();
const shortText = z.string().max(32_768).optional();
const longText = z.string().max(262_144).optional();
const identifier = z.string().min(1).max(2048).optional();
const positiveInt = z.number().int().positive().optional();
const nonNegativeInt = z.number().int().nonnegative().optional();
const booleanField = z.boolean().optional();
const stringArray = z.array(z.string().max(32_768)).max(512).optional();
const recordField = z.record(z.string(), z.unknown()).optional();
const commonMutation = {
  dryRun: booleanField,
  dry_run: booleanField,
};

export const OFFICE_WORD_ACTIONS = [
  'create', 'inspect_document', 'read_text', 'read_range', 'get_structure', 'get_sections',
  'get_paragraphs', 'get_runs', 'get_styles', 'get_headings', 'get_tables', 'get_images',
  'get_headers_footers', 'get_bookmarks', 'get_hyperlinks', 'get_fields', 'get_comments',
  'get_revisions', 'get_footnotes', 'get_endnotes', 'search', 'document_properties',
  'page_setup', 'protection_status', 'insert_text', 'append_text', 'prepend_text',
  'replace_text', 'replace_range', 'delete_range', 'set_font', 'set_character_format',
  'set_paragraph_format', 'set_alignment', 'set_spacing', 'apply_style',
  'create_or_update_style', 'add_heading', 'add_page_break', 'add_section_break',
  'insert_table', 'update_table_cells', 'add_row', 'delete_row', 'add_column',
  'delete_column', 'merge_cells', 'split_cells', 'set_table_style', 'insert_image',
  'replace_image', 'add_textbox', 'add_shape', 'add_hyperlink', 'edit_hyperlink',
  'add_bookmark', 'remove_bookmark', 'update_header_footer', 'page_numbering',
  'set_page_setup', 'add_footnote', 'add_endnote', 'update_toc', 'update_field',
  'add_comment', 'read_comments', 'resolve_comment', 'delete_comment', 'set_track_changes',
  'accept_revision', 'reject_revision', 'mail_merge_preview', 'mail_merge', 'merge',
  'save', 'save_as', 'export_pdf', 'export_text', 'print', 'protect', 'unprotect',
] as const;

export const OFFICE_EXCEL_ACTIONS = [
  'audit_data', 'compare_cells', 'create_report',
  'create', 'list_sheets', 'inspect_workbook', 'used_range', 'read_range', 'read_values',
  'read_formulas', 'read_number_formats', 'read_styles', 'read_tables', 'read_named_ranges',
  'read_charts', 'read_pivots', 'read_filters', 'read_data_validation',
  'read_conditional_formatting', 'workbook_properties', 'connection_metadata',
  'calculation_status', 'search', 'add_sheet', 'delete_sheet', 'rename_sheet', 'copy_sheet',
  'move_sheet', 'write_values', 'write_formulas', 'fill_range', 'copy_range',
  'clear_contents', 'clear_formats', 'insert_rows', 'delete_rows', 'insert_columns',
  'delete_columns', 'merge_cells', 'unmerge_cells', 'set_row_height', 'set_column_width',
  'autofit', 'set_number_format', 'set_font', 'set_fill', 'set_border', 'set_alignment',
  'create_table', 'resize_table', 'style_table', 'sort', 'filter', 'clear_filter',
  'freeze_panes', 'create_named_range', 'update_named_range', 'delete_named_range',
  'set_data_validation', 'delete_data_validation', 'set_conditional_formatting',
  'delete_conditional_formatting', 'add_comment', 'add_hyperlink', 'insert_image',
  'replace_image', 'create_chart', 'update_chart', 'delete_chart', 'create_pivot',
  'refresh_pivot', 'update_pivot', 'recalculate', 'refresh_connections', 'protect',
  'unprotect', 'save', 'save_as', 'export_csv', 'export_tsv', 'export_pdf', 'print',
  'list_macros', 'run_macro', 'formula_errors',
] as const;

export const OFFICE_POWERPOINT_ACTIONS = [
  'create', 'inspect_presentation', 'list_slides', 'get_slide', 'get_slide_text',
  'get_shapes', 'get_images', 'get_tables', 'get_charts', 'get_notes', 'get_layout',
  'presentation_properties', 'slide_size', 'get_hyperlinks', 'get_transitions',
  'add_slide', 'duplicate_slide', 'delete_slide', 'reorder_slide', 'change_layout',
  'edit_text', 'add_textbox', 'edit_textbox', 'remove_textbox', 'add_shape', 'edit_shape',
  'remove_shape', 'add_image', 'edit_image', 'remove_image', 'crop_image', 'add_table',
  'edit_table', 'add_chart', 'edit_chart', 'add_hyperlink', 'set_notes', 'set_background',
  'set_theme', 'set_master', 'set_slide_size', 'set_transition', 'save', 'save_as',
  'export_pdf', 'export_images', 'export_video', 'print',
] as const;

export const OFFICE_OUTLOOK_ACTIONS = [
  'list_folders', 'list_messages', 'get_message', 'get_headers', 'get_body',
  'list_attachments', 'save_attachment', 'search', 'conversation', 'get_state',
  'mailbox_status', 'create_draft', 'update_draft', 'add_recipients', 'remove_recipients',
  'attach_file', 'detach_file', 'reply_draft', 'reply_all_draft', 'forward_draft',
  'set_importance', 'set_category', 'set_flag', 'mark_read', 'mark_unread',
  'move_message', 'copy_message', 'send', 'delete', 'permanent_delete',
] as const;

export const OFFICE_CALENDAR_ACTIONS = [
  'list_calendars', 'get_events', 'search_events', 'get_event', 'availability',
  'create_event', 'update_event', 'move_event', 'add_attendees', 'remove_attendees',
  'set_reminder', 'set_recurrence', 'set_location', 'send_invite', 'send_update',
  'cancel_event', 'delete_event', 'respond',
] as const;

export const OFFICE_CONTACT_ACTIONS = [
  'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact',
  'set_categories', 'create_group', 'update_group', 'delete_contact',
] as const;

export const OFFICE_TASK_ACTIONS = [
  'list_task_folders', 'list_tasks', 'search_tasks', 'get_task', 'create_task',
  'update_task', 'complete_task', 'reopen_task', 'delete_task',
] as const;

export const OFFICE_ONENOTE_ACTIONS = [
  'list_notebooks', 'list_sections', 'list_pages', 'read_page', 'search',
  'create_page', 'append_page', 'update_page', 'add_resource', 'move_page',
  'copy_page', 'delete_page',
] as const;

export const OFFICE_ONEDRIVE_ACTIONS = [
  'list', 'search', 'metadata', 'download', 'upload', 'create_folder', 'copy', 'move',
  'rename', 'versions', 'sharing', 'update_sharing', 'delete', 'restore',
] as const;

export const OFFICE_SHAREPOINT_ACTIONS = [
  'list_sites', 'search_sites', 'list_drives', 'list_items', 'read_item', 'list_files',
  'download', 'upload', 'create_item', 'update_item', 'sharing', 'update_sharing',
] as const;

export const OFFICE_TEAMS_ACTIONS = [
  'list_teams', 'list_channels', 'list_messages', 'get_message', 'draft_message',
  'send_message',
] as const;

export const OFFICE_ACCESS_ACTIONS = [
  'status', 'inspect', 'list_objects', 'table_schema', 'query', 'create_table',
  'update_table', 'create_query', 'update_query', 'import', 'export', 'run_saved_query',
  'export_report', 'compact_repair', 'run_vba',
] as const;

export const OFFICE_VISIO_ACTIONS = [
  'status', 'list_pages', 'list_layers', 'list_masters', 'read_shapes', 'create_shape',
  'update_shape', 'delete_shape', 'connect_shapes', 'set_position', 'set_layer',
  'page_properties', 'export_pdf', 'export_svg', 'export_png', 'validate',
] as const;

export const OFFICE_PROJECT_ACTIONS = [
  'status', 'metadata', 'list_tasks', 'list_milestones', 'list_dependencies',
  'list_resources', 'list_assignments', 'list_calendars', 'create_task', 'update_task',
  'create_resource', 'update_resource', 'create_assignment', 'update_assignment',
  'set_baseline', 'save', 'export_pdf', 'export_excel',
] as const;

export const OFFICE_PUBLISHER_ACTIONS = [
  'status', 'inspect', 'list_pages', 'read_text', 'read_images', 'create_element',
  'update_element', 'save', 'save_as', 'export_pdf',
] as const;

const wordSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_WORD_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  merge_paths: z.array(z.string().min(1).max(4096)).max(32).optional(),
  text: longText,
  find: shortText,
  replace_with: longText,
  range: recordField,
  table: recordField,
  style: recordField,
  image_path: pathField,
  index: nonNegativeInt,
  parameters: recordField,
  ...commonMutation,
}).strict();

const excelSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_EXCEL_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  sheet: z.string().max(256).optional(),
  range: z.string().max(256).optional(),
  values: z.unknown().optional(),
  formulas: z.unknown().optional(),
  name: z.string().max(256).optional(),
  new_name: z.string().max(256).optional(),
  index: nonNegativeInt,
  count: positiveInt,
  parameters: recordField,
  password: z.string().max(4096).optional(),
  macro: z.string().max(512).optional(),
  ...commonMutation,
}).strict();

const powerpointSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_POWERPOINT_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  slide: positiveInt,
  target_slide: positiveInt,
  shape: identifier,
  text: longText,
  image_path: pathField,
  parameters: recordField,
  ...commonMutation,
}).strict();

const outlookSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_OUTLOOK_ACTIONS),
  folder: z.string().max(2048).optional(),
  target_folder: z.string().max(2048).optional(),
  max_messages: z.number().int().min(1).max(100).optional(),
  page: positiveInt,
  query: z.string().max(8192).optional(),
  message_id: identifier,
  draft_id: identifier,
  subject: z.string().max(4096).optional(),
  body: longText,
  body_html: z.string().max(524_288).optional(),
  to: stringArray,
  cc: stringArray,
  bcc: stringArray,
  recipients: stringArray,
  attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
  attachment_id: identifier,
  target_path: pathField,
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const calendarSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_CALENDAR_ACTIONS),
  calendar: identifier,
  event_id: identifier,
  query: z.string().max(8192).optional(),
  start: z.string().max(128).optional(),
  end: z.string().max(128).optional(),
  max_results: z.number().int().min(1).max(200).optional(),
  subject: z.string().max(4096).optional(),
  body: longText,
  attendees: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const contactsSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_CONTACT_ACTIONS),
  contact_id: identifier,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  name: z.string().max(4096).optional(),
  email: z.string().max(4096).optional(),
  company: z.string().max(4096).optional(),
  title: z.string().max(4096).optional(),
  phones: recordField,
  addresses: recordField,
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const tasksSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_TASK_ACTIONS),
  task_id: identifier,
  folder: identifier,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  subject: z.string().max(4096).optional(),
  body: longText,
  due: z.string().max(128).optional(),
  reminder: z.string().max(128).optional(),
  importance: z.string().max(64).optional(),
  status: z.string().max(128).optional(),
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const cloudBase = {
  workspaceId,
  item_id: identifier,
  parent_id: identifier,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  file_path: pathField,
  target_path: pathField,
  name: z.string().max(4096).optional(),
  body: longText,
  parameters: recordField,
  ...commonMutation,
};

const oneNoteSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_ONENOTE_ACTIONS), notebook_id: identifier, section_id: identifier, page_id: identifier }).strict();
const oneDriveSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_ONEDRIVE_ACTIONS), drive_id: identifier }).strict();
const sharePointSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_SHAREPOINT_ACTIONS), site_id: identifier, drive_id: identifier, list_id: identifier }).strict();
const teamsSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_TEAMS_ACTIONS), team_id: identifier, channel_id: identifier, message_id: identifier }).strict();

const optionalBase = {
  workspaceId,
  file_path: pathField,
  target_path: pathField,
  item_id: identifier,
  name: z.string().max(4096).optional(),
  query: z.string().max(65_536).optional(),
  parameters: recordField,
  ...commonMutation,
};

const accessSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_ACCESS_ACTIONS) }).strict();
const visioSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_VISIO_ACTIONS) }).strict();
const projectSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_PROJECT_ACTIONS) }).strict();
const publisherSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_PUBLISHER_ACTIONS) }).strict();

const convertSchema = z.object({
  workspaceId,
  source_path: z.string().min(1).max(4096),
  target_path: z.string().min(1).max(4096),
  format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'txt', 'png', 'jpeg']).optional(),
  ...commonMutation,
}).strict();

const batchOperationSchema = z.object({
  tool: z.enum([
    'office_word', 'office_excel', 'office_powerpoint', 'office_outlook', 'office_calendar',
    'office_contacts', 'office_tasks', 'office_onenote', 'office_onedrive',
    'office_sharepoint', 'office_teams', 'office_access', 'office_visio',
    'office_project', 'office_publisher', 'office_convert',
  ]),
  input: z.record(z.string(), z.unknown()),
}).strict();

const batchSchema = z.object({
  workspaceId,
  operations: z.array(batchOperationSchema).min(1).max(32),
  fail_fast: z.boolean().optional(),
  dryRun: booleanField,
  dry_run: booleanField,
}).strict();

const statusSchema = z.object({
  workspaceId,
  include_optional: z.boolean().optional(),
}).strict();

const OFFICE_SCHEMAS: Record<OfficeSemanticToolName, z.ZodObject> = {
  office_status: statusSchema,
  office_word: wordSchema,
  office_excel: excelSchema,
  office_powerpoint: powerpointSchema,
  office_outlook: outlookSchema,
  office_calendar: calendarSchema,
  office_contacts: contactsSchema,
  office_tasks: tasksSchema,
  office_onenote: oneNoteSchema,
  office_onedrive: oneDriveSchema,
  office_sharepoint: sharePointSchema,
  office_teams: teamsSchema,
  office_access: accessSchema,
  office_visio: visioSchema,
  office_project: projectSchema,
  office_publisher: publisherSchema,
  office_convert: convertSchema,
  office_batch: batchSchema,
};

export function isOfficeSemanticToolName(value: string): value is OfficeSemanticToolName {
  return (OFFICE_SEMANTIC_TOOL_NAMES as readonly string[]).includes(value);
}

export function officeToolInputSchema(name: OfficeSemanticToolName): z.ZodObject {
  return OFFICE_SCHEMAS[name];
}

export const OFFICE_READ_ACTIONS = new Set<string>([
  'audit_data', 'compare_cells',
  'status', 'inspect_document', 'read_text', 'read_range', 'get_structure', 'get_sections',
  'get_paragraphs', 'get_runs', 'get_styles', 'get_headings', 'get_tables', 'get_images',
  'get_headers_footers', 'get_bookmarks', 'get_hyperlinks', 'get_fields', 'get_comments',
  'get_revisions', 'get_footnotes', 'get_endnotes', 'search', 'document_properties',
  'page_setup', 'protection_status', 'list_sheets', 'inspect_workbook', 'used_range',
  'read_values', 'read_formulas', 'read_number_formats', 'read_styles', 'read_tables',
  'read_named_ranges', 'read_charts', 'read_pivots', 'read_filters',
  'read_data_validation', 'read_conditional_formatting', 'workbook_properties',
  'connection_metadata', 'calculation_status', 'formula_errors', 'list_macros',
  'inspect_presentation', 'list_slides', 'get_slide', 'get_slide_text', 'get_shapes',
  'get_notes', 'get_layout', 'presentation_properties', 'slide_size', 'get_transitions',
  'list_folders', 'list_messages', 'get_message', 'get_headers', 'get_body',
  'list_attachments', 'conversation', 'get_state', 'mailbox_status', 'list_calendars',
  'get_events', 'search_events', 'get_event', 'availability', 'list_contacts',
  'search_contacts', 'get_contact', 'list_task_folders', 'list_tasks', 'search_tasks',
  'get_task', 'list_notebooks', 'list_sections', 'list_pages', 'read_page', 'list',
  'metadata', 'versions', 'sharing', 'list_sites', 'search_sites', 'list_drives',
  'list_items', 'read_item', 'list_files', 'list_teams', 'list_channels',
  'list_objects', 'table_schema', 'query', 'list_layers', 'list_masters',
  'read_shapes', 'validate', 'list_milestones', 'list_dependencies', 'list_resources',
  'list_assignments', 'inspect',
]);

export const OFFICE_DESTRUCTIVE_ACTIONS = new Set<string>([
  'delete', 'permanent_delete', 'delete_event', 'cancel_event', 'delete_contact',
  'delete_task', 'delete_page', 'delete_shape', 'delete_sheet', 'delete_row',
  'delete_column', 'delete_rows', 'delete_columns', 'remove_textbox', 'remove_shape',
  'remove_image', 'delete_chart', 'delete_named_range', 'delete_data_validation',
  'delete_conditional_formatting', 'delete_comment',
]);

export const OFFICE_DANGEROUS_ACTIONS = new Set<string>([
  'send', 'send_invite', 'send_update', 'respond', 'print', 'run_macro', 'run_vba',
  'refresh_connections', 'mail_merge', 'export_video', 'compact_repair', 'set_baseline',
]);
