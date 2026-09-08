import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('native provider source contract', () => {
  it('macOS helper uses permission-aware native APIs for the first provider slice', async () => {
    const macSources = [
      'main.swift', 'MacNativeProviders.swift', 'AccessibilityProvider.swift', 'WindowProvider.swift',
      'InputProvider.swift', 'ScreenCaptureProvider.swift', 'VisionOcrProvider.swift',
      'AudioProvider.swift', 'ScreenRecordingProvider.swift',
    ];
    const source = (await Promise.all(macSources.map((file) => readFile(
      path.join(root, 'native', 'macos-host', 'Sources', 'LnwjudMacHost', file), 'utf8',
    )))).join('\n');
    expect(source).toContain('AXIsProcessTrusted');
    expect(source).toContain('AXUIElementCreateSystemWide');
    expect(source).toContain('AXUIElementCopyAttributeValue');
    expect(source).toContain('AXUIElementSetMessagingTimeout');
    expect(source).toContain('CGWindowListCopyWindowInfo');
    expect(source).toContain('CGEvent');
    expect(source).toContain('CGPreflightScreenCaptureAccess');
    expect(source).toContain('AVCaptureDevice.authorizationStatus');
    expect(source).toContain('AXUIElementSetAttributeValue');
    expect(source).toContain('kAXPositionAttribute');
    expect(source).toContain('kAXSizeAttribute');
    expect(source).toContain('kAXCloseButtonAttribute');
    expect(source).toContain('kAXMinimizedAttribute');
    expect(source).toContain('kAXZoomButtonAttribute');
    expect(source).toContain('AXUIElementPerformAction');
    expect(source).toContain('kAXChildrenAttribute');
    expect(source).toContain('kAXIdentifierAttribute');
    expect(source).toContain('findElement');
    expect(source).toContain('maxItems');
    expect(source).toContain('observe_changes');
    expect(source).toContain('set_value');
    expect(source).toContain('select_item');
    expect(source).toMatch(/case "set_window_frame": mappedAction = "set_window_frame"/);
    expect(source).toContain('mime_type');
    expect(source).toMatch(/"accessibility": status\(/);
    expect(source).toMatch(/"input_event": status\(/);
    expect(source).toMatch(/"window": status\(/);
    expect(source).toContain('"annotate"');
    expect(source).toMatch(/value\(input, "window_index"\) != nil[\s\S]*guard let index = number\(input, "window_index"\)/);
    expect(source).toContain('let key = value(input, "window_id") != nil ? "window_id" : "hwnd"');
    expect(source).toContain('boundedInteger(input, "process_id"');
    // Foundation bridges JSON numeric 0/1 to NSNumber values that can also
    // satisfy `is Bool`. Reject the CFBoolean runtime type instead, preserving
    // zero coordinates, window index zero, keycode zero, and button one.
    expect(source).toContain('CFGetTypeID(number) != CFBooleanGetTypeID()');
    expect(source).toContain('CFGetTypeID(numeric) != CFBooleanGetTypeID()');
    expect(source).not.toMatch(/\braw\s+is\s+Bool\b/u);
    expect(source).toContain('guard let button = mouseButton(input) else { return invalidInput("Unsupported mouse button") }');
    expect(source).toContain('private static func mouseButton(_ input: [String: Any]) -> CGMouseButton?');
    expect(source).toContain('regionIntersectsKnownDisplay');
    expect(source).toContain('private static func virtualKey(_ input: [String: Any]) -> CGKeyCode?');
    expect(source).toContain('shared capability schema calls the native window handle `hwnd`');
    expect(source).toContain('value(input, "process_name")');
    expect(source).toContain('guard let selected = selectedWindow(input), let pid = selected.pid, pid > 0 else { return nil }');
    expect(source).toContain('numeric <= 127');
    expect(source).toContain('value >= 1');
    expect(source).toContain('value <= 3');
  });

  it('Linux helper reports the active desktop session and keeps Wayland scoped', async () => {
    const source = await readFile(path.join(root, 'native', 'linux-host', 'src', 'main.rs'), 'utf8');
    expect(source).toContain('XDG_SESSION_TYPE');
    expect(source).toContain('WAYLAND_DISPLAY');
    expect(source).toContain('DBUS_SESSION_BUS_ADDRESS');
    expect(source).toContain('AT_SPI_BUS_ADDRESS');
    expect(source).toContain('permission_required');
    expect(source).toContain('portal_session_required');
    const x11 = await readFile(path.join(root, 'native', 'linux-host', 'src', 'x11.rs'), 'utf8');
    expect(x11).toContain('input.contains_key("hwnd")');
    expect(x11).toContain('process_name_for_pid');
    expect(x11).toContain('X11 window activation could not be flushed');
  });

  it('Linux AT-SPI observation is bounded and uses argv-only gdbus calls', async () => {
    const atspi = await readFile(path.join(root, 'native', 'linux-host', 'src', 'atspi.rs'), 'utf8');
    expect(atspi).toContain('org.a11y.atspi.Accessible');
    expect(atspi).toContain('GetChildren');
    expect(atspi).toContain('AT_SPI_BUS_ADDRESS');
    expect(atspi).toContain('COMMAND_TIMEOUT');
    expect(atspi).toContain('MAX_COMMAND_OUTPUT_BYTES');
    expect(atspi).toContain('.env_clear()');
    expect(atspi).toContain('Command::new("gdbus")');
    expect(atspi).not.toContain('shell = true');
  });

  it('binds native-host manifests to regular canonical files before parsing them', async () => {
    const source = await readFile(path.join(root, 'apps', 'desktop', 'src', 'main', 'capability-runtime.ts'), 'utf8');
    expect(source).toContain('lstatSync');
    expect(source).toContain('realpathSync(manifestPath) !== manifestPath');
    expect(source).toContain('manifestStat.isSymbolicLink()');
  });

  it('strips credential-looking parent environment variables before native helper spawn', async () => {
    const source = await readFile(path.join(root, 'packages', 'capabilities', 'src', 'native-host-protocol.ts'), 'utf8');
    expect(source).toContain('env: sanitizedNativeHostEnvironment()');
    expect(source).toContain('api[_-]?key|token|password|secret');
  });

  it('keeps diagnostic child processes on the user service scope and sanitized environment', async () => {
    const source = await readFile(path.join(root, 'packages', 'mcp-server', 'src', 'upgrade-runtime.ts'), 'utf8');
    expect(source).toContain("['--user', 'list-unit-files'");
    expect(source).toContain("['--user', 'status', serviceName");
    expect(source).toContain('gui/${typeof process.getuid === \'function\' ? process.getuid() : 0}/${serviceName}');
    expect(source).toContain('env: sanitizedDiagnosticEnvironment()');
  });

  it('preserves POSIX desktop-session handles for regular child processes', async () => {
    const shell = await readFile(path.join(root, 'packages', 'capabilities', 'src', 'shell-backend.ts'), 'utf8');
    const processManager = await readFile(path.join(root, 'packages', 'process', 'src', 'process-manager.ts'), 'utf8');
    for (const source of [shell, processManager]) {
      expect(source).toContain("'DISPLAY'");
      expect(source).toContain("'WAYLAND_DISPLAY'");
      expect(source).toContain("'DBUS_SESSION_BUS_ADDRESS'");
      expect(source).toContain("'XDG_RUNTIME_DIR'");
      expect(source).toContain("'PIPEWIRE_REMOTE'");
    }
  });
});
