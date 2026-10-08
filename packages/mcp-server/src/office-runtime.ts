import { extname } from 'node:path';
import { open, stat } from 'node:fs/promises';
import {
  appError,
  err,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { withReplacementRecoveryDetails } from './replacement-recovery.js';
import {
  OFFICE_DANGEROUS_ACTIONS,
  OFFICE_READ_ACTIONS,
  type OfficeSemanticToolName,
} from './office-tool-contracts.js';
import type { McpApplicationServices } from './tools/tool-types.js';

type OfficeLocalApp = 'word' | 'excel' | 'powerpoint' | 'outlook' | 'access' | 'visio' | 'project' | 'publisher';

const TOOL_APP: Partial<Record<OfficeSemanticToolName, OfficeLocalApp>> = {
  office_word: 'word',
  office_excel: 'excel',
  office_powerpoint: 'powerpoint',
  office_outlook: 'outlook',
  office_calendar: 'outlook',
  office_contacts: 'outlook',
  office_tasks: 'outlook',
  office_access: 'access',
  office_visio: 'visio',
  office_project: 'project',
  office_publisher: 'publisher',
};

const GRAPH_TOOLS = new Set<OfficeSemanticToolName>([
  'office_onenote',
  'office_onedrive',
  'office_sharepoint',
  'office_teams',
]);

const OPTIONAL_LOCAL_TOOLS = new Set<OfficeSemanticToolName>([
  'office_access',
  'office_visio',
  'office_project',
  'office_publisher',
]);

const WINDOWS_LOCAL_ACTIONS: Readonly<Partial<Record<OfficeSemanticToolName, ReadonlySet<string>>>> = {
  office_word: new Set([
    'create', 'inspect_document', 'read_text', 'read_range', 'get_structure', 'get_sections',
    'get_paragraphs', 'get_headings', 'get_tables', 'get_images', 'get_headers_footers', 'get_bookmarks',
    'get_hyperlinks', 'get_comments', 'get_revisions', 'search', 'document_properties', 'protection_status',
    'insert_text', 'append_text', 'prepend_text', 'replace_text', 'insert_table', 'update_table_cells',
    'add_row', 'delete_row', 'add_column', 'delete_column', 'insert_image', 'update_header_footer',
    'add_comment', 'read_comments', 'set_track_changes', 'accept_revision', 'reject_revision', 'set_font',
    'apply_style', 'protect', 'unprotect', 'merge', 'save', 'save_as', 'export_pdf', 'export_text',
  ]),
  office_excel: new Set([
    'create', 'list_sheets', 'inspect_workbook', 'used_range', 'read_range', 'read_values',
    'read_formulas', 'read_number_formats', 'read_styles', 'read_tables', 'read_charts', 'read_pivots',
    'workbook_properties', 'calculation_status', 'search', 'write_values', 'write_formulas', 'add_sheet',
    'delete_sheet', 'rename_sheet', 'fill_range', 'copy_range', 'clear_contents', 'clear_formats',
    'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'merge_cells', 'unmerge_cells',
    'set_row_height', 'set_column_width', 'autofit', 'set_number_format', 'set_font', 'set_fill',
    'set_alignment', 'create_table', 'resize_table', 'style_table', 'sort', 'filter', 'clear_filter',
    'freeze_panes', 'set_data_validation', 'delete_data_validation', 'add_comment', 'insert_image',
    'create_chart', 'update_chart', 'delete_chart', 'create_pivot', 'refresh_pivot', 'update_pivot',
    'recalculate', 'protect', 'unprotect', 'formula_errors',
    'save', 'save_as', 'export_pdf', 'export_csv', 'export_tsv',
  ]),
  office_powerpoint: new Set([
    'create', 'inspect_presentation', 'list_slides', 'get_slide', 'get_slide_text', 'get_shapes',
    'get_notes', 'get_layout', 'get_images', 'get_tables', 'get_charts', 'presentation_properties',
    'slide_size', 'add_slide', 'duplicate_slide', 'delete_slide', 'reorder_slide', 'edit_text',
    'add_textbox', 'add_image', 'add_table', 'edit_table', 'add_chart', 'edit_chart', 'set_notes',
    'save', 'save_as', 'export_pdf',
  ]),
  office_outlook: new Set([
    'list_folders', 'list_messages', 'get_message', 'get_headers', 'get_body', 'list_attachments',
    'save_attachment', 'search', 'conversation', 'get_state', 'mailbox_status', 'create_draft',
    'update_draft', 'add_recipients', 'remove_recipients', 'attach_file', 'detach_file',
    'set_importance', 'set_category', 'set_flag', 'mark_read', 'mark_unread', 'move_message',
    'copy_message', 'send', 'delete',
  ]),
  office_calendar: new Set([
    'list_calendars', 'get_events', 'search_events', 'get_event', 'create_event', 'update_event',
    'delete_event', 'send_invite',
  ]),
  office_contacts: new Set([
    'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact', 'delete_contact',
  ]),
  office_tasks: new Set([
    'list_task_folders', 'list_tasks', 'search_tasks', 'get_task', 'create_task', 'update_task',
    'complete_task', 'reopen_task', 'delete_task',
  ]),
};

const FILE_MUTATION_ACTIONS = new Set([
  'create', 'save', 'save_as', 'merge', 'save_attachment', 'export_pdf', 'export_text', 'export_csv',
  'export_tsv', 'export_images', 'insert_text', 'append_text', 'prepend_text',
  'replace_text', 'replace_range', 'delete_range', 'set_font', 'set_character_format',
  'set_paragraph_format', 'set_alignment', 'set_spacing', 'apply_style',
  'create_or_update_style', 'add_heading', 'add_page_break', 'add_section_break',
  'insert_table', 'update_table_cells', 'add_row', 'delete_row', 'add_column',
  'delete_column', 'merge_cells', 'split_cells', 'set_table_style', 'insert_image',
  'replace_image', 'add_textbox', 'add_shape', 'add_hyperlink', 'edit_hyperlink',
  'add_bookmark', 'remove_bookmark', 'update_header_footer', 'page_numbering',
  'set_page_setup', 'add_footnote', 'add_endnote', 'update_toc', 'update_field',
  'add_comment', 'resolve_comment', 'delete_comment', 'set_track_changes',
  'accept_revision', 'reject_revision', 'protect', 'unprotect', 'add_sheet',
  'delete_sheet', 'rename_sheet', 'copy_sheet', 'move_sheet', 'write_values',
  'write_formulas', 'fill_range', 'copy_range', 'clear_contents', 'clear_formats',
  'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'unmerge_cells',
  'set_row_height', 'set_column_width', 'autofit', 'set_number_format', 'set_fill',
  'set_border', 'create_table', 'resize_table', 'style_table', 'sort', 'filter',
  'clear_filter', 'freeze_panes', 'create_named_range', 'update_named_range',
  'delete_named_range', 'set_data_validation', 'delete_data_validation',
  'set_conditional_formatting', 'delete_conditional_formatting', 'create_chart',
  'update_chart', 'delete_chart', 'create_pivot', 'refresh_pivot', 'update_pivot',
  'recalculate', 'refresh_connections', 'add_slide', 'duplicate_slide', 'delete_slide',
  'reorder_slide', 'change_layout', 'edit_text', 'edit_textbox', 'remove_textbox',
  'edit_shape', 'remove_shape', 'add_image', 'edit_image', 'remove_image',
  'crop_image', 'add_table', 'edit_table', 'add_chart', 'edit_chart', 'set_notes',
  'set_background', 'set_theme', 'set_master', 'set_slide_size', 'set_transition',
]);

const OUTPUT_ACTIONS = new Set(['save_as', 'export_pdf', 'export_text', 'export_csv', 'export_tsv', 'export_images']);

export class OfficeRuntimeService {
  private readonly platform: NodeJS.Platform;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
  ) {
    this.platform = services.platform ?? process.platform;
  }

  public async execute(
    tool: OfficeSemanticToolName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    if (tool === 'office_status') return this.status(input, authorization);
    if (tool === 'office_excel' && ['audit_data','compare_cells','create_report'].includes(String(input.action))) {
      const provider = this.services.officeDataWorkflow;
      if (!provider) return err(appError('UNSUPPORTED_PLATFORM','Local CSV/XLSX provider is unavailable'));
      const workspaceId = readString(input.workspaceId);
      const filePath = readString(input.file_path);
      if (!workspaceId || !filePath) return err(appError('INVALID_INPUT','workspaceId and file_path required'));
      const params = isRecord(input.parameters) ? input.parameters : {};
      const keyColumns = Array.isArray(params.keyColumns) && params.keyColumns.every((item)=>typeof item === 'string')
        ? params.keyColumns as string[] : [];
      if (input.action === 'audit_data') return provider.audit(this.actor, {
        workspaceId, inputPath:filePath,keyColumns,
        ...(typeof input.sheet==='string'?{sheet:input.sheet}:{}),
        ...(typeof params.scanCellLimit==='number'?{scanCellLimit:params.scanCellLimit}:{}),
        ...(typeof params.maxFindings==='number'?{maxFindings:params.maxFindings}:{}),
      },signal);
      if (input.action === 'compare_cells') {
        const rightPath = readString(input.target_path);
        if(!rightPath) return err(appError('INVALID_INPUT','compare_cells requires target_path'));
        return provider.compare(this.actor,{
          workspaceId,leftPath:filePath,rightPath,
          ...(typeof input.sheet==='string'?{sheet:input.sheet}:{}),
          ...(typeof params.maxFindings==='number'?{maxFindings:params.maxFindings}:{}),
        },signal);
      }
      const templatePath=readString(params.templatePath);
      const mappingPath=readString(params.mappingPath);
      const outputPath=readString(input.target_path);
      if(!templatePath||!mappingPath||!outputPath) return err(appError('INVALID_INPUT','create_report requires templatePath, mappingPath and target_path'));
      if (usesDefaultDryRun(input)) return ok({
        executed:false,dryRun:true,action:'create_report',provider:'file_xlsx',
        plan:'Produce a new XLSX from validated CSV/XLSX and a supported XLSX reference template, then verify readback.',
      });
      return provider.createReport(this.actor,{workspaceId,inputPath:filePath,templatePath,mappingPath,outputPath,keyColumns,
        ...(signal===undefined?{}:{signal})});
    }

    if (tool === 'office_batch') return this.batch(input, signal, authorization);
    if (tool === 'office_convert') return this.convert(input, signal, authorization);
    if (GRAPH_TOOLS.has(tool)) return graphUnavailable(tool);

    const app = TOOL_APP[tool];
    if (app === undefined) return err(appError('INVALID_INPUT', `Unsupported Office semantic tool: ${tool}`));
    const action = readString(input.action);
    if (action === undefined) return err(appError('INVALID_INPUT', `${tool} requires action`));

    if (OPTIONAL_LOCAL_TOOLS.has(tool) && action !== 'status') {
      return optionalProviderUnavailable(tool, app, this.platform);
    }

    if (action === 'status') return this.localAppStatus(tool, app, authorization);
    if (this.platform !== 'win32') {
      return localProviderUnavailable(tool, app, this.platform);
    }

    const capabilities = this.services.capabilities;
    if (capabilities === undefined) return providerMissing(tool, app);

    if (!isWindowsLocalActionSupported(tool, action)) {
      return ok({
        tool,
        status: 'unsupported',
        available: false,
        ready: false,
        executed: false,
        provider: providerName(this.platform),
        app,
        action,
        supportedActions: [...(WINDOWS_LOCAL_ACTIONS[tool] ?? [])],
        reason: `${tool} ${action} is not implemented by the verified Windows Office provider`,
      });
    }

    const readOnly = OFFICE_READ_ACTIONS.has(action);
    if (!readOnly && usesDefaultDryRun(input)) {
      return ok({
        tool,
        status: 'ready',
        available: true,
        ready: true,
        executed: false,
        dryRun: true,
        provider: providerName(this.platform),
        app,
        action,
        plan: summarizePlan(input),
      });
    }

    let providerInput: Record<string, unknown> = {
      ...input,
      app,
      action,
      timeout_seconds: boundedOfficeTimeoutSeconds(input, readOnly ? 60 : 120, readOnly ? 120 : 300),
      ...(tool === 'office_outlook' && action === 'list_messages' && typeof input.max_messages === 'number'
        ? { max_messages: Math.min(100, Math.max(1, Math.trunc(input.max_messages))) }
        : {}),
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    };
    let replacementBackup: { readonly recoveryId: string; readonly recoveryPath: string } | undefined;

    if (!readOnly && FILE_MUTATION_ACTIONS.has(action)) {
      const prepared = await this.prepareFileMutation(tool, action, providerInput, signal, authorization);
      if (!prepared.ok) return prepared;
      providerInput = prepared.value.input;
      replacementBackup = prepared.value.replacementBackup;
    }

    const result = await capabilities.execute('office', providerInput, signal, authorization);
    if (!result.ok) {
      if (isUnsupportedProviderError(result.error.message)) {
        return ok({
          tool,
          status: 'unsupported',
          available: false,
          ready: false,
          executed: false,
          provider: providerName(this.platform),
          app,
          action,
          reason: result.error.message,
        });
      }
      return withReplacementRecoveryDetails(result, replacementBackup);
    }

    return ok({
      tool,
      status: 'ready',
      available: true,
      ready: true,
      executed: true,
      dryRun: false,
      provider: providerName(this.platform),
      app,
      action,
      result: result.value,
      ...(replacementBackup === undefined ? {} : { replacementBackup }),
    });
  }

  private async status(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const localApps: OfficeLocalApp[] = ['word', 'excel', 'powerpoint', 'outlook'];
    if (input.include_optional === true) localApps.push('access', 'visio', 'project', 'publisher');

    const apps: Record<string, unknown> = {};
    if (this.services.capabilities === undefined) {
      for (const app of localApps) {
        apps[app] = { ready: false, available: false, provider: providerName(this.platform), reason: 'Office capability is not configured' };
      }
    } else if (this.platform === 'win32') {
      for (const app of localApps) {
        const result = await this.services.capabilities.execute('office', {
          app,
          action: 'status',
          timeout_seconds: 15,
          ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
        }, undefined, authorization);
        if (result.ok) {
          const providerStatus = isRecord(result.value) ? result.value : {};
          const semanticTools = windowsSemanticSupportForApp(app);
          const dependencyAvailable = providerStatus.available === true || providerStatus.ready === true;
          const semanticReady = semanticTools.some((entry) => entry.supportedActions.length > 0);
          apps[app] = {
            provider: providerName(this.platform),
            ...providerStatus,
            available: dependencyAvailable,
            dependencyAvailable,
            ready: dependencyAvailable && semanticReady,
            semanticTools,
            ...(semanticReady ? {} : { reason: 'No verified semantic Office actions are implemented for this app' }),
          };
        } else {
          apps[app] = { provider: providerName(this.platform), ready: false, available: false, reason: result.error.message };
        }
      }
    } else {
      const result = await this.services.capabilities.execute('office', {
        action: 'status',
        app: 'word',
        timeout_seconds: 15,
        ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
      }, undefined, authorization);
      const status = result.ok && isRecord(result.value) ? result.value : {};
      for (const app of localApps) {
        apps[app] = {
          provider: providerName(this.platform),
          ready: false,
          available: status.dependencyReady === true,
          reason: readString(status.reason) ?? 'No verified native action provider is implemented for this platform',
        };
      }
    }

    return ok({
      tool: 'office_status',
      status: 'ready',
      available: true,
      ready: true,
      executed: true,
      platform: this.platform,
      providers: {
        local: {
          name: providerName(this.platform),
          apps,
        },
        microsoft_graph: {
          name: 'microsoft-graph',
          ready: false,
          available: false,
          signedIn: false,
          reason: 'Microsoft Graph OAuth is not configured in the current runtime',
          tokenExposed: false,
        },
        ui_fallback: {
          name: 'desktop-ui-fallback',
          ready: false,
          enabled: false,
          reason: 'UI automation is never selected implicitly for Office semantic tools',
        },
      },
      policy: {
        macrosEnabled: false,
        externalRefreshRequiresConfirmation: true,
        printRequiresConfirmation: true,
        sendRequiresConfirmation: true,
        destructiveActionsRequireConfirmation: true,
      },
    });
  }

  private async localAppStatus(
    tool: OfficeSemanticToolName,
    app: OfficeLocalApp,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return localProviderUnavailable(tool, app, this.platform);
    if (this.services.capabilities === undefined) return providerMissing(tool, app);
    const result = await this.services.capabilities.execute('office', { app, action: 'status', timeout_seconds: 15 }, undefined, authorization);
    if (!result.ok) return ok({
      tool, status: 'needs_setup', available: false, ready: false, executed: false,
      provider: providerName(this.platform), app, action: 'status', reason: result.error.message,
    });
    const providerStatus = isRecord(result.value) ? result.value : {};
    const dependencyAvailable = providerStatus.available === true || providerStatus.ready === true;
    const supportedActions = [...(WINDOWS_LOCAL_ACTIONS[tool] ?? [])];
    const semanticReady = dependencyAvailable && supportedActions.length > 0;
    return ok({
      tool,
      status: semanticReady ? 'ready' : 'unsupported',
      available: dependencyAvailable,
      dependencyAvailable,
      ready: semanticReady,
      executed: true,
      provider: providerName(this.platform),
      app,
      action: 'status',
      supportedActions,
      result: result.value,
      ...(semanticReady ? {} : { reason: `No verified semantic actions are implemented for ${tool}` }),
    });
  }

  private async prepareFileMutation(
    tool: OfficeSemanticToolName,
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<{ readonly input: Record<string, unknown>; readonly replacementBackup?: { readonly recoveryId: string; readonly recoveryPath: string } }>> {
    const workspaceId = readString(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${tool} ${action} requires workspaceId for local file mutation`));
    const fileSafety = this.services.file;
    if (fileSafety === undefined) return err(appError('INTERNAL_ERROR', 'File safety service is unavailable; refusing Office mutation', true));

    const filePath = readString(input.file_path);
    const targetPath = readString(input.target_path);
    const isCreate = action === 'create';
    const isOutput = OUTPUT_ACTIONS.has(action);
    const isAttachmentOutput = action === 'save_attachment';
    const isMerge = action === 'merge';
    const mergePaths = Array.isArray(input.merge_paths)
      ? input.merge_paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    let sourcePaths: readonly string[] = [];
    let mutationTarget: string | undefined;
    if (isCreate) {
      mutationTarget = filePath ?? targetPath;
    } else if (isAttachmentOutput) {
      mutationTarget = targetPath;
    } else if (isOutput) {
      if (filePath === undefined) return err(appError('INVALID_INPUT', `${tool} ${action} requires file_path`));
      sourcePaths = [filePath];
      mutationTarget = targetPath;
    } else if (isMerge) {
      if (filePath === undefined) return err(appError('INVALID_INPUT', 'office_word merge requires file_path'));
      sourcePaths = [filePath, ...mergePaths];
      mutationTarget = targetPath;
    } else {
      mutationTarget = filePath;
    }

    if (mutationTarget === undefined) {
      return err(appError('INVALID_INPUT', `${tool} ${action} requires ${isOutput || isMerge ? 'target_path' : 'file_path'}`));
    }

    const prepared = await fileSafety.prepareExternalFileMutation(this.actor, workspaceId, {
      sourcePaths,
      targetPath: mutationTarget,
      userConfirmed: input.userConfirmed === true,
    }, signal, authorization);
    if (!prepared.ok) return prepared;

    const normalized: Record<string, unknown> = { ...input, workspaceId };
    if (isAttachmentOutput) normalized.target_path = prepared.value.targetPath;
    else if (isCreate || (!isOutput && !isMerge)) normalized.file_path = prepared.value.targetPath;
    else {
      normalized.file_path = prepared.value.sourcePaths[0];
      normalized.target_path = prepared.value.targetPath;
      if (isMerge) normalized.merge_paths = prepared.value.sourcePaths.slice(1);
    }
    return ok({
      input: normalized,
      ...(prepared.value.replacementBackup === undefined ? {} : { replacementBackup: prepared.value.replacementBackup }),
    });
  }

  private async convert(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const source = readString(input.source_path);
    const target = readString(input.target_path);
    if (source === undefined || target === undefined) return err(appError('INVALID_INPUT', 'office_convert requires source_path and target_path'));
    const sourceExt = extname(source).toLowerCase();
    const targetExt = extname(target).toLowerCase();
    const requestedFormat = readString(input.format)?.toLowerCase();
    const targetFormat = targetExt.startsWith('.') ? targetExt.slice(1) : targetExt;
    if (requestedFormat !== undefined && requestedFormat !== targetFormat) {
      return err(appError('INVALID_INPUT', `Office conversion format ${requestedFormat} does not match target extension ${targetExt || '(none)'}`));
    }
    const route = conversionRoute(sourceExt, targetExt);
    if (route === undefined) {
      return ok({
        tool: 'office_convert', status: 'unsupported', available: false, ready: false, executed: false,
        source, target, reason: `No verified Office conversion route for ${sourceExt || '(no extension)'} -> ${targetExt || '(no extension)'}`,
      });
    }
    const routedInput: Record<string, unknown> = {
      workspaceId: input.workspaceId,
      action: route.action,
      file_path: source,
      target_path: target,
      dryRun: input.dryRun,
      dry_run: input.dry_run,
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    };
    const result = await this.execute(route.tool, routedInput, signal, authorization);
    if (!result.ok) return result;
    const value = result.value as Record<string, unknown>;
    if (value.executed !== true) return ok({ ...value, tool: 'office_convert', route: route.tool });
    const providerResult = isRecord(value.result) ? value.result : {};
    const verifiedTarget = readString(providerResult.target) ?? target;

    try {
      const output = await stat(verifiedTarget);
      if (!output.isFile() || output.size <= 0) return err(appError('INTERNAL_ERROR', 'Office conversion provider reported success but output is missing or empty', true));
      if (extname(verifiedTarget).toLowerCase() !== targetExt || !await verifyConvertedTargetType(verifiedTarget, targetExt)) {
        return err(appError('INTERNAL_ERROR', `Office conversion output failed target type verification for ${targetExt}`, true));
      }
      return ok({ ...value, tool: 'office_convert', route: route.tool, output: verifiedTarget, outputBytes: output.size, verified: true });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Office conversion provider reported success but output file was not found', true));
    }
  }

  private async batch(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0 || operations.length > 32) return err(appError('INVALID_INPUT', 'office_batch requires 1-32 operations'));
    const dryRun = usesDefaultDryRun(input);
    const failFast = input.fail_fast !== false;
    const workspaceId = readString(input.workspaceId);
    const results: unknown[] = [];
    let executed = false;

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (!isRecord(operation)) return err(appError('INVALID_INPUT', `office_batch operation ${index + 1} is invalid`));
      const tool = readString(operation.tool) as OfficeSemanticToolName | undefined;
      const childInput = isRecord(operation.input) ? operation.input : {};
      if (tool === undefined || tool === 'office_batch' || tool === 'office_status') {
        return err(appError('INVALID_INPUT', `office_batch operation ${index + 1} has unsupported tool`));
      }
      const childAction = readString(childInput.action);
      if (childAction !== undefined && OFFICE_DANGEROUS_ACTIONS.has(childAction)) {
        return err(appError('PERMISSION_REQUIRED', `office_batch cannot bundle dangerous action ${childAction}; call ${tool} directly with explicit confirmation`));
      }
      const child = await this.execute(tool, {
        ...childInput,
        ...(workspaceId === undefined || childInput.workspaceId !== undefined ? {} : { workspaceId }),
        ...(dryRun ? { dryRun: true } : { dryRun: false }),
        ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
        ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
      }, signal, authorization);
      const childValue = child.ok && isRecord(child.value) ? child.value : undefined;
      if (childValue?.executed === true) executed = true;
      results.push({ index, tool, ok: child.ok, ...(child.ok ? { value: child.value } : { error: child.error }) });
      const semanticFailure = childValue?.ready === false && childValue.executed === false;
      if (failFast && (!child.ok || semanticFailure)) break;
    }

    return ok({
      tool: 'office_batch', status: 'ready', available: true, ready: true,
      executed, dryRun, failFast, operationCount: operations.length, results,
    });
  }
}

async function verifyConvertedTargetType(targetPath: string, targetExt: string): Promise<boolean> {
  const handle = await open(targetPath, 'r');
  try {
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const bytes = prefix.subarray(0, bytesRead);
    if (targetExt === '.pdf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    if (['.docx', '.xlsx', '.xlsm', '.pptx', '.pptm'].includes(targetExt)) {
      return bytes.length >= 4
        && bytes[0] === 0x50
        && bytes[1] === 0x4b
        && ((bytes[2] === 0x03 && bytes[3] === 0x04)
          || (bytes[2] === 0x05 && bytes[3] === 0x06)
          || (bytes[2] === 0x07 && bytes[3] === 0x08));
    }
    if (['.doc', '.xls', '.ppt'].includes(targetExt)) {
      const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
      return bytes.length >= ole.length && ole.every((value, index) => bytes[index] === value);
    }
    if (targetExt === '.rtf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii').toLowerCase() === '{\\rtf';
    if (['.txt', '.csv', '.tsv'].includes(targetExt)) {
      if (bytes.length === 0) return false;
      if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
      return !bytes.includes(0);
    }
    return false;
  } finally {
    await handle.close();
  }
}

function conversionRoute(sourceExt: string, targetExt: string): { readonly tool: OfficeSemanticToolName; readonly action: string } | undefined {
  if (['.doc', '.docx', '.rtf'].includes(sourceExt)) {
    if (targetExt === '.pdf') return { tool: 'office_word', action: 'export_pdf' };
    if (targetExt === '.txt') return { tool: 'office_word', action: 'export_text' };
    if (['.doc', '.docx', '.rtf'].includes(targetExt)) return { tool: 'office_word', action: 'save_as' };
  }
  if (['.xls', '.xlsx', '.xlsm'].includes(sourceExt)) {
    if (targetExt === '.pdf') return { tool: 'office_excel', action: 'export_pdf' };
    if (targetExt === '.csv') return { tool: 'office_excel', action: 'export_csv' };
    if (targetExt === '.tsv') return { tool: 'office_excel', action: 'export_tsv' };
    if (['.xls', '.xlsx', '.xlsm'].includes(targetExt)) return { tool: 'office_excel', action: 'save_as' };
  }
  if (['.ppt', '.pptx', '.pptm'].includes(sourceExt)) {
    if (targetExt === '.pdf') return { tool: 'office_powerpoint', action: 'export_pdf' };
    if (['.ppt', '.pptx', '.pptm'].includes(targetExt)) return { tool: 'office_powerpoint', action: 'save_as' };
  }
  return undefined;
}

function providerName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'windows-office-com';
  if (platform === 'darwin') return 'macos-office-automation';
  if (platform === 'linux') return 'libreoffice-uno';
  return 'unsupported-local-office';
}

function graphUnavailable(tool: OfficeSemanticToolName): Result<unknown> {
  return ok({
    tool, status: 'needs_setup', available: false, ready: false, executed: false,
    provider: 'microsoft-graph',
    reason: 'Microsoft Graph OAuth/provider is not configured in this runtime; no cloud action was attempted',
    requirements: ['Microsoft Graph OAuth', 'least-privilege scopes for the requested workload'],
  });
}

function providerMissing(tool: OfficeSemanticToolName, app: OfficeLocalApp): Result<unknown> {
  return ok({
    tool, status: 'needs_setup', available: false, ready: false, executed: false,
    provider: 'local-office', app, reason: 'Office capability is not configured',
  });
}

function localProviderUnavailable(tool: OfficeSemanticToolName, app: OfficeLocalApp, platform: NodeJS.Platform): Result<unknown> {
  let requirement = `Verified native Office automation provider for ${app} on ${platform}`;
  if (platform === 'darwin') requirement = `Verified native macOS Office automation provider for ${app}`;
  if (platform === 'linux') requirement = `Verified LibreOffice UNO or equivalent native provider for ${app}`;
  return ok({
    tool, status: 'unsupported', available: false, ready: false, executed: false,
    provider: providerName(platform), app, requirements: [requirement],
    reason: `No verified ${app} action provider is production-ready on ${platform}; UI automation was not used as a substitute`,
  });
}

function optionalProviderUnavailable(tool: OfficeSemanticToolName, app: OfficeLocalApp, platform: NodeJS.Platform): Result<unknown> {
  return ok({
    tool, status: 'unsupported', available: false, ready: false, executed: false,
    provider: providerName(platform), app,
    reason: `${app} is optional and this runtime has no verified semantic action provider for the requested operation`,
  });
}

function summarizePlan(input: Record<string, unknown>): Record<string, unknown> {
  const plan: Record<string, unknown> = {};
  for (const key of ['workspaceId', 'action', 'file_path', 'target_path', 'sheet', 'range', 'slide', 'folder', 'target_folder'] as const) {
    if (input[key] !== undefined) plan[key] = input[key];
  }
  return plan;
}

function boundedOfficeTimeoutSeconds(input: Record<string, unknown>, fallback: number, maximum: number): number {
  const requested = input.timeout_seconds;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return fallback;
  return Math.min(maximum, Math.max(0.1, requested));
}

function usesDefaultDryRun(input: Record<string, unknown>): boolean {
  return input.dryRun !== false && input.dry_run !== false;
}

function isWindowsLocalActionSupported(tool: OfficeSemanticToolName, action: string): boolean {
  return WINDOWS_LOCAL_ACTIONS[tool]?.has(action) === true;
}

function windowsSemanticSupportForApp(app: OfficeLocalApp): Array<{ tool: OfficeSemanticToolName; supportedActions: string[] }> {
  return Object.entries(TOOL_APP)
    .filter((entry): entry is [OfficeSemanticToolName, OfficeLocalApp] => entry[1] === app)
    .map(([tool]) => ({ tool, supportedActions: [...(WINDOWS_LOCAL_ACTIONS[tool] ?? [])] }));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsupportedProviderError(message: string): boolean {
  return /unsupported|not implemented|not available|provider_not_implemented/i.test(message);
}
