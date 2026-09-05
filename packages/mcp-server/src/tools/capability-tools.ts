import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { DEFAULT_MCP_POLL_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS } from '@lnwjud/shared';
import { SetOfMarksObservationStore, SetOfMarksService } from '../set-of-marks-service.js';
import { ComputerUseService } from '../computer-use-service.js';
import { withReplacementRecoveryDetails } from '../replacement-recovery.js';
import { withCapabilityOwnerMetadata } from '../request-scope.js';
import {
  accessibilityCapabilitySchema,
  audioCapabilitySchema,
  clipboardCapabilitySchema,
  computerUseSchema,
  domCdpCapabilitySchema,
  fileDialogCapabilitySchema,
  healthCapabilitySchema,
  inputEventCapabilitySchema,
  notificationCapabilitySchema,
  officeCapabilitySchema,
  schedulerCapabilitySchema,
  screenRecordCapabilitySchema,
  shellCapabilitySchema,
  systemInfoCapabilitySchema,
  visionCapabilitySchema,
  visionAnnotatedCaptureSchema,
  uiTargetActionSchema,
  webFetchCapabilitySchema,
  windowCapabilitySchema,
  wslCapabilitySchema,
  wslFilesystemCapabilitySchema,
} from './schemas.js';

function currentMcpPollWaitSeconds(context: McpToolContext): number {
  const configured = context.services.runtimeTiming?.().mcpPollWaitSeconds ?? DEFAULT_MCP_POLL_WAIT_SECONDS;
  if (!Number.isFinite(configured)) return DEFAULT_MCP_POLL_WAIT_SECONDS;
  return Math.max(MIN_CONFIGURABLE_WAIT_SECONDS, Math.min(MAX_CONFIGURABLE_WAIT_SECONDS, configured));
}

function normalizeNonBlockingCliInput(input: unknown, maxPollWaitSeconds: number): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const operation = request.operation ?? 'run';
  if (operation === 'run') return { ...request, execution: 'background' };
  if (operation === 'wait') {
    const requestedWait = typeof request.timeout_seconds === 'number' ? request.timeout_seconds : maxPollWaitSeconds;
    return { ...request, timeout_seconds: Math.min(requestedWait, maxPollWaitSeconds) };
  }
  return input;
}

export function capabilityTools(context: McpToolContext, setOfMarksStore?: SetOfMarksObservationStore): McpToolDefinition[] {
  const execute = async (
    tool: Parameters<NonNullable<McpToolContext['services']['capabilities']>['execute']>[0],
    input: unknown,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> => {
    if (context.services.capabilities === undefined) return Promise.resolve(missingService());
    let normalized = tool === 'shell' || tool === 'wsl_exec'
      ? normalizeNonBlockingCliInput(input, currentMcpPollWaitSeconds(context))
      : input;
    let replacementBackup: { readonly recoveryId: string; readonly recoveryPath: string } | undefined;
    if (tool === 'office') {
      const prepared = await prepareOfficeMutation(context, normalized, signal, authorization);
      if (!prepared.ok) return prepared;
      normalized = prepared.value.input;
      replacementBackup = prepared.value.replacementBackup;
    } else if (tool === 'audio' || tool === 'screen_record') {
      const prepared = await prepareMediaOutputMutation(context, tool, normalized, signal, authorization);
      if (!prepared.ok) return prepared;
      normalized = prepared.value.input;
      replacementBackup = prepared.value.replacementBackup;
    }
    const owned = tool === 'shell' || tool === 'wsl_exec'
      ? withCapabilityOwnerMetadata(normalized, context.actor)
      : normalized;
    const result = await context.services.capabilities.execute(tool, owned, signal, authorization);
    if (!result.ok) return withReplacementRecoveryDetails(result, replacementBackup);
    if (replacementBackup === undefined) return result;
    const value = isRecord(result.value) ? result.value : { result: result.value };
    return ok({ ...value, replacementBackup });
  };
  const setOfMarksOwnerKey = `${context.actor.clientId}:${context.actor.sessionId?.trim() || context.actor.clientId}`;
  const setOfMarks = new SetOfMarksService(context.services.capabilities, {
    ...(setOfMarksStore === undefined ? {} : { store: setOfMarksStore }),
    ownerKey: setOfMarksOwnerKey,
  });
  const computerUse = new ComputerUseService(context.services.capabilities, setOfMarks);

  return [
    defineTool({
      name: 'shell',
      description: 'Non-blocking command runner for real command execution, builds/tests, package managers, and system operations. Never use shell as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell/sed commands that rewrite text files are rejected before native approval so the client can route to the guarded file tools instead. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. Shared services must be marked supporting_service with cancelWithGoal false. With Full Bypass OFF, Full Access runs ordinary policy-allowed commands without confirmation while destructive, broad, recursive, critical, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, goalLease, and allowed-root checks, including an explicitly absolute cwd outside the project; input validation, executable availability, Windows ACL/UAC, and child-process failures still apply. dry_run and task observation are non-mutating.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: shellCapabilitySchema,
      handler: async (input, signal, authorization) => execute('shell', input, signal, authorization),
    }),
    defineTool({
      name: 'dom_cdp',
      description: 'Default for web-page DOM work inside managed Chrome. Call list_tabs first, select the exact returned tab_id by URL/title, and pass that tab_id to every query, click, type, navigate, evaluate, wait, screenshot, close, or steps call. If no safe matching tab exists, call new_tab and use its returned ID. Target order and the OS-active tab are never ownership signals. Never navigate through the browser address bar with computer_use/accessibility/input_event. Protected ChatGPT tab mutations additionally require allow_protected_tab_action=true plus explicit user confirmation.',
      permission: 'READ',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: domCdpCapabilitySchema,
      handler: async (input, signal, authorization) => execute('dom_cdp', input, signal, authorization),
    }),
    defineTool({
      name: 'computer_use',
      description: 'Codex-style native Windows computer use for testing desktop apps. Take annotated screenshots, inspect semantic controls, and operate by semantic target, numbered visual mark, or explicit coordinates. Routes through Accessibility first and uses guarded pointer/keyboard input only when needed. Supports click, typing, keys, hotkeys, scroll, drag, pointer movement, and window activation. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: computerUseSchema,
      handler: async (input, signal, authorization) => computerUse.execute(input, signal, authorization),
    }),
    defineTool({
      name: 'accessibility',
      description: 'Semantic native Windows UI tool. Inspect UI trees and named controls, then click, focus, read or set values, select controls and menus, or manage a native element. Prefer shell for direct system work and dom_cdp for web pages.',
      permission: 'READ',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: accessibilityCapabilitySchema,
      handler: async (input, signal, authorization) => execute('accessibility', input, signal, authorization),
    }),
    defineTool({
      name: 'input_event',
      description: 'Low-level keyboard and pointer fallback. Use only when DOM/CDP and Accessibility cannot operate the target. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences. For web navigation, do not focus/type into a browser address bar; use dom_cdp list_tabs/new_tab plus an explicit tab_id.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: inputEventCapabilitySchema,
      handler: async (input, signal, authorization) => execute('input_event', input, signal, authorization),
    }),
    defineTool({
      name: 'vision',
      description: 'Visual and OCR fallback for content unavailable through DOM or Accessibility. Capture a display, window, or region, or run local Vision OCR. It never clicks or types.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: visionCapabilitySchema,
      handler: async (input, signal, authorization) => execute('vision', input, signal, authorization),
    }),
    defineTool({
      name: 'vision_annotated_capture',
      description: 'Capture a local Windows screen/region/window and return a short-lived Set-of-Marks observation with numbered bounds, a content hash, and an annotated PNG. This tool only observes; use ui_target_action for a separately gated action.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: visionAnnotatedCaptureSchema,
      handler: async (input, signal, authorization) => setOfMarks.capture(input, signal, authorization),
    }),
    defineTool({
      name: 'ui_target_action',
      description: 'Act on one mark from a current vision_annotated_capture observation. The observation ID, optional hash, TTL, workspace owner, and current Accessibility element are checked before the action is sent.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: uiTargetActionSchema,
      handler: async (input, signal, authorization) => setOfMarks.act(input, signal, authorization),
    }),
    defineTool({
      name: 'window',
      description: 'Direct native Windows window management. List, inspect, activate, move, resize, minimize, maximize, restore, or close windows without raw coordinates when a window operation is sufficient.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: windowCapabilitySchema,
      handler: async (input, signal, authorization) => execute('window', input, signal, authorization),
    }),
    defineTool({
      name: 'health',
      description: 'Diagnostics only. Check all lnwjud backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: healthCapabilitySchema,
      handler: async (input, signal, authorization) => execute('health', input, signal, authorization),
    }),
    defineTool({
      name: 'system_info',
      description: 'Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: systemInfoCapabilitySchema,
      handler: async (input, signal, authorization) => execute('system_info', input, signal, authorization),
    }),
    defineTool({
      name: 'notification',
      description: 'Show a Windows notification (toast when BurntToast is installed, balloon otherwise). Use to tell the user when a long task finishes.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: notificationCapabilitySchema,
      handler: async (input, signal, authorization) => execute('notification', input, signal, authorization),
    }),
    defineTool({
      name: 'file_dialog',
      description: 'Open a native Windows file open/save dialog and return the chosen path(s). The dialog does not read or write files itself; use the guarded file tools afterwards.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: fileDialogCapabilitySchema,
      handler: async (input, signal, authorization) => execute('file_dialog', input, signal, authorization),
    }),
    defineTool({
      name: 'clipboard',
      description: 'Read or write the Windows clipboard (text, or PNG image as base64). Use get_text/get_image to read and set_text to write.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: clipboardCapabilitySchema,
      handler: async (input, signal, authorization) => execute('clipboard', input, signal, authorization),
    }),
    defineTool({
      name: 'web_fetch',
      description: 'Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. In standard mode every POST, PUT, or DELETE requires explicit chat confirmation and host approval; trusted Full Bypass skips lnwjud approval. dry_run remains safe. Returns status, headers, and text or base64 body.',
      permission: 'READ',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: webFetchCapabilitySchema,
      handler: async (input, signal, authorization) => execute('web_fetch', input, signal, authorization),
    }),
    defineTool({
      name: 'audio',
      description: 'Record the microphone to a WAV file or play a local audio file through MCI. In standard mode recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. record is synchronous and limited to 600 seconds. Use stop to abort an ongoing record/play.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: audioCapabilitySchema,
      handler: async (input, signal, authorization) => execute('audio', input, signal, authorization),
    }),
    defineTool({
      name: 'screen_record',
      description: 'Record the screen to an MP4 using ffmpeg gdigrab (requires ffmpeg on PATH). In standard mode starting a recording requires the host-selected Active Project workspaceId and explicit confirmation; trusted Full Bypass skips lnwjud approval/scope checks. Existing in-workspace outputs use Recovery Trash before replacement when available. start spawns a background capture, status checks it, stop finalizes the file. Recording stops automatically after 3600 seconds.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: screenRecordCapabilitySchema,
      handler: async (input, signal, authorization) => execute('screen_record', input, signal, authorization),
    }),
    defineTool({
      name: 'office',
      description: 'Automate Excel, Word, PowerPoint, or Outlook through COM. In standard mode every write, replace, merge, or save_as action requires an Active Project workspaceId, explicit chat confirmation, and host approval. Trusted Full Bypass skips lnwjud approval/scope checks without forging userConfirmed. Existing in-workspace targets use Recovery Trash before replacement when available. Requires Microsoft Office installed.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: officeCapabilitySchema,
      handler: async (input, signal, authorization) => execute('office', input, signal, authorization),
    }),
    defineTool({
      name: 'scheduler',
      description: 'Manage Windows scheduled tasks with schtasks.exe. list is read-only; in standard mode create, run, and delete require explicit chat confirmation and host approval. Trusted Full Bypass skips lnwjud approval without forging userConfirmed.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: schedulerCapabilitySchema,
      handler: async (input, signal, authorization) => execute('scheduler', input, signal, authorization),
    }),
    defineTool({
      name: 'wsl_exec',
      description: 'Non-blocking WSL2 developer runner for one Linux executable plus argv; shell command strings are not accepted. Do not use wsl_exec as a source/config/text editor. For any direct text-file change, call edit_file first; use apply_patch for reviewed whole-file or multi-file replacements and write_file for file creation/replacement. Inline Node/Python/PowerShell-style rewrites and sed in-place edits are rejected before native approval so the client can route to guarded file tools. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, and return a task_id immediately. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). When the user requires babysitting until completion, keep using bounded waits and do not report completion until the terminal result is inspected. Otherwise, if the host turn must yield while a durable task is still running, checkpoint it as trackedTasks {taskId, provider: shell, role: blocking_job, cancelWithGoal: true} and use the active scheduled-continuation handoff instead of abandoning the goal. With Full Bypass OFF, Full Access runs ordinary WSL commands without confirmation while destructive, broad, recursive, outside-project, or unparseable forms retain normal approval/command policy. Trusted Full Bypass skips lnwjud approval, command-policy, Active Project, goalLease, and allowed-root checks, including an explicitly requested external cwd; WSL availability, argv validation, Linux permissions, and process failures still apply.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: wslCapabilitySchema,
      handler: async (input, signal, authorization) => execute('wsl_exec', input, signal, authorization),
    }),
    defineTool({
      name: 'wsl_fs',
      description: 'Translate paths and inspect metadata between a registered Windows workspace and WSL without exposing raw \\\\wsl$ read/write access.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: wslFilesystemCapabilitySchema,
      handler: async (input, signal, authorization) => execute('wsl_fs', input, signal, authorization),
    }),
  ];
}

interface PreparedOfficeMutation {
  readonly input: unknown;
  readonly replacementBackup?: { readonly recoveryId: string; readonly recoveryPath: string };
}

async function prepareMediaOutputMutation(
  context: McpToolContext,
  tool: 'audio' | 'screen_record',
  input: unknown,
  signal?: AbortSignal,
  authorization?: InvocationAuthorization,
): Promise<Result<PreparedOfficeMutation>> {
  if (!isRecord(input)) return err(appError('INVALID_INPUT', `${tool} input must be an object`));
  const action = typeof input.action === 'string' ? input.action : '';
  const writesOutput = (tool === 'audio' && action === 'record')
    || (tool === 'screen_record' && action === 'start');
  if (input.dry_run === true || !writesOutput) return ok({ input });

  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0
    ? input.workspaceId
    : undefined;
  const outputPath = typeof input.output_path === 'string' && input.output_path.trim().length > 0
    ? input.output_path
    : undefined;
  if (workspaceId === undefined) return err(appError('INVALID_INPUT', `${tool} output mutation requires workspaceId`));
  if (outputPath === undefined) return err(appError('INVALID_INPUT', `${tool} output mutation requires output_path`));
  if (context.services.file === undefined) {
    return err(appError('INTERNAL_ERROR', `File safety service is unavailable; refusing ${tool} output mutation`, true));
  }

  const prepared = await context.services.file.prepareExternalFileMutation(context.actor, workspaceId, {
    sourcePaths: [],
    targetPath: outputPath,
    userConfirmed: input.userConfirmed === true,
  }, signal, authorization);
  if (!prepared.ok) return prepared;
  return ok({
    input: { ...input, workspaceId, output_path: prepared.value.targetPath },
    ...(prepared.value.replacementBackup === undefined ? {} : { replacementBackup: prepared.value.replacementBackup }),
  });
}

async function prepareOfficeMutation(
  context: McpToolContext,
  input: unknown,
  signal?: AbortSignal,
  authorization?: InvocationAuthorization,
): Promise<Result<PreparedOfficeMutation>> {
  if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Office input must be an object'));
  const action = typeof input.action === 'string' ? input.action : '';
  if (input.dry_run === true || !['write', 'replace', 'save_as', 'merge'].includes(action)) return ok({ input });
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0
    ? input.workspaceId
    : undefined;
  if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'Mutating Office actions require workspaceId'));
  if (context.services.file === undefined) {
    return err(appError('INTERNAL_ERROR', 'File safety service is unavailable; refusing Office mutation', true));
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const targetPath = typeof input.target_path === 'string' ? input.target_path : undefined;
  let sourcePaths: readonly string[];
  let mutationTarget: string | undefined;
  if (action === 'write' || action === 'replace') {
    sourcePaths = [];
    mutationTarget = filePath;
  } else if (action === 'save_as') {
    sourcePaths = filePath === undefined ? [] : [filePath];
    mutationTarget = targetPath;
  } else {
    const mergePaths = Array.isArray(input.merge_paths)
      ? input.merge_paths.filter((entry): entry is string => typeof entry === 'string')
      : [];
    sourcePaths = filePath === undefined ? mergePaths : [filePath, ...mergePaths];
    mutationTarget = targetPath;
  }
  if (mutationTarget === undefined || (action !== 'write' && action !== 'replace' && sourcePaths.length === 0)) {
    return err(appError('INVALID_INPUT', `Office ${action} paths are incomplete`));
  }

  const prepared = await context.services.file.prepareExternalFileMutation(context.actor, workspaceId, {
    sourcePaths,
    targetPath: mutationTarget,
    userConfirmed: input.userConfirmed === true,
  }, signal, authorization);
  if (!prepared.ok) return prepared;
  const normalizedInput: Record<string, unknown> = { ...input, workspaceId };
  if (action === 'write' || action === 'replace') {
    normalizedInput.file_path = prepared.value.targetPath;
  } else {
    normalizedInput.file_path = prepared.value.sourcePaths[0];
    normalizedInput.target_path = prepared.value.targetPath;
    if (action === 'merge') normalizedInput.merge_paths = prepared.value.sourcePaths.slice(1);
  }
  return ok({
    input: normalizedInput,
    ...(prepared.value.replacementBackup === undefined ? {} : { replacementBackup: prepared.value.replacementBackup }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
