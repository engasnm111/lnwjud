$ErrorActionPreference = 'Stop'

function Get-Field {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Success {
  param([object]$Value)
  return [ordered]@{ ok = $true; value = $Value }
}

function Failure {
  param([string]$Code, [string]$Message, [bool]$Recoverable = $false)
  return [ordered]@{ ok = $false; error = [ordered]@{ code = $Code; message = $Message; recoverable = $Recoverable } }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class LnwjudNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public InputUnion Union; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int Dx; public int Dy; public uint MouseData; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public IntPtr ExtraInfo; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static List<Dictionary<string, object>> Windows()
    {
        var result = new List<Dictionary<string, object>>();
        EnumWindows((hWnd, extra) =>
        {
            if (!IsWindow(hWnd)) return true;
            // Skip owned popups; keep every top-level HWND (visible, minimized, or cloaked).
            if (GetWindow(hWnd, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
            var titleBuilder = new StringBuilder(512);
            GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
            var title = titleBuilder.ToString();
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            var processName = "";
            var processPath = "";
            try
            {
                var process = Process.GetProcessById((int)processId);
                processName = process.ProcessName;
                try { if (process.MainModule != null) processPath = process.MainModule.FileName; } catch { }
                process.Dispose();
            }
            catch { }
            // Drop empty shell noise (no title and no process name), keep everything else.
            if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(processName)) return true;
            var bounds = new Rect();
            GetWindowRect(hWnd, out bounds);
            var boundsValue = new Dictionary<string, object>();
            boundsValue.Add("x", bounds.Left);
            boundsValue.Add("y", bounds.Top);
            boundsValue.Add("width", bounds.Right - bounds.Left);
            boundsValue.Add("height", bounds.Bottom - bounds.Top);
            var record = new Dictionary<string, object>();
            record.Add("hwnd", hWnd.ToInt64());
            record.Add("title", string.IsNullOrWhiteSpace(title) ? processName : title);
            record.Add("process_id", (long)processId);
            record.Add("process_name", processName);
            record.Add("process_path", processPath);
            record.Add("visible", IsWindowVisible(hWnd));
            record.Add("minimized", IsIconic(hWnd));
            record.Add("bounds", boundsValue);
            result.Add(record);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void Key(ushort virtualKey, bool keyUp)
    {
        var input = new Input { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = virtualKey, Flags = keyUp ? 2u : 0u } } };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    public static void Unicode(ushort code, bool keyUp)
    {
        var input = new Input { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { ScanCode = code, Flags = (keyUp ? 2u : 0u) | 4u } } };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    public static void MouseButton(uint flags) { mouse_event(flags, 0, 0, 0, UIntPtr.Zero); }
    public static void MouseWheel(int delta, bool horizontal) { mouse_event(horizontal ? 0x1000u : 0x800u, 0, 0, delta, UIntPtr.Zero); }
}
'@

try { Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null } catch { }

function Resolve-Window {
  param([object]$Parameters)
  $windows = [LnwjudNative]::Windows()
  $handle = Get-Field $Parameters 'hwnd'
  if ($null -ne $handle) {
    $found = $windows | Where-Object { [int64]$_.hwnd -eq [int64]$handle } | Select-Object -First 1
    if ($null -ne $found) { return $found }
  }
  $title = Get-Field $Parameters 'title'
  $processName = Get-Field $Parameters 'process_name'
  $matches = $windows
  if ($title -is [string] -and $title.Length -gt 0) { $matches = $matches | Where-Object { $_.title -like "*$title*" } }
  if ($processName -is [string] -and $processName.Length -gt 0) { $matches = $matches | Where-Object { $_.process_name -ieq $processName } }
  return $matches | Select-Object -First 1
}

function Invoke-WindowAction {
  param([string]$Operation, [object]$Parameters)
  switch ($Operation) {
    'list' { return [ordered]@{ windows = @([LnwjudNative]::Windows()) } }
    'get_active' {
      $hwnd = [LnwjudNative]::GetForegroundWindow()
      $window = [LnwjudNative]::Windows() | Where-Object { [int64]$_.hwnd -eq $hwnd.ToInt64() } | Select-Object -First 1
      return [ordered]@{ window = $window }
    }
    'get_bounds' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; return $window.bounds }
    'get_display' {
      Add-Type -AssemblyName System.Windows.Forms
      $window = Resolve-Window $Parameters
      if ($null -eq $window) { throw 'Window not found' }
      $screen = [System.Windows.Forms.Screen]::FromHandle([IntPtr]([int64]$window.hwnd))
      return [ordered]@{ display_id = $screen.DeviceName; primary = $screen.Primary; bounds = [ordered]@{ x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height } }
    }
    'activate' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::SetForegroundWindow([IntPtr]([int64]$window.hwnd)); return [ordered]@{ activated = $true; window = $window } }
    'close' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::PostMessage([IntPtr]([int64]$window.hwnd), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); return [ordered]@{ closed = $true; hwnd = $window.hwnd } }
    'minimize' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::ShowWindow([IntPtr]([int64]$window.hwnd), 6); return [ordered]@{ minimized = $true; hwnd = $window.hwnd } }
    'maximize' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::ShowWindow([IntPtr]([int64]$window.hwnd), 3); return [ordered]@{ maximized = $true; hwnd = $window.hwnd } }
    'restore' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::ShowWindow([IntPtr]([int64]$window.hwnd), 9); return [ordered]@{ restored = $true; hwnd = $window.hwnd } }
    'move' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::MoveWindow([IntPtr]([int64]$window.hwnd), [int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y'), [int]$window.bounds.width, [int]$window.bounds.height, $true); return [ordered]@{ moved = $true; hwnd = $window.hwnd } }
    'resize' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::MoveWindow([IntPtr]([int64]$window.hwnd), [int]$window.bounds.x, [int]$window.bounds.y, [int](Get-Field $Parameters 'width'), [int](Get-Field $Parameters 'height'), $true); return [ordered]@{ resized = $true; hwnd = $window.hwnd } }
    'set_window_frame' { $window = Resolve-Window $Parameters; if ($null -eq $window) { throw 'Window not found' }; [void][LnwjudNative]::MoveWindow([IntPtr]([int64]$window.hwnd), [int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y'), [int](Get-Field $Parameters 'width'), [int](Get-Field $Parameters 'height'), $true); return [ordered]@{ framed = $true; hwnd = $window.hwnd } }
    default { throw "Unsupported window operation: $Operation" }
  }
}

function Load-UiAutomation {
  try { Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop; Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop; return $true } catch { return $false }
}

function Get-ElementRecord {
  param([object]$Element)
  $current = $Element.Current
  $rect = $current.BoundingRectangle
  return [ordered]@{ name = $current.Name; automation_id = $current.AutomationId; control_type = $current.ControlType.ProgrammaticName; class_name = $current.ClassName; enabled = $current.IsEnabled; offscreen = $current.IsOffscreen; bounds = [ordered]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height } }
}

function Get-UiRoot {
  param([object]$Parameters)
  $window = Resolve-Window $Parameters
  if ($null -eq $window) { throw 'Window not found' }
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$window.hwnd))
}

function Add-UiTree {
  param([object]$Element, [System.Collections.Generic.List[object]]$Items, [int]$Depth, [int]$MaxDepth, [int]$MaxItems)
  if ($Items.Count -ge $MaxItems) { return }
  $Items.Add([ordered]@{ depth = $Depth; element = Get-ElementRecord $Element })
  if ($Depth -ge $MaxDepth) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($Element)
  while ($null -ne $child -and $Items.Count -lt $MaxItems) {
    Add-UiTree $child $Items ($Depth + 1) $MaxDepth $MaxItems
    $child = $walker.GetNextSibling($child)
  }
}

function Find-UiElement {
  param([object]$Root, [object]$Parameters)
  $name = Get-Field $Parameters 'name'
  $automationId = Get-Field $Parameters 'automation_id'
  if ($name -is [string] -and $name.Length -gt 0) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $found = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $found) { return $found }
  }
  if ($automationId -is [string] -and $automationId.Length -gt 0) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId)
    $found = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $found) { return $found }
  }
  return $null
}

function Invoke-AccessibilityAction {
  param([string]$Action, [object]$Parameters)
  if ($Action -eq 'status') { return [ordered]@{ available = (Load-UiAutomation); backend = 'Microsoft UI Automation' } }
  if ($Action -eq 'list_windows') { return [ordered]@{ windows = @([LnwjudNative]::Windows()) } }
  if ($Action -eq 'launch_app') {
    $executable = Get-Field $Parameters 'executable'
    if ($executable -isnot [string] -or $executable.Length -eq 0) { throw 'Executable is required' }
    $arguments = Get-Field $Parameters 'arguments'
    if ($null -eq $arguments) { [void](Start-Process -FilePath $executable) } else { [void](Start-Process -FilePath $executable -ArgumentList @($arguments)) }
    return [ordered]@{ started = $true; executable = $executable }
  }
  if ($Action -eq 'activate_app') { return Invoke-WindowAction 'activate' $Parameters }
  if ($Action -in @('close_window', 'minimize_window', 'maximize_window', 'restore_window', 'set_window_frame')) { return Invoke-WindowAction ($Action -replace '_window', '') $Parameters }
  if (-not (Load-UiAutomation)) { throw 'Microsoft UI Automation is unavailable' }
  $root = Get-UiRoot $Parameters
  if ($Action -in @('observe', 'observe_summary', 'observe_changes', 'inspect_elements')) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $maxDepth = [int](Get-Field $Parameters 'max_depth'); if ($maxDepth -le 0) { $maxDepth = 4 }
    $maxItems = [int](Get-Field $Parameters 'max_items'); if ($maxItems -le 0) { $maxItems = 200 }
    Add-UiTree $root $items 0 $maxDepth $maxItems
    return [ordered]@{ elements = @($items); count = $items.Count }
  }
  $element = Find-UiElement $root $Parameters
  if ($null -eq $element) { throw 'UI element was not found' }
  switch ($Action) {
    'find_element' { return [ordered]@{ element = Get-ElementRecord $element } }
    'focus' { [void]$element.SetFocus(); return [ordered]@{ focused = $true; element = Get-ElementRecord $element } }
    'click' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); return [ordered]@{ clicked = $true; element = Get-ElementRecord $element } }
    'read_value' { try { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return [ordered]@{ value = $pattern.Current.Value } } catch { return [ordered]@{ value = $element.Current.Name } } }
    'set_value' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $pattern.SetValue([string](Get-Field $Parameters 'value')); return [ordered]@{ set = $true; value = [string](Get-Field $Parameters 'value') } }
    'select_item' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $pattern.Select(); return [ordered]@{ selected = $true; element = Get-ElementRecord $element } }
    'menu_select' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); return [ordered]@{ selected = $true; element = Get-ElementRecord $element } }
    default { throw "Unsupported accessibility action: $Action" }
  }
}

function Get-VirtualKey {
  param([object]$Key)
  if ($Key -is [int] -or $Key -is [long]) { return [uint16]$Key }
  $value = ([string]$Key).ToUpperInvariant()
  $named = @{ ENTER = 0x0D; ESC = 0x1B; ESCAPE = 0x1B; TAB = 0x09; BACKSPACE = 0x08; DELETE = 0x2E; HOME = 0x24; END = 0x23; LEFT = 0x25; UP = 0x26; RIGHT = 0x27; DOWN = 0x28; SHIFT = 0x10; CTRL = 0x11; CONTROL = 0x11; ALT = 0x12; WIN = 0x5B; SPACE = 0x20; F1 = 0x70; F2 = 0x71; F3 = 0x72; F4 = 0x73; F5 = 0x74; F6 = 0x75; F7 = 0x76; F8 = 0x77; F9 = 0x78; F10 = 0x79; F11 = 0x7A; F12 = 0x7B }
  if ($named.ContainsKey($value)) { return [uint16]$named[$value] }
  if ($value.Length -eq 1) { return [uint16][char]$value[0] }
  throw 'Unsupported key'
}

function Invoke-KeyPress {
  param([object]$Key)
  $code = Get-VirtualKey $Key
  [LnwjudNative]::Key($code, $false); [LnwjudNative]::Key($code, $true)
}

function Invoke-InputAction {
  param([string]$Operation, [object]$Parameters)
  switch ($Operation) {
    'type_text' { foreach ($character in [string](Get-Field $Parameters 'text')) { [LnwjudNative]::Unicode([uint16][char]$character, $false); [LnwjudNative]::Unicode([uint16][char]$character, $true) }; return [ordered]@{ typed = $true } }
    'paste_text' { foreach ($character in [string](Get-Field $Parameters 'text')) { [LnwjudNative]::Unicode([uint16][char]$character, $false); [LnwjudNative]::Unicode([uint16][char]$character, $true) }; return [ordered]@{ pasted = $true } }
    'press_key' { Invoke-KeyPress (Get-Field $Parameters 'key'); return [ordered]@{ pressed = $true } }
    'hotkey' { $keys = @(Get-Field $Parameters 'modifiers'); foreach ($key in $keys) { [LnwjudNative]::Key((Get-VirtualKey $key), $false) }; Invoke-KeyPress (Get-Field $Parameters 'key'); foreach ($key in ($keys | Select-Object -Reverse)) { [LnwjudNative]::Key((Get-VirtualKey $key), $true) }; return [ordered]@{ pressed = $true } }
    'key_down' { [LnwjudNative]::Key((Get-VirtualKey (Get-Field $Parameters 'key')), $false); return [ordered]@{ down = $true } }
    'key_up' { [LnwjudNative]::Key((Get-VirtualKey (Get-Field $Parameters 'key')), $true); return [ordered]@{ up = $true } }
    'mouse_move' { [void][LnwjudNative]::SetCursorPos([int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y')); return [ordered]@{ moved = $true } }
    'click' { [void][LnwjudNative]::SetCursorPos([int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y')); [LnwjudNative]::MouseButton(0x2); [LnwjudNative]::MouseButton(0x4); return [ordered]@{ clicked = $true } }
    'double_click' { [void][LnwjudNative]::SetCursorPos([int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y')); 1..2 | ForEach-Object { [LnwjudNative]::MouseButton(0x2); [LnwjudNative]::MouseButton(0x4); if ($_ -eq 1) { Start-Sleep -Milliseconds 40 } }; return [ordered]@{ clicked = $true; count = 2 } }
    'right_click' { [void][LnwjudNative]::SetCursorPos([int](Get-Field $Parameters 'x'), [int](Get-Field $Parameters 'y')); [LnwjudNative]::MouseButton(0x8); [LnwjudNative]::MouseButton(0x10); return [ordered]@{ clicked = $true; button = 'right' } }
    'button_down' { [LnwjudNative]::MouseButton(0x2); return [ordered]@{ down = $true } }
    'button_up' { [LnwjudNative]::MouseButton(0x4); return [ordered]@{ up = $true } }
    'scroll' { [LnwjudNative]::MouseWheel([int](Get-Field $Parameters 'delta_y'), $false); return [ordered]@{ scrolled = $true } }
    'drag' { $from = Get-Field $Parameters 'from'; $to = Get-Field $Parameters 'to'; [void][LnwjudNative]::SetCursorPos([int](Get-Field $from 'x'), [int](Get-Field $from 'y')); [LnwjudNative]::MouseButton(0x2); [void][LnwjudNative]::SetCursorPos([int](Get-Field $to 'x'), [int](Get-Field $to 'y')); [LnwjudNative]::MouseButton(0x4); return [ordered]@{ dragged = $true } }
    'release_all' { foreach ($key in @(0x10, 0x11, 0x12, 0x5B)) { [LnwjudNative]::Key([uint16]$key, $true) }; [LnwjudNative]::MouseButton(0x4); [LnwjudNative]::MouseButton(0x10); return [ordered]@{ released = $true } }
    'sequence' { $steps = @(Get-Field $Parameters 'steps'); if ($steps.Count -lt 1 -or $steps.Count -gt 100) { throw 'Input sequence requires 1 to 100 steps' }; $results = foreach ($step in $steps) { $stepParams = Get-Field $step 'parameters'; if ($null -eq $stepParams) { $stepParams = $step }; Invoke-InputAction ([string](Get-Field $step 'operation')) $stepParams }; return [ordered]@{ steps = @($results) } }
    default { throw "Unsupported input operation: $Operation" }
  }
}

function Invoke-VisionAction {
  param([string]$Action, [object]$Parameters)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if ($Action -eq 'ocr') { return [ordered]@{ available = $false; reason = 'A local Windows OCR runtime is not installed; use accessibility for semantic text.' } }
  $x = 0; $y = 0; $width = 0; $height = 0; $source = $Action
  if ($Action -eq 'capture_display') {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $displayId = Get-Field $Parameters 'display_id'
    $screen = if ($null -eq $displayId) { [System.Windows.Forms.Screen]::PrimaryScreen } else { $screens | Where-Object { $_.DeviceName -eq $displayId -or $_.DeviceName -like "*$displayId*" } | Select-Object -First 1 }
    if ($null -eq $screen) { throw 'Display not found' }
    $x = $screen.Bounds.X; $y = $screen.Bounds.Y; $width = $screen.Bounds.Width; $height = $screen.Bounds.Height
  } elseif ($Action -eq 'capture_region') {
    $region = Get-Field $Parameters 'region'; if ($null -eq $region) { throw 'Region is required' }
    $x = [int](Get-Field $region 'x'); $y = [int](Get-Field $region 'y'); $width = [int](Get-Field $region 'width'); $height = [int](Get-Field $region 'height')
  } elseif ($Action -eq 'capture_window') {
    $windowIndex = Get-Field $Parameters 'window_index'
    if ($windowIndex -is [int] -or $windowIndex -is [long]) {
      $windows = @([LnwjudNative]::Windows())
      if ([int]$windowIndex -lt 0 -or [int]$windowIndex -ge $windows.Count) { throw 'Window index is out of range' }
      $window = $windows[[int]$windowIndex]
    } else {
      $window = Resolve-Window (Get-Field $Parameters 'app')
    }
    if ($null -eq $window) { throw 'Window not found' }
    $x = [int]$window.bounds.x; $y = [int]$window.bounds.y; $width = [int]$window.bounds.width; $height = [int]$window.bounds.height
  } else { throw "Unsupported vision action: $Action" }
  if ($width -lt 1 -or $height -lt 1 -or $width -gt 10000 -or $height -gt 10000) { throw 'Capture bounds are invalid' }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
  if ($bytes.Length -gt 8MB) { throw 'Capture is too large' }
  return [ordered]@{ format = 'png'; mime_type = 'image/png'; data_base64 = [Convert]::ToBase64String($bytes); width = $width; height = $height; source = $source; backend = 'Win32/System.Drawing screen capture' }
}

function Invoke-SystemInfoAction {
  param([string]$Operation, [object]$Parameters)
  if ($Operation -eq '' -or $null -eq $Operation) { $Operation = 'all' }
  switch ($Operation) {
    'cpu' { $cpus = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue); return [ordered]@{ model = [string]$cpus[0].Name; cores = [int]$cpus[0].NumberOfCores; logical_processors = [int]$cpus[0].NumberOfLogicalProcessors; load_percent = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } }
    'memory' { $os = Get-CimInstance Win32_OperatingSystem; return [ordered]@{ total_bytes = [int64]$os.TotalVisibleMemorySize * 1KB; free_bytes = [int64]$os.FreePhysicalMemory * 1KB; used_percent = [int][Math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100) } }
    'disks' { return [ordered]@{ drives = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" | ForEach-Object { [ordered]@{ device = [string]$_.DeviceID; volume = [string]$_.VolumeName; filesystem = [string]$_.FileSystem; total_bytes = [int64]$_.Size; free_bytes = [int64]$_.FreeSpace } }) } }
    'battery' { $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $battery) { return [ordered]@{ present = $false } }; return [ordered]@{ present = $true; percent = [int]$battery.EstimatedChargeRemaining; status = [string]$battery.Status } }
    'uptime' { $os = Get-CimInstance Win32_OperatingSystem; return [ordered]@{ boot_time = [string]$os.LastBootUpTime; uptime_seconds = [int64][Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalSeconds) } }
    'os' { $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; return [ordered]@{ name = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber; architecture = [string]$os.OSArchitecture; computer_name = [string]$cs.Name; manufacturer = [string]$cs.Manufacturer; model = [string]$cs.Model } }
    'processes' { $topCount = Get-Field $Parameters 'top_count'; if ($null -eq $topCount) { $topCount = 10 }; if ([int]$topCount -lt 1 -or [int]$topCount -gt 50) { throw 'top_count must be from 1 to 50' }; $limit = [int]$topCount; return [ordered]@{ processes = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First $limit | ForEach-Object { $cpu = 0; try { $cpu = [int64][Math]::Round($_.TotalProcessorTime.TotalSeconds) } catch { }; [ordered]@{ name = [string]$_.ProcessName; pid = [int]$_.Id; memory_bytes = [int64]$_.WorkingSet64; cpu_time_seconds = $cpu } }) } }
    'all' {
      return [ordered]@{
        os = (Invoke-SystemInfoAction 'os' $null)
        cpu = (Invoke-SystemInfoAction 'cpu' $null)
        memory = (Invoke-SystemInfoAction 'memory' $null)
        disks = (Invoke-SystemInfoAction 'disks' $null)
        battery = (Invoke-SystemInfoAction 'battery' $null)
        uptime = (Invoke-SystemInfoAction 'uptime' $null)
        top_processes = (Invoke-SystemInfoAction 'processes' $Parameters)
      }
    }
    default { throw "Unsupported system_info operation: $Operation" }
  }
}

function Invoke-NotificationAction {
  param([string]$Action, [object]$Parameters)
  if ($Action -ne 'show') { throw "Unsupported notification action: $Action" }
  $title = [string](Get-Field $Parameters 'title')
  $message = [string](Get-Field $Parameters 'message')
  if ($title.Length -gt 120 -or $message.Length -gt 2000) { throw 'Notification text is too long' }
  $usedToast = $false
  if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
    try { New-BurntToastNotification -Text $title, $message -ErrorAction Stop | Out-Null; $usedToast = $true } catch { }
  }
  if (-not $usedToast) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $notify.Visible = $true
    $notify.ShowBalloonTip(5000, $title, $message, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Milliseconds 1200
    $notify.Dispose()
  }
  return [ordered]@{ shown = $true; toast = $usedToast }
}

function Invoke-FileDialogAction {
  param([string]$Action, [object]$Parameters)
  Add-Type -AssemblyName System.Windows.Forms
  $initialDirectory = Get-Field $Parameters 'initial_directory'
  $filter = Get-Field $Parameters 'filter'
  $multiSelect = Get-Field $Parameters 'multi_select'
  if ($Action -eq 'open') {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    if ($null -ne $initialDirectory -and (Test-Path $initialDirectory -PathType Container)) { $dialog.InitialDirectory = $initialDirectory }
    if ($null -ne $filter -and $filter -is [string]) { $dialog.Filter = $filter }
    if ($null -ne $multiSelect) { $dialog.Multiselect = [bool]$multiSelect }
    $result = $dialog.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return [ordered]@{ canceled = $true; paths = @() } }
    $paths = if ($dialog.Multiselect) { @($dialog.FileNames) } else { @($dialog.FileName) }
    return [ordered]@{ canceled = $false; paths = @($paths) }
  }
  if ($Action -eq 'save') {
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    if ($null -ne $initialDirectory -and (Test-Path $initialDirectory -PathType Container)) { $dialog.InitialDirectory = $initialDirectory }
    if ($null -ne $filter -and $filter -is [string]) { $dialog.Filter = $filter }
    $fileName = Get-Field $Parameters 'file_name'
    if ($null -ne $fileName -and $fileName -is [string] -and $fileName.Length -gt 0) { $dialog.FileName = $fileName }
    $result = $dialog.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return [ordered]@{ canceled = $true; path = $null } }
    return [ordered]@{ canceled = $false; path = [string]$dialog.FileName }
  }
  throw "Unsupported file_dialog action: $Action"
}

function Invoke-ClipboardAction {
  param([string]$Action, [object]$Parameters)
  Add-Type -AssemblyName System.Windows.Forms
  switch ($Action) {
    'get_text' { return [ordered]@{ text = [string][System.Windows.Forms.Clipboard]::GetText() } }
    'set_text' { $text = Get-Field $Parameters 'text'; if ($null -eq $text -or -not ($text -is [string]) -or $text.Length -gt 1000000) { throw 'Clipboard text must be a string of at most 1000000 characters' }; [System.Windows.Forms.Clipboard]::SetText($text); return [ordered]@{ set = $true; length = $text.Length } }
    'get_image' {
      Add-Type -AssemblyName System.Drawing
      if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return [ordered]@{ present = $false } }
      $bitmap = [System.Windows.Forms.Clipboard]::GetImage()
      try {
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        if ($bytes.Length -gt 16MB) { throw 'Clipboard image is too large' }
        return [ordered]@{ present = $true; format = 'png'; mime_type = 'image/png'; width = [int]$bitmap.Width; height = [int]$bitmap.Height; data_base64 = [Convert]::ToBase64String($bytes) }
      } finally { $bitmap.Dispose() }
    }
    default { throw "Unsupported clipboard action: $Action" }
  }
}

try {
  $raw = ($input | Out-String).Trim()
  $request = $raw | ConvertFrom-Json
  $capability = [string](Get-Field $request 'capability')
  $payload = Get-Field $request 'input'
  $parameters = Get-Field $payload 'parameters'; if ($null -eq $parameters) { $parameters = $payload }
  $value = switch ($capability) {
    'window' { Invoke-WindowAction ([string](Get-Field $payload 'operation')) $parameters }
    'accessibility' { Invoke-AccessibilityAction ([string](Get-Field $payload 'action')) $parameters }
    'input_event' { Invoke-InputAction ([string](Get-Field $payload 'operation')) $parameters }
    'vision' { Invoke-VisionAction ([string](Get-Field $payload 'action')) $payload }
    'system_info' { Invoke-SystemInfoAction ([string](Get-Field $payload 'operation')) $parameters }
    'notification' { Invoke-NotificationAction ([string](Get-Field $payload 'action')) $parameters }
    'file_dialog' { Invoke-FileDialogAction ([string](Get-Field $payload 'action')) $parameters }
    'clipboard' { Invoke-ClipboardAction ([string](Get-Field $payload 'action')) $parameters }
    default { throw 'Unsupported Windows capability' }
  }
  $result = Success $value
  Write-Output ($result | ConvertTo-Json -Compress -Depth 50)
} catch {
  Write-Output ((Failure 'INTERNAL_ERROR' 'Windows native capability failed' $true) | ConvertTo-Json -Compress -Depth 50)
}
