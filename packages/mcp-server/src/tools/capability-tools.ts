import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import type { Result } from '@lnwjud/domain';
import {
  accessibilityCapabilitySchema,
  audioCapabilitySchema,
  clipboardCapabilitySchema,
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
  webFetchCapabilitySchema,
  windowCapabilitySchema,
} from './schemas.js';

export function capabilityTools(context: McpToolContext): McpToolDefinition[] {
  const execute = (tool: Parameters<NonNullable<McpToolContext['services']['capabilities']>['execute']>[0], input: unknown): Promise<Result<unknown>> => (
    context.services.capabilities === undefined
      ? Promise.resolve(missingService())
      : context.services.capabilities.execute(tool, input)
  );

  return [
    defineTool({
      name: 'shell',
      description: 'Default tool for system operations and CLI tasks. Use it first for apps, URLs, files, HTTP, processes, and developer commands. Foreground is best for short work; background returns a task_id for status, logs, wait, result, or cancel.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: shellCapabilitySchema,
      handler: async (input) => execute('shell', input),
    }),
    defineTool({
      name: 'dom_cdp',
      description: 'Default for web-page DOM work inside managed Chrome: inspect content, query selectors, click, type, navigate, evaluate JavaScript, wait, manage tabs, and capture screenshots. Use steps to batch related DOM actions in one call.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: domCdpCapabilitySchema,
      handler: async (input) => execute('dom_cdp', input),
    }),
    defineTool({
      name: 'accessibility',
      description: 'Semantic native Windows UI tool. Inspect UI trees and named controls, then click, focus, read or set values, select controls and menus, or manage a native element. Prefer shell for direct system work and dom_cdp for web pages.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: accessibilityCapabilitySchema,
      handler: async (input) => execute('accessibility', input),
    }),
    defineTool({
      name: 'input_event',
      description: 'Low-level keyboard and pointer fallback. Use only when DOM/CDP and Accessibility cannot operate the target. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: inputEventCapabilitySchema,
      handler: async (input) => execute('input_event', input),
    }),
    defineTool({
      name: 'vision',
      description: 'Visual and OCR fallback for content unavailable through DOM or Accessibility. Capture a display, window, or region, or run local Vision OCR. It never clicks or types.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: visionCapabilitySchema,
      handler: async (input) => execute('vision', input),
    }),
    defineTool({
      name: 'window',
      description: 'Direct native Windows window management. List, inspect, activate, move, resize, minimize, maximize, restore, or close windows without raw coordinates when a window operation is sufficient.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: windowCapabilitySchema,
      handler: async (input) => execute('window', input),
    }),
    defineTool({
      name: 'health',
      description: 'Diagnostics only. Check all lnwjud backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: healthCapabilitySchema,
      handler: async (input) => execute('health', input),
    }),
    defineTool({
      name: 'system_info',
      description: 'Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: systemInfoCapabilitySchema,
      handler: async (input) => execute('system_info', input),
    }),
    defineTool({
      name: 'notification',
      description: 'Show a Windows notification (toast when BurntToast is installed, balloon otherwise). Use to tell the user when a long task finishes.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: notificationCapabilitySchema,
      handler: async (input) => execute('notification', input),
    }),
    defineTool({
      name: 'file_dialog',
      description: 'Open a native Windows file open/save dialog and return the chosen path(s). The dialog does not read or write files itself; use the guarded file tools afterwards.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: fileDialogCapabilitySchema,
      handler: async (input) => execute('file_dialog', input),
    }),
    defineTool({
      name: 'clipboard',
      description: 'Read or write the Windows clipboard (text, or PNG image as base64). Use get_text/get_image to read and set_text to write.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: clipboardCapabilitySchema,
      handler: async (input) => execute('clipboard', input),
    }),
    defineTool({
      name: 'web_fetch',
      description: 'Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. Returns status, headers, and text or base64 body. Use for docs, APIs, and downloads.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: webFetchCapabilitySchema,
      handler: async (input) => execute('web_fetch', input),
    }),
    defineTool({
      name: 'audio',
      description: 'Record the microphone to a WAV file or play a local audio file through MCI. record is synchronous and limited to 600 seconds. Use stop to abort an ongoing record/play.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: audioCapabilitySchema,
      handler: async (input) => execute('audio', input),
    }),
    defineTool({
      name: 'screen_record',
      description: 'Record the screen to an MP4 using ffmpeg gdigrab (requires ffmpeg on PATH). start spawns a background capture, status checks it, stop finalizes the file. Recording stops automatically after 3600 seconds.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: screenRecordCapabilitySchema,
      handler: async (input) => execute('screen_record', input),
    }),
    defineTool({
      name: 'office',
      description: 'Automate Excel or Word through COM. excel: read/write cell ranges and save_as. word: read_text, find/replace, and save_as. Requires Microsoft Office installed.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: officeCapabilitySchema,
      handler: async (input) => execute('office', input),
    }),
    defineTool({
      name: 'scheduler',
      description: 'Manage Windows scheduled tasks with schtasks.exe. list enumerates tasks, create registers a new task, run starts one immediately, and delete removes one. Windows only.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: schedulerCapabilitySchema,
      handler: async (input) => execute('scheduler', input),
    }),
  ];
}
