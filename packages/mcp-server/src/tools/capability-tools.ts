import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import type { Result } from '@lnwjud/domain';
import {
  accessibilityCapabilitySchema,
  domCdpCapabilitySchema,
  healthCapabilitySchema,
  inputEventCapabilitySchema,
  shellCapabilitySchema,
  visionCapabilitySchema,
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
  ];
}
