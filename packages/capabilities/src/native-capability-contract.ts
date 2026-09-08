import type { PortableNativeCapabilityName } from './native-capability-backend.js';

/**
 * The MCP schemas are the public boundary, but capability backends are also
 * called by Desktop, STDIO, and tests directly. Keep a second, small allowlist
 * at the native boundary so an unvalidated internal caller can never turn a
 * host operation into an arbitrary command channel.
 */
export const nativeCapabilityActions: Readonly<Record<PortableNativeCapabilityName, readonly string[]>> = Object.freeze({
  accessibility: Object.freeze([
    'status', 'launch_app', 'activate_app', 'list_windows', 'observe', 'observe_summary',
    'observe_changes', 'inspect_elements', 'find_element', 'click', 'focus', 'read_value',
    'set_value', 'select_item', 'menu_select', 'close_window', 'minimize_window',
    'maximize_window', 'restore_window', 'set_window_frame',
  ]),
  input_event: Object.freeze([
    'status', 'type_text', 'paste_text', 'press_key', 'hotkey', 'key_down', 'key_up',
    'mouse_move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'button_down',
    'button_up', 'release_all', 'sequence',
  ]),
  vision: Object.freeze(['status', 'capture_display', 'capture_region', 'capture_window', 'annotate', 'ocr']),
  window: Object.freeze(['status', 'list', 'get_active', 'get_bounds', 'get_display', 'activate', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize', 'set_window_frame']),
  audio: Object.freeze(['status', 'record', 'play', 'stop']),
  screen_record: Object.freeze(['status', 'start', 'stop']),
  office: Object.freeze(['status', 'read', 'read_text', 'sheets', 'list_folders', 'list_messages', 'write', 'replace', 'merge', 'save_as']),
});

export function isNativeCapabilityAction(
  capability: PortableNativeCapabilityName,
  action: string,
): boolean {
  return nativeCapabilityActions[capability].includes(action);
}
