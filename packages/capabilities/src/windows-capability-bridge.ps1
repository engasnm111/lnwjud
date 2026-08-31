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
  $windows = @([LnwjudNative]::Windows())
  $windowIndex = Get-Field $Parameters 'window_index'
  if ($windowIndex -is [int] -or $windowIndex -is [long]) {
    $index = [int]$windowIndex
    if ($index -lt 0 -or $index -ge $windows.Count) { return $null }
    return $windows[$index]
  }
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
    'activate' {
      $window = Resolve-Window $Parameters
      if ($null -eq $window) { throw 'Window not found' }
      $hwnd = [IntPtr]([int64]$window.hwnd)
      if ([bool]$window.minimized) { [void][LnwjudNative]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 40 }
      $requested = [LnwjudNative]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 40
      $activated = ([LnwjudNative]::GetForegroundWindow().ToInt64() -eq $hwnd.ToInt64())
      if (-not $activated -and $requested) {
        Start-Sleep -Milliseconds 40
        [void][LnwjudNative]::SetForegroundWindow($hwnd)
        $activated = ([LnwjudNative]::GetForegroundWindow().ToInt64() -eq $hwnd.ToInt64())
      }
      $reason = if ($activated) { $null } else { 'Windows did not grant foreground activation' }
      return [ordered]@{ activated = $activated; requested = [bool]$requested; window = $window; reason = $reason }
    }
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

function Get-FiniteUiBounds {
  param([object]$Rect)
  if ($null -eq $Rect) { return $null }
  $x = [double]$Rect.X
  $y = [double]$Rect.Y
  $width = [double]$Rect.Width
  $height = [double]$Rect.Height
  foreach ($value in @($x, $y, $width, $height)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $null }
  }
  return [ordered]@{ x = $x; y = $y; width = $width; height = $height }
}

function Get-ElementRecord {
  param([object]$Element)
  $current = $Element.Current
  $rect = $current.BoundingRectangle
  $bounds = Get-FiniteUiBounds $rect
  $controlType = ''
  if ($null -ne $current.ControlType) { $controlType = [string]$current.ControlType.ProgrammaticName }
  return [ordered]@{ name = [string]$current.Name; automation_id = [string]$current.AutomationId; control_type = $controlType; class_name = [string]$current.ClassName; enabled = [bool]$current.IsEnabled; offscreen = [bool]$current.IsOffscreen; bounds = $bounds }
}

function Invoke-UiPointerClick {
  param([object]$Element)
  $current = $Element.Current
  if ([bool]$current.IsOffscreen) { throw 'UI element is off-screen' }
  $bounds = Get-FiniteUiBounds $current.BoundingRectangle
  if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) { throw 'UI element does not have clickable bounds' }
  $x = [int][Math]::Round($bounds.x + ($bounds.width / 2.0))
  $y = [int][Math]::Round($bounds.y + ($bounds.height / 2.0))
  if (-not [LnwjudNative]::SetCursorPos($x, $y)) { throw 'Pointer could not be moved to the UI element' }
  [LnwjudNative]::MouseButton(0x2)
  [LnwjudNative]::MouseButton(0x4)
  return [ordered]@{ x = $x; y = $y }
}

function Test-UiWindowSelector {
  param([object]$Parameters)
  if ($null -eq $Parameters) { return $false }
  foreach ($name in @('hwnd', 'title', 'process_name', 'window_index')) {
    $value = Get-Field $Parameters $name
    if ($null -ne $value) {
      if ($value -isnot [string] -or $value.Length -gt 0) { return $true }
    }
  }
  return $false
}

function Get-UiRoot {
  param([object]$Parameters)
  if (-not (Test-UiWindowSelector $Parameters)) {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
  $window = Resolve-Window $Parameters
  if ($null -eq $window) { throw 'Window not found' }
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$window.hwnd))
}

function Add-UiTree {
  param([object]$Element, [System.Collections.Generic.List[object]]$Items, [int]$Depth, [int]$MaxDepth, [int]$MaxItems)
  if ($null -eq $Element -or $Items.Count -ge $MaxItems) { return }
  try {
    $record = Get-ElementRecord $Element
    [void]$Items.Add([ordered]@{ depth = $Depth; element = $record })
  } catch {
    # UI Automation trees are live. A control can disappear between sibling
    # enumeration and property reads; skip only that stale element instead of
    # failing the entire observation.
  }
  if ($Depth -ge $MaxDepth -or $Items.Count -ge $MaxItems) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try { $child = $walker.GetFirstChild($Element) } catch { return }
  while ($null -ne $child -and $Items.Count -lt $MaxItems) {
    $currentChild = $child
    try { $child = $walker.GetNextSibling($currentChild) } catch { $child = $null }
    Add-UiTree $currentChild $Items ($Depth + 1) $MaxDepth $MaxItems
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
  if ($Action -eq 'set_window_frame') { return Invoke-WindowAction 'set_window_frame' $Parameters }
  if ($Action -in @('close_window', 'minimize_window', 'maximize_window', 'restore_window')) { return Invoke-WindowAction ($Action -replace '_window', '') $Parameters }
  if (-not (Load-UiAutomation)) { throw 'Microsoft UI Automation is unavailable' }
  $root = Get-UiRoot $Parameters
  if ($Action -in @('observe', 'observe_summary', 'observe_changes', 'inspect_elements')) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $maxDepthValue = Get-Field $Parameters 'max_depth'
    $maxDepth = if ($null -eq $maxDepthValue) { 4 } else { [Math]::Max(0, [int]$maxDepthValue) }
    $maxItemsValue = Get-Field $Parameters 'max_items'
    $maxItems = if ($null -eq $maxItemsValue -or [int]$maxItemsValue -le 0) { 200 } else { [int]$maxItemsValue }
    Add-UiTree $root $items 0 $maxDepth $maxItems
    # Windows PowerShell 5.1 throws "Argument types do not match" when the
    # array-subexpression operator wraps List[object]. ToArray() is stable on
    # both Windows 10 and Windows 11 and keeps the JSON shape deterministic.
    return [ordered]@{ elements = $items.ToArray(); count = $items.Count }
  }
  $element = Find-UiElement $root $Parameters
  if ($null -eq $element) { throw 'UI element was not found' }
  switch ($Action) {
    'find_element' { return [ordered]@{ element = Get-ElementRecord $element } }
    'focus' { [void]$element.SetFocus(); return [ordered]@{ focused = $true; element = Get-ElementRecord $element } }
    'click' {
      $method = 'invoke_pattern'
      try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
      } catch {
        [void](Invoke-UiPointerClick $element)
        $method = 'pointer_fallback'
      }
      return [ordered]@{ clicked = $true; method = $method; element = Get-ElementRecord $element }
    }
    'read_value' { try { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return [ordered]@{ value = $pattern.Current.Value } } catch { return [ordered]@{ value = $element.Current.Name } } }
    'set_value' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $pattern.SetValue([string](Get-Field $Parameters 'value')); return [ordered]@{ set = $true; value = [string](Get-Field $Parameters 'value') } }
    'select_item' {
      $method = 'selection_item_pattern'
      try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $pattern.Select()
      } catch {
        try {
          $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          $method = 'invoke_pattern'
        } catch {
          [void](Invoke-UiPointerClick $element)
          $method = 'pointer_fallback'
        }
      }
      return [ordered]@{ selected = $true; method = $method; element = Get-ElementRecord $element }
    }
    'menu_select' {
      $method = 'invoke_pattern'
      try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
      } catch {
        try {
          $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          $pattern.Select()
          $method = 'selection_item_pattern'
        } catch {
          [void](Invoke-UiPointerClick $element)
          $method = 'pointer_fallback'
        }
      }
      return [ordered]@{ selected = $true; method = $method; element = Get-ElementRecord $element }
    }
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
  if ($Action -eq 'annotate') {
    $encoded = Get-Field $Parameters 'image_base64'
    if ($encoded -isnot [string] -or $encoded.Length -eq 0) { throw 'image_base64 is required for annotation' }
    $bytes = [Convert]::FromBase64String($encoded)
    if ($bytes.Length -gt 16MB) { throw 'Annotation image is too large' }
    $inputStream = New-Object System.IO.MemoryStream(, $bytes)
    $bitmap = [System.Drawing.Bitmap]::FromStream($inputStream)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
    $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Yellow)
    $labelBackground = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 0, 0, 0))
    $font = New-Object System.Drawing.Font -ArgumentList @('Arial', 12, [System.Drawing.FontStyle]::Bold)
    foreach ($mark in @(Get-Field $Parameters 'marks')) {
      $bounds = Get-Field $mark 'bounds'
      if ($null -eq $bounds) { continue }
      $markId = [string](Get-Field $mark 'mark_id')
      $markX = [int](Get-Field $bounds 'x'); $markY = [int](Get-Field $bounds 'y')
      $markWidth = [int](Get-Field $bounds 'width'); $markHeight = [int](Get-Field $bounds 'height')
      if ($markWidth -lt 1 -or $markHeight -lt 1) { continue }
      $graphics.DrawRectangle($pen, $markX, $markY, $markWidth, $markHeight)
      $labelSize = $graphics.MeasureString($markId, $font)
      $labelRect = New-Object System.Drawing.RectangleF($markX, $markY, [Math]::Max($labelSize.Width + 8, 24), [Math]::Max($labelSize.Height + 4, 20))
      $graphics.FillRectangle($labelBackground, $labelRect)
      $graphics.DrawString($markId, $font, $labelBrush, $markX + 4, $markY + 2)
    }
    $outputStream = New-Object System.IO.MemoryStream
    $bitmap.Save($outputStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $outputBytes = $outputStream.ToArray()
    $outputWidth = [int]$bitmap.Width; $outputHeight = [int]$bitmap.Height
    $graphics.Dispose(); $pen.Dispose(); $labelBrush.Dispose(); $labelBackground.Dispose(); $font.Dispose(); $bitmap.Dispose(); $inputStream.Dispose(); $outputStream.Dispose()
    if ($outputBytes.Length -gt 16MB) { throw 'Annotated image is too large' }
    return [ordered]@{ format = 'png'; mime_type = 'image/png'; data_base64 = [Convert]::ToBase64String($outputBytes); width = $outputWidth; height = $outputHeight; annotated = $true; backend = 'Win32/System.Drawing Set-of-Marks overlay' }
  }
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
    if ([bool]$window.minimized) { throw 'Window is minimized; restore it before capture' }
    if (-not [bool]$window.visible) { throw 'Window is not visible; activate or restore it before capture' }
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
  return [ordered]@{ format = 'png'; mime_type = 'image/png'; data_base64 = [Convert]::ToBase64String($bytes); width = $width; height = $height; origin_x = $x; origin_y = $y; source = $source; backend = 'Win32/System.Drawing screen capture' }
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

$audioSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LnwjudAudio
{
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int mciSendString(string command, StringBuilder buffer, int bufferSize, IntPtr callback);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int mciGetErrorString(int errorCode, StringBuilder buffer, int bufferSize);

    public static void Mci(string command)
    {
        var buffer = new StringBuilder(512);
        int code = mciSendString(command, buffer, buffer.Capacity, IntPtr.Zero);
        if (code != 0)
        {
            var error = new StringBuilder(256);
            mciGetErrorString(code, error, error.Capacity);
            throw new InvalidOperationException("MCI command failed: " + error.ToString());
        }
    }
}
'@
try { Add-Type -TypeDefinition $audioSource -ErrorAction Stop | Out-Null } catch { }

function Invoke-AudioAction {
  param([string]$Action, [object]$Parameters)
  switch ($Action) {
    'record' {
      $path = [string](Get-Field $Parameters 'output_path')
      if ($path.Length -eq 0) { throw 'output_path is required' }
      $parent = Split-Path -Parent $path
      if (-not (Test-Path $parent -PathType Container)) { throw 'Output directory does not exist' }
      $duration = Get-Field $Parameters 'duration_seconds'; if ($null -eq $duration) { $duration = 10 }
      if ([int]$duration -lt 1 -or [int]$duration -gt 600) { throw 'duration_seconds must be from 1 to 600' }
      [LnwjudAudio]::Mci('open new type waveaudio alias lnwjudrec')
      [LnwjudAudio]::Mci('record lnwjudrec')
      Start-Sleep -Seconds ([int]$duration)
      [LnwjudAudio]::Mci('stop lnwjudrec')
      [LnwjudAudio]::Mci(('save lnwjudrec "' + $path + '"'))
      [LnwjudAudio]::Mci('close lnwjudrec')
      return [ordered]@{ recorded = $true; output_path = $path; duration_seconds = [int]$duration }
    }
    'play' {
      $path = [string](Get-Field $Parameters 'file_path')
      if ($path.Length -eq 0) { throw 'file_path is required' }
      if (-not (Test-Path $path -PathType Leaf)) { throw 'Audio file was not found' }
      $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
      $mciType = 'mpegvideo'
      if ($extension -eq '.wav') { $mciType = 'waveaudio' }
      elseif ($extension -eq '.mid' -or $extension -eq '.midi') { $mciType = 'sequencer' }
      [LnwjudAudio]::Mci(('open "' + $path + '" type ' + $mciType + ' alias lnwjudplay'))
      [LnwjudAudio]::Mci('play lnwjudplay wait')
      [LnwjudAudio]::Mci('close lnwjudplay')
      return [ordered]@{ played = $true; file_path = $path }
    }
    'stop' {
      foreach ($command in @('stop lnwjudrec', 'stop lnwjudplay', 'close lnwjudrec', 'close lnwjudplay')) {
        try { [LnwjudAudio]::Mci($command) } catch { }
      }
      return [ordered]@{ stopped = $true }
    }
    default { throw "Unsupported audio action: $Action" }
  }
}

function Invoke-ScreenRecordAction {
  param([string]$Action, [object]$Parameters)
  $statePath = Join-Path $env:TEMP 'lnwjud-screen-record-state.json'
  switch ($Action) {
    'start' {
      $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
      if ($null -eq $ffmpeg) { throw 'ffmpeg is not installed; install ffmpeg to use screen_record' }
      $out = [string](Get-Field $Parameters 'output_path')
      if ($out.Length -eq 0) { throw 'output_path is required' }
      $parent = Split-Path -Parent $out
      if (-not (Test-Path $parent -PathType Container)) { throw 'Output directory does not exist' }
      $x = Get-Field $Parameters 'offset_x'; if ($null -eq $x) { $x = 0 }
      $y = Get-Field $Parameters 'offset_y'; if ($null -eq $y) { $y = 0 }
      $w = Get-Field $Parameters 'width'; if ($null -eq $w) { $w = 1920 }
      $h = Get-Field $Parameters 'height'; if ($null -eq $h) { $h = 1080 }
      $fps = Get-Field $Parameters 'fps'; if ($null -eq $fps) { $fps = 10 }
      if ([int]$w -lt 1 -or [int]$h -lt 1 -or [int]$w -gt 7680 -or [int]$h -gt 4320) { throw 'Capture size is invalid' }
      if ([int]$fps -lt 1 -or [int]$fps -gt 60) { throw 'fps must be from 1 to 60' }
      $process = Start-Process -FilePath $ffmpeg -ArgumentList @('-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', [string][int]$fps, '-offset_x', [string][int]$x, '-offset_y', [string][int]$y, '-video_size', ([string][int]$w + 'x' + [string][int]$h), '-i', 'desktop', '-t', '3600', '-pix_fmt', 'yuv420p', $out) -WindowStyle Hidden -PassThru
      @{ pid = [int]$process.Id; output_path = $out; started_at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress | Set-Content $statePath
      return [ordered]@{ recording = $true; pid = [int]$process.Id; output_path = $out; max_duration_seconds = 3600 }
    }
    'stop' {
      if (-not (Test-Path $statePath)) { return [ordered]@{ recording = $false; reason = 'No active recording' } }
      $state = Get-Content $statePath -Raw | ConvertFrom-Json
      $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
      if ($null -ne $process) { Stop-Process -Id ([int]$state.pid) -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
      Remove-Item $statePath -Force -ErrorAction SilentlyContinue
      return [ordered]@{ recording = $false; output_path = [string]$state.output_path; exists = (Test-Path $state.output_path) }
    }
    'status' {
      if (-not (Test-Path $statePath)) { return [ordered]@{ recording = $false } }
      $state = Get-Content $statePath -Raw | ConvertFrom-Json
      $alive = $null -ne (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)
      return [ordered]@{ recording = $alive; pid = [int]$state.pid; output_path = [string]$state.output_path }
    }
    default { throw "Unsupported screen_record action: $Action" }
  }
}

function Release-ComObject {
  param([object]$Object)
  if ($null -eq $Object) { return }
  try {
    while ($true) {
      $refCount = [Runtime.InteropServices.Marshal]::ReleaseComObject($Object)
      if ($refCount -le 0) { break }
    }
  } catch { }
}

function Invoke-OfficeAction {
  param([string]$App, [string]$Action, [object]$Parameters)
  $filePath = [string](Get-Field $Parameters 'file_path')
  if ($App -eq 'excel') {
    $excel = $null
    try {
      $excel = New-Object -ComObject Excel.Application
      $excel.Visible = $false
      $excel.DisplayAlerts = $false
      switch ($Action) {
        'read' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Excel file was not found' }
          $workbook = $excel.Workbooks.Open($filePath)
          try {
            $sheetName = Get-Field $Parameters 'sheet'
            $range = [string](Get-Field $Parameters 'range')
            if ($range.Length -eq 0) { throw 'range is required (for example A1:D10)' }
            $worksheet = if ($null -eq $sheetName -or $sheetName.Length -eq 0) { $workbook.Worksheets.Item(1) } else { $workbook.Worksheets.Item($sheetName) }
            $values = $worksheet.Range($range).Value2
            return [ordered]@{ app = 'excel'; action = 'read'; file_path = $filePath; range = $range; values = @($values) }
          } finally { $workbook.Close($false) }
        }
        'write' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Excel file was not found' }
          $range = [string](Get-Field $Parameters 'range'); if ($range.Length -eq 0) { throw 'range is required' }
          $values = Get-Field $Parameters 'values'; if ($null -eq $values) { throw 'values is required' }
          $workbook = $excel.Workbooks.Open($filePath)
          try {
            $sheetName = Get-Field $Parameters 'sheet'
            $worksheet = if ($null -eq $sheetName -or $sheetName.Length -eq 0) { $workbook.Worksheets.Item(1) } else { $workbook.Worksheets.Item($sheetName) }
            $null = $worksheet.Range($range).Value2 = $values
            $workbook.Save()
            return [ordered]@{ app = 'excel'; action = 'write'; file_path = $filePath; range = $range; saved = $true }
          } finally { $workbook.Close($true) }
        }
        'save_as' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Excel file was not found' }
          $workbook = $excel.Workbooks.Open($filePath)
          try {
            $target = [string](Get-Field $Parameters 'target_path'); if ($target.Length -eq 0) { throw 'target_path is required' }
            $workbook.SaveAs($target)
            return [ordered]@{ app = 'excel'; action = 'save_as'; source = $filePath; target = $target; saved = $true }
          } finally { $workbook.Close($false) }
        }
        'sheets' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Excel file was not found' }
          $workbook = $excel.Workbooks.Open($filePath, 0, $true)
          try {
            $sheets = @()
            foreach ($worksheet in $workbook.Worksheets) {
              $used = $worksheet.UsedRange
              $sheets += [ordered]@{
                name = [string]$worksheet.Name
                used_range = [string]$used.Address($false, $false)
                rows = [int]$used.Rows.Count
                columns = [int]$used.Columns.Count
              }
            }
            return [ordered]@{ app = 'excel'; action = 'sheets'; file_path = $filePath; sheets = $sheets }
          } finally { $workbook.Close($false) }
        }
        default { throw "Unsupported excel action: $Action" }
      }
    } finally {
      if ($null -ne $excel) { try { $excel.Quit() } catch { }; Release-ComObject $excel }
    }
  }
  if ($App -eq 'word') {
    $word = $null
    try {
      $word = New-Object -ComObject Word.Application
      $word.Visible = $false
      switch ($Action) {
        'read_text' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Word file was not found' }
          $document = $word.Documents.Open($filePath, $false, $true)
          try { return [ordered]@{ app = 'word'; action = 'read_text'; file_path = $filePath; text = [string]$document.Content.Text } }
          finally { $document.Close($false) }
        }
        'replace' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Word file was not found' }
          $find = [string](Get-Field $Parameters 'find'); if ($find.Length -eq 0) { throw 'find is required' }
          $replaceWith = [string](Get-Field $Parameters 'replace_with')
          $document = $word.Documents.Open($filePath)
          try {
            $findObject = $document.Content.Find
            $found = $findObject.Execute($find, $false, $false, $false, $false, $false, $true, 1, $false, $replaceWith, 2)
            $document.Save()
            return [ordered]@{ app = 'word'; action = 'replace'; file_path = $filePath; replaced = [bool]$found; saved = $true }
          } finally { $document.Close($true) }
        }
        'save_as' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Word file was not found' }
          $document = $word.Documents.Open($filePath, $false, $true)
          try {
            $target = [string](Get-Field $Parameters 'target_path'); if ($target.Length -eq 0) { throw 'target_path is required' }
            $document.SaveAs($target)
            return [ordered]@{ app = 'word'; action = 'save_as'; source = $filePath; target = $target; saved = $true }
          } finally { $document.Close($false) }
        }
        'merge' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'Word file was not found' }
          $target = [string](Get-Field $Parameters 'target_path'); if ($target.Length -eq 0) { throw 'target_path is required' }
          $mergePaths = @(Get-Field $Parameters 'merge_paths')
          if ($mergePaths.Count -eq 0) { throw 'merge_paths is required' }
          $document = $word.Documents.Open($filePath)
          try {
            foreach ($mergePath in $mergePaths) {
              $source = [string]$mergePath
              if ($source.Length -eq 0) { continue }
              if (-not (Test-Path $source -PathType Leaf)) { throw "Merge source was not found: $source" }
              $endRange = $document.Content
              $endRange.Collapse(0)
              $endRange.InsertFile($source)
            }
            $document.SaveAs($target)
            return [ordered]@{ app = 'word'; action = 'merge'; source = $filePath; merged = @($mergePaths); target = $target; saved = $true }
          } finally { $document.Close($false) }
        }
        default { throw "Unsupported word action: $Action" }
      }
    } finally {
      if ($null -ne $word) { try { $word.Quit() } catch { }; Release-ComObject $word }
    }
  }
  if ($App -eq 'powerpoint') {
    $powerpoint = $null
    try {
      $powerpoint = New-Object -ComObject PowerPoint.Application
      switch ($Action) {
        'read' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'PowerPoint file was not found' }
          $presentation = $powerpoint.Presentations.Open($filePath, $true, $false, $false)
          try {
            $slides = @()
            $index = 0
            foreach ($slide in $presentation.Slides) {
              $index += 1
              $texts = @()
              foreach ($shape in $slide.Shapes) {
                if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
                  $texts += [string]$shape.TextFrame.TextRange.Text
                }
              }
              $slides += [ordered]@{ slide = $index; texts = $texts }
            }
            return [ordered]@{ app = 'powerpoint'; action = 'read'; file_path = $filePath; slide_count = $index; slides = $slides }
          } finally { $presentation.Close() }
        }
        'save_as' {
          if ($filePath.Length -eq 0) { throw 'file_path is required' }
          if (-not (Test-Path $filePath -PathType Leaf)) { throw 'PowerPoint file was not found' }
          $presentation = $powerpoint.Presentations.Open($filePath, $true, $false, $false)
          try {
            $target = [string](Get-Field $Parameters 'target_path'); if ($target.Length -eq 0) { throw 'target_path is required' }
            $presentation.SaveAs($target)
            return [ordered]@{ app = 'powerpoint'; action = 'save_as'; source = $filePath; target = $target; saved = $true }
          } finally { $presentation.Close() }
        }
        default { throw "Unsupported powerpoint action: $Action" }
      }
    } finally {
      if ($null -ne $powerpoint) { try { $powerpoint.Quit() } catch { }; Release-ComObject $powerpoint }
    }
  }
  if ($App -eq 'outlook') {
    # Read-only header access: subjects/senders/timestamps only. Message
    # bodies are intentionally never returned through this bridge. Outlook
    # is a single-instance COM server, so never call Quit() here: doing so can
    # close the user's already-open Outlook window.
    $outlook = $null
    $namespace = $null
    try {
      $outlook = New-Object -ComObject Outlook.Application
      $namespace = $outlook.GetNamespace('MAPI')
      switch ($Action) {
        'list_folders' {
          $folders = @()
          foreach ($store in $namespace.Folders) {
            foreach ($folder in $store.Folders) {
              $folders += [ordered]@{
                store = [string]$store.Name
                name = [string]$folder.Name
                path = [string]$folder.FolderPath
                item_count = [int]$folder.Items.Count
              }
            }
          }
          return [ordered]@{ app = 'outlook'; action = 'list_folders'; folders = $folders }
        }
        'list_messages' {
          $folderPath = [string](Get-Field $Parameters 'folder')
          $maxMessages = [int](Get-Field $Parameters 'max_messages')
          if ($maxMessages -le 0) { $maxMessages = 20 }
          if ($maxMessages -gt 100) { $maxMessages = 100 }
          $folder = $null
          if ($folderPath.Length -eq 0) {
            $folder = $namespace.GetDefaultFolder(6)
          } else {
            $segments = @($folderPath.Trim('\').Split('\') | Where-Object { $_.Length -gt 0 })
            if ($segments.Count -ge 2) {
              try {
                $folder = $namespace.Folders.Item([string]$segments[0])
                for ($index = 1; $index -lt $segments.Count; $index += 1) {
                  $folder = $folder.Folders.Item([string]$segments[$index])
                }
              } catch { $folder = $null }
            }
            if ($null -eq $folder -and $segments.Count -eq 1) {
              foreach ($store in $namespace.Folders) {
                try { $folder = $store.Folders.Item([string]$segments[0]); if ($null -ne $folder) { break } } catch { }
              }
            }
            if ($null -eq $folder) { throw "Outlook folder was not found: $folderPath" }
          }
          $items = $folder.Items
          $items.Sort('[ReceivedTime]', $true)
          $messages = @()
          $count = 0
          foreach ($item in $items) {
            if ($count -ge $maxMessages) { break }
            $count += 1
            $messages += [ordered]@{
              subject = [string]$item.Subject
              sender = [string]$item.SenderName
              received = try { $item.ReceivedTime.ToString('o') } catch { '' }
            }
          }
          return [ordered]@{ app = 'outlook'; action = 'list_messages'; folder = if ($folderPath.Length -eq 0) { 'Inbox' } else { $folderPath }; messages = $messages }
        }
        default { throw "Unsupported outlook action: $Action" }
      }
    } finally {
      if ($null -ne $namespace) { Release-ComObject $namespace }
      if ($null -ne $outlook) { Release-ComObject $outlook }
    }
  }
  throw "Unsupported office app: $App"
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
    'audio' { Invoke-AudioAction ([string](Get-Field $payload 'action')) $parameters }
    'screen_record' { Invoke-ScreenRecordAction ([string](Get-Field $payload 'action')) $parameters }
    'office' { Invoke-OfficeAction ([string](Get-Field $payload 'app')) ([string](Get-Field $payload 'action')) $parameters }
    default { throw 'Unsupported Windows capability' }
  }
  $result = Success $value
  Write-Output ($result | ConvertTo-Json -Compress -Depth 50)
} catch {
  $failureMessage = 'Windows native capability failed'
  try {
    $detail = [string]$_.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($detail)) {
      $detail = ($detail -replace '[\r\n]+', ' ').Trim()
      if ($detail.Length -gt 1000) { $detail = $detail.Substring(0, 1000) }
      $failureMessage = $failureMessage + ': ' + $detail
    }
  } catch { }
  Write-Output ((Failure 'INTERNAL_ERROR' $failureMessage $true) | ConvertTo-Json -Compress -Depth 50)
}
