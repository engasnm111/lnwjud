import AVFoundation
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO

enum MacNativeResult {
    case value([String: AnyEncodable])
    case failure(code: String, message: String, recoverable: Bool)
}

/// The first macOS provider slice deliberately stays small and explicit:
/// permission probes, window metadata, governed input, screen capture, and
/// OCR. Operations that need a longer-lived media/Office session remain
/// dependency-gated until their ownership and restart contracts are complete.
enum MacNativeProviders {
    private static let maxWindows = 256
    private static let maxMarks = 500
    private static let maxTextBytes = 64 * 1024
    private static let maxImageBytes = 8 * 1024 * 1024
    private static let maxImageDimension = 16_384
    private static let maxImagePixels: Int64 = 64_000_000
    private static let maxWindowCoordinate = 1_000_000.0
    private static let maxWindowDimension = 16_384.0
    private static let visionActions = ["status", "capture_display", "capture_region", "capture_window", "ocr", "annotate"]
    private static let accessibilityActions = [
        "status", "launch_app", "activate_app", "list_windows", "observe", "observe_summary", "observe_changes",
        "inspect_elements", "find_element", "click", "focus", "read_value", "set_value", "select_item", "menu_select",
        "close_window", "minimize_window", "maximize_window", "restore_window", "set_window_frame",
    ]
    private static let inputActions = ["status", "type_text", "paste_text", "press_key", "hotkey", "mouse_move", "click", "double_click", "right_click", "scroll", "drag", "button_down", "button_up", "key_down", "key_up", "release_all"]

    private struct WindowRect: Encodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    private struct WindowRecord: Encodable {
        let id: Int
        let pid: Int?
        let app: String?
        let title: String?
        let bounds: WindowRect?
    }

    static func health() -> [String: AnyEncodable] {
        let trusted = MacAccessibilityProvider.isTrusted()
        let semanticReady = MacAccessibilityProvider.semanticProbe()
        let screenPermission = MacScreenRecordingProvider.permissionGranted()
        let windowReady = windowInfo() != nil
        let officeInstalled = officeApplicationURL() != nil

        return [
            "platform": AnyEncodable("darwin"),
            "backend": AnyEncodable("macos-native-host"),
            "available": AnyEncodable(true),
            "ready": AnyEncodable(true),
            "capabilities": AnyEncodable([
                "accessibility": status(
                    available: true,
                    ready: semanticReady,
                    reason: semanticReady ? nil : trusted ? "dependency_missing" : "permission_required",
                    supportedActions: accessibilityActions
                ),
                "input_event": status(
                    available: true,
                    ready: trusted,
                    reason: trusted ? nil : "permission_required",
                    supportedActions: inputActions
                ),
                "vision": status(
                    available: true,
                    ready: screenPermission,
                    reason: screenPermission ? nil : "permission_required",
                    supportedActions: visionActions
                ),
                "window": status(
                    available: windowReady,
                    ready: windowReady && trusted,
                    reason: !windowReady ? "dependency_missing" : trusted ? nil : "permission_required",
                    supportedActions: ["status", "list", "get_active", "get_bounds", "get_display", "activate", "close", "minimize", "maximize", "restore", "move", "resize", "set_window_frame"]
                ),
                "audio": status(
                    available: true,
                    ready: false,
                    reason: "provider_not_implemented",
                    supportedActions: ["status", "record", "play", "stop"]
                ),
                "screen_record": status(
                    available: true,
                    ready: false,
                    reason: "provider_not_implemented",
                    supportedActions: ["status", "start", "stop"]
                ),
                "office": status(
                    available: officeInstalled,
                    ready: false,
                    reason: officeInstalled ? "provider_not_implemented" : "dependency_missing",
                    supportedActions: ["status", "read", "read_text", "sheets", "list_folders", "list_messages", "write", "replace", "merge", "save_as"]
                )
            ] as [String: AnyEncodable])
        ]
    }

    static func execute(operation: String, input: [String: Any]) -> MacNativeResult {
        let action = string(input, "action") ?? string(input, "operation") ?? "status"
        switch operation {
        case "accessibility": return accessibility(action: action, input: input)
        case "input_event": return inputEvent(action: action, input: input)
        case "vision": return vision(action: action, input: input)
        case "window": return window(action: action, input: input)
        case "audio": return audio(action: action)
        case "screen_record": return screenRecord(action: action)
        case "office": return office(action: action)
        default:
            return .failure(code: "INVALID_INPUT", message: "Native host operation is not supported", recoverable: false)
        }
    }

    private static func accessibility(action: String, input: [String: Any]) -> MacNativeResult {
        guard accessibilityActions.contains(action) else { return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS Accessibility action \(action) is not implemented in this provider slice", recoverable: true) }
        if action == "status" {
            let trusted = MacAccessibilityProvider.isTrusted()
            let semanticReady = MacAccessibilityProvider.semanticProbe()
            return .value(status(available: true, ready: semanticReady, reason: semanticReady ? nil : trusted ? "dependency_missing" : "permission_required", supportedActions: accessibilityActions))
        }
        if action == "list_windows" { return windowList() }
        if action == "launch_app" { return launchApp(input) }
        if action == "activate_app" { return activateWindow(input) }
        if ["close_window", "minimize_window", "maximize_window", "restore_window", "set_window_frame"].contains(action) {
            let mappedAction: String
            switch action {
            case "close_window": mappedAction = "close"
            case "minimize_window": mappedAction = "minimize"
            case "maximize_window": mappedAction = "maximize"
            case "restore_window": mappedAction = "restore"
            case "set_window_frame": mappedAction = "set_window_frame"
            default: mappedAction = action
            }
            return mutateWindow(action: mappedAction, input: input)
        }
        guard MacAccessibilityProvider.isTrusted() else { return permissionFailure("Accessibility permission is required") }
        guard let selection = accessibilitySelection(input), NSRunningApplication(processIdentifier: selection.pid) != nil else {
            return .failure(code: "FILE_NOT_FOUND", message: "The requested macOS application was not found", recoverable: true)
        }
        let pid = selection.pid
        if ["observe", "observe_summary", "observe_changes", "inspect_elements"].contains(action) {
            let maxDepth = boundedAccessibilityDepth(input, key: "max_depth")
            let maxItems = boundedAccessibilityItems(input, key: "max_items")
            if maxDepth == nil || maxItems == nil { return invalidInput("macOS Accessibility observation bounds are invalid") }
            switch MacAccessibilityProvider.observe(pid: pid, windowTarget: selection.window, maxDepth: maxDepth ?? 6, maxItems: maxItems ?? 500) {
            case let .value(value): return .value(value)
            case .permissionRequired: return permissionFailure("Accessibility permission is required")
            case .unavailable: return dependencyFailure("The selected macOS application did not expose an Accessibility tree")
            case .invalid: return invalidInput("macOS Accessibility observation target is invalid")
            case .applied: return .failure(code: "INTERNAL_ERROR", message: "Unexpected Accessibility observation result", recoverable: true)
            }
        }
        let name = string(input, "name") ?? string(input, "title")
        let automationID = string(input, "automation_id")
        let role = string(input, "role")
        let maxDepth = boundedAccessibilityDepth(input, key: "max_depth")
        let maxItems = boundedAccessibilityItems(input, key: "max_items")
        if maxDepth == nil || maxItems == nil { return invalidInput("macOS Accessibility query bounds are invalid") }
        if action == "find_element" {
            switch MacAccessibilityProvider.find(pid: pid, windowTarget: selection.window, name: name, automationID: automationID, role: role, maxDepth: maxDepth ?? 8, maxItems: maxItems ?? 500) {
            case let .value(value): return .value(value)
            case .permissionRequired: return permissionFailure("Accessibility permission is required")
            case .unavailable: return .failure(code: "FILE_NOT_FOUND", message: "The requested semantic element was not found", recoverable: true)
            case .invalid: return invalidInput("macOS Accessibility query requires a semantic target")
            case .applied: return .failure(code: "INTERNAL_ERROR", message: "Unexpected Accessibility query result", recoverable: true)
            }
        }
        return accessibilityActionResult(MacAccessibilityProvider.perform(
            pid: pid,
            windowTarget: selection.window,
            action: action,
            name: name,
            automationID: automationID,
            role: role,
            value: payloadString(input, "value", maxBytes: maxTextBytes),
            maxDepth: maxDepth ?? 8,
            maxItems: maxItems ?? 500
        ), action: action, pid: pid)
    }

    static func accessibilityActionResult(_ result: MacAccessibilityResult, action: String, pid: pid_t) -> MacNativeResult {
        switch result {
        case .applied: return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "action": AnyEncodable(action), "pid": AnyEncodable(Int(pid)), "dispatched": AnyEncodable(true)])
        case .permissionRequired: return permissionFailure("Accessibility permission is required")
        case .unavailable: return dependencyFailure("The selected semantic element does not expose this Accessibility action")
        case .invalid: return invalidInput("macOS Accessibility action requires a valid semantic target/value")
        case let .value(value): return .value(value)
        }
    }

    private static func window(action: String, input: [String: Any]) -> MacNativeResult {
        switch action {
        case "status":
            let ready = windowInfo() != nil
            let trusted = MacAccessibilityProvider.isTrusted()
            return .value(status(available: ready, ready: ready && trusted, reason: !ready ? "dependency_missing" : trusted ? nil : "permission_required", supportedActions: ["status", "list", "get_active", "get_bounds", "get_display", "activate", "close", "minimize", "maximize", "restore", "move", "resize", "set_window_frame"]))
        case "list": return windowList()
        case "get_active": return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "window": AnyEncodable(activeWindow())])
        case "get_display": return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "displays": AnyEncodable(displayList())])
        case "get_bounds":
            guard let selected = selectedWindow(input), let bounds = selected.bounds else { return .failure(code: "FILE_NOT_FOUND", message: "The requested macOS window was not found", recoverable: true) }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "bounds": AnyEncodable(bounds)])
        case "activate":
            return activateWindow(input)
        case "close", "minimize", "maximize", "restore", "move", "resize", "set_window_frame":
            return mutateWindow(action: action, input: input)
        default:
            return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS window action \(action) is not implemented in this provider slice", recoverable: true)
        }
    }

    private static func mutateWindow(action: String, input: [String: Any]) -> MacNativeResult {
        guard let selection = accessibilitySelection(input), NSRunningApplication(processIdentifier: selection.pid) != nil else {
            return .failure(code: "FILE_NOT_FOUND", message: "The requested macOS application was not found", recoverable: true)
        }
        let pid = selection.pid
        let x = optionalWindowCoordinate(input, "x")
        let y = optionalWindowCoordinate(input, "y")
        let width = optionalWindowDimension(input, "width")
        let height = optionalWindowDimension(input, "height")
        let numericInputIsValid = (!hasValue(input, "x") || x != nil)
            && (!hasValue(input, "y") || y != nil)
            && (!hasValue(input, "width") || width != nil)
            && (!hasValue(input, "height") || height != nil)
        guard numericInputIsValid else { return invalidInput("macOS window coordinates or dimensions are invalid") }
        if ["move", "set_window_frame"].contains(action), x == nil || y == nil {
            return invalidInput("macOS window move requires finite x and y coordinates")
        }
        if ["resize", "set_window_frame"].contains(action), width == nil || height == nil {
            return invalidInput("macOS window resize requires positive width and height")
        }
        switch MacAccessibilityProvider.mutateWindow(pid: pid, windowTarget: selection.window, action: action, x: x, y: y, width: width, height: height) {
        case .applied:
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "window_action": AnyEncodable(action), "pid": AnyEncodable(Int(pid)), "dispatched": AnyEncodable(true)])
        case .permissionRequired:
            return permissionFailure("Accessibility permission is required for macOS window actions")
        case .unavailable:
            return dependencyFailure("The selected macOS window does not expose this Accessibility action")
        }
    }

    private static func activateWindow(_ input: [String: Any]) -> MacNativeResult {
        guard let selection = accessibilitySelection(input), let application = NSRunningApplication(processIdentifier: selection.pid) else {
            return .failure(code: "FILE_NOT_FOUND", message: "The requested macOS application was not found", recoverable: true)
        }
        let pid = selection.pid
        if selection.window != nil {
            guard MacAccessibilityProvider.isTrusted() else { return permissionFailure("Accessibility permission is required to activate a selected window") }
            guard let window = MacAccessibilityProvider.selectedWindow(for: pid, target: selection.window),
                  AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { return dependencyFailure("The selected macOS window could not be activated") }
        }
        let activated = application.activate(options: [.activateIgnoringOtherApps])
        return .value(["available": AnyEncodable(true), "ready": AnyEncodable(activated), "activated": AnyEncodable(activated), "pid": AnyEncodable(Int(pid))])
    }

    private static func launchApp(_ input: [String: Any]) -> MacNativeResult {
        guard let executable = string(input, "executable"), !executable.isEmpty else {
            return invalidInput("macOS Accessibility launch_app requires an executable path")
        }
        let url = URL(fileURLWithPath: executable)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .failure(code: "FILE_NOT_FOUND", message: "The requested macOS application was not found", recoverable: true)
        }
        do {
            // The native host is intentionally synchronous (one NDJSON request
            // produces one response). Use the synchronous AppKit launch API so
            // a completion handler cannot outlive the request/response pair.
            let application = try NSWorkspace.shared.launchApplication(at: url, options: [], configuration: [:])
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "launched": AnyEncodable(true), "pid": AnyEncodable(Int(application.processIdentifier))])
        } catch {
            return dependencyFailure("The macOS application could not be launched")
        }
    }

    private static func inputEvent(action: String, input: [String: Any]) -> MacNativeResult {
        guard inputActions.contains(action) else { return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS input action \(action) is not implemented in this provider slice", recoverable: true) }
        guard action == "status" || MacAccessibilityProvider.isTrusted() else { return permissionFailure("Accessibility permission is required for macOS input") }
        if action == "status" { return .value(status(available: true, ready: MacAccessibilityProvider.isTrusted(), reason: MacAccessibilityProvider.isTrusted() ? nil : "permission_required", supportedActions: inputActions)) }
        if action == "release_all" { return releaseAll() }

        switch action {
        case "mouse_move", "click", "double_click", "right_click":
            guard let point = point(input, "x", "y"), isOnKnownDisplay(point) else { return invalidInput("Input coordinates are outside the current display geometry") }
            guard let source = CGEventSource(stateID: .combinedSessionState) else { return dependencyFailure("macOS event source is unavailable") }
            let button: CGMouseButton = action == "right_click" ? .right : .left
            let downType: CGEventType = action == "mouse_move" ? .mouseMoved : .leftMouseDown
            let upType: CGEventType = action == "mouse_move" ? .mouseMoved : .leftMouseUp
            if action == "right_click" {
                guard let down = CGEvent(mouseEventSource: source, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: button), let up = CGEvent(mouseEventSource: source, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: button) else { return dependencyFailure("macOS mouse event could not be created") }
                MacInputProvider.post(down); MacInputProvider.post(up)
            } else if let move = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button) {
                if action != "mouse_move" { move.setIntegerValueField(.mouseEventClickState, value: 1) }
                MacInputProvider.post(move)
                if action != "mouse_move", let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button) {
                    up.setIntegerValueField(.mouseEventClickState, value: 1)
                    MacInputProvider.post(up)
                    if action == "double_click" {
                        usleep(50_000)
                        move.setIntegerValueField(.mouseEventClickState, value: 2)
                        up.setIntegerValueField(.mouseEventClickState, value: 2)
                        MacInputProvider.post(move); MacInputProvider.post(up)
                    }
                }
            } else { return dependencyFailure("macOS mouse event could not be created") }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true), "x": AnyEncodable(point.x), "y": AnyEncodable(point.y)])
        case "scroll":
            guard let delta = number(input, "delta_y"), delta.isFinite else { return invalidInput("Scroll delta must be finite") }
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(max(-120_000, min(120_000, delta))), wheel2: 0, wheel3: 0) else { return dependencyFailure("macOS scroll event could not be created") }
            MacInputProvider.post(event)
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true)])
        case "button_down", "button_up":
            guard let point = point(input, "x", "y"), isOnKnownDisplay(point) else { return invalidInput("Input coordinates are outside the current display geometry") }
            guard let button = mouseButton(input) else { return invalidInput("Unsupported mouse button") }
            guard let source = CGEventSource(stateID: .combinedSessionState) else { return dependencyFailure("macOS event source is unavailable") }
            let mouseType: CGEventType = action == "button_down"
                ? (button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown)
                : (button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp)
            guard let event = CGEvent(mouseEventSource: source, mouseType: mouseType, mouseCursorPosition: point, mouseButton: button) else { return dependencyFailure("macOS mouse event could not be created") }
            MacInputProvider.post(event)
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true), "x": AnyEncodable(point.x), "y": AnyEncodable(point.y)])
        case "drag":
            guard let from = point(input, "from.x", "from.y"), let to = point(input, "to.x", "to.y"), isOnKnownDisplay(from), isOnKnownDisplay(to) else { return invalidInput("Drag coordinates are outside the current display geometry") }
            guard let source = CGEventSource(stateID: .combinedSessionState), let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left), let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left), let dragged = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: to, mouseButton: .left), let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) else { return dependencyFailure("macOS drag event could not be created") }
            MacInputProvider.post(move); MacInputProvider.post(down); MacInputProvider.post(dragged); MacInputProvider.post(up)
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true), "from": AnyEncodable(["x": from.x, "y": from.y]), "to": AnyEncodable(["x": to.x, "y": to.y])])
        case "type_text", "paste_text":
            guard let text = payloadString(input, "text", maxBytes: maxTextBytes), !text.isEmpty else { return invalidInput("Input text is missing or too large") }
            guard let events = MacInputProvider.textEvents(text) else { return dependencyFailure("macOS keyboard events could not be created") }
            for event in events { MacInputProvider.post(event) }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true), "characters": AnyEncodable(text.count)])
        case "press_key", "key_down", "key_up", "hotkey":
            guard let virtualKey = virtualKey(input) else { return invalidInput("Unsupported macOS key") }
            let keyDown = action != "key_up"
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: keyDown) else { return dependencyFailure("macOS keyboard event could not be created") }
            event.flags = flags(input)
            MacInputProvider.post(event)
            if action == "press_key" || action == "hotkey", let up = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) {
                up.flags = event.flags
                MacInputProvider.post(up)
            }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "dispatched": AnyEncodable(true)])
        default:
            return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS input action \(action) is not implemented in this provider slice", recoverable: true)
        }
    }

    private static func vision(action: String, input: [String: Any]) -> MacNativeResult {
        guard visionActions.contains(action) else { return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS vision action \(action) is not implemented in this provider slice", recoverable: true) }
        if action == "status" {
            let ready = MacScreenRecordingProvider.permissionGranted()
            return .value(status(available: true, ready: ready, reason: ready ? nil : "permission_required", supportedActions: visionActions))
        }
        if action == "annotate" {
            if let rawMarks = value(input, "marks") {
                guard let marks = rawMarks as? [[String: Any]], marks.count <= maxMarks else { return invalidInput("vision annotate marks are invalid or too large") }
            }
            guard let image = decodedImage(input) else { return invalidInput("vision annotate requires a valid bounded image_base64 payload") }
            guard let annotated = annotate(image, input: input) else { return dependencyFailure("macOS image annotation could not be created") }
            guard let encoded = pngData(annotated), encoded.count <= maxImageBytes else { return .failure(code: "FILE_TOO_LARGE", message: "macOS annotated capture exceeds the image limit", recoverable: true) }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "format": AnyEncodable("png"), "mime_type": AnyEncodable("image/png"), "data_base64": AnyEncodable(encoded.base64EncodedString()), "width": AnyEncodable(annotated.width), "height": AnyEncodable(annotated.height), "annotated": AnyEncodable(true)])
        }
        let suppliedImage: CGImage?
        if action == "ocr" && value(input, "image_base64") != nil {
            guard let decoded = decodedImage(input) else { return invalidInput("vision ocr image_base64 is invalid or too large") }
            suppliedImage = decoded
        } else {
            suppliedImage = nil
        }
        if action == "capture_window" {
            let selectorKey = value(input, "window_id") != nil ? "window_id" : value(input, "hwnd") != nil ? "hwnd" : nil
            if let selectorKey, number(input, selectorKey) == nil {
                return invalidInput("vision capture_window requires an integer window_id or hwnd")
            }
            if let selectorKey, let id = number(input, selectorKey), (!id.isFinite || id < 0 || id.rounded(.towardZero) != id || id > Double(CGWindowID.max)) {
                return invalidInput("vision capture_window requires an integer window_id or hwnd")
            }
            guard selectedWindowId(input) != nil else { return invalidInput("vision capture_window requires a valid window selector") }
        }
        if action == "capture_region" {
            let region = value(input, "region") as? [String: Any] ?? input
            guard let x = number(region, "x"), let y = number(region, "y"), let width = number(region, "width"), let height = number(region, "height"), x.isFinite, y.isFinite, width.isFinite, height.isFinite, abs(x) <= maxWindowCoordinate, abs(y) <= maxWindowCoordinate, width > 0, height > 0, width <= Double(maxImageDimension), height <= Double(maxImageDimension), regionIntersectsKnownDisplay(x: x, y: y, width: width, height: height) else {
                return invalidInput("vision capture_region requires finite positive bounded coordinates")
            }
        }
        if suppliedImage == nil {
            guard MacScreenRecordingProvider.permissionGranted() else { return permissionFailure("Screen Recording permission is required for macOS capture") }
        }
        guard let image = suppliedImage ?? captureImage(action: action, input: input) else { return dependencyFailure("macOS screen capture returned no image") }
        if action == "ocr" {
            guard let text = MacVisionOcrProvider.recognize(image) else { return dependencyFailure("macOS Vision OCR returned no result") }
            return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "text": AnyEncodable(text)])
        }
        guard let encoded = pngData(image), encoded.count <= maxImageBytes else { return .failure(code: "FILE_TOO_LARGE", message: "macOS capture exceeds the image limit", recoverable: true) }
        return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "format": AnyEncodable("png"), "mime_type": AnyEncodable("image/png"), "data_base64": AnyEncodable(encoded.base64EncodedString()), "width": AnyEncodable(image.width), "height": AnyEncodable(image.height)])
    }

    static func decodedImage(_ input: [String: Any]) -> CGImage? {
        guard let encoded = payloadString(input, "image_base64", maxBytes: maxImageBytes * 2), !encoded.isEmpty,
              encoded.utf8.count <= maxImageBytes * 2,
              let data = Data(base64Encoded: encoded),
              data.count <= maxImageBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber,
              width.int64Value > 0, height.int64Value > 0,
              width.int64Value <= Int64(maxImageDimension), height.int64Value <= Int64(maxImageDimension),
              width.int64Value * height.int64Value <= maxImagePixels,
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: true] as CFDictionary),
              image.width > 0,
              image.height > 0,
              image.width <= maxImageDimension,
              image.height <= maxImageDimension,
              Int64(image.width) * Int64(image.height) <= maxImagePixels else { return nil }
        return image
    }

    private static func annotate(_ image: CGImage, input: [String: Any]) -> CGImage? {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let imageBounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.interpolationQuality = .high
        context.draw(image, in: imageBounds)
        context.setStrokeColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.setLineWidth(3)
        for mark in (value(input, "marks") as? [[String: Any]]) ?? [] {
            guard let bounds = mark["bounds"] as? [String: Any],
                  let x = (bounds["x"] as? NSNumber)?.doubleValue,
                  let y = (bounds["y"] as? NSNumber)?.doubleValue,
                  let width = (bounds["width"] as? NSNumber)?.doubleValue,
                  let height = (bounds["height"] as? NSNumber)?.doubleValue,
                  x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                  width > 0, height > 0, width <= Double(image.width), height <= Double(image.height) else { continue }
            let rect = CGRect(x: x, y: Double(image.height) - y - height, width: width, height: height).intersection(imageBounds)
            if rect.width > 0, rect.height > 0 { context.stroke(rect) }
        }
        return context.makeImage()
    }

    private static func releaseAll() -> MacNativeResult {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return dependencyFailure("macOS event source is unavailable") }
        let held = MacInputProvider.state
        for key in held.keys {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { return dependencyFailure("macOS key release event could not be created") }
            MacInputProvider.post(event)
        }
        guard let position = CGEvent(source: nil)?.location else { return dependencyFailure("macOS cursor position is unavailable") }
        for rawButton in held.buttons {
            guard let button = CGMouseButton(rawValue: rawButton) else { continue }
            let mouseType: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
            guard let event = CGEvent(mouseEventSource: source, mouseType: mouseType, mouseCursorPosition: position, mouseButton: button) else { return dependencyFailure("macOS button release event could not be created") }
            MacInputProvider.post(event)
        }
        return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "released": AnyEncodable(true), "scope": AnyEncodable("provider_owned_keys_and_buttons")])
    }

    private static func audio(action: String) -> MacNativeResult {
        switch action {
        case "status":
            let permission = MacAudioProvider.permissionGranted()
            return .value(status(available: true, ready: false, reason: permission ? "provider_not_implemented" : "permission_required", supportedActions: ["status", "record", "play", "stop"]))
        default:
            return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS audio provider is dependency-gated until owned recording/playback is implemented", recoverable: true)
        }
    }

    private static func screenRecord(action: String) -> MacNativeResult {
        switch action {
        case "status":
            let permission = MacScreenRecordingProvider.permissionGranted()
            return .value(status(available: true, ready: false, reason: permission ? "provider_not_implemented" : "permission_required", supportedActions: ["status", "start", "stop"]))
        default:
            return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS screen recording provider is dependency-gated until owned start/stop is implemented", recoverable: true)
        }
    }

    private static func office(action: String) -> MacNativeResult {
        let supported = ["status", "read", "read_text", "sheets", "list_folders", "list_messages", "write", "replace", "merge", "save_as"]
        guard supported.contains(action) else { return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS Office action \(action) is not implemented", recoverable: true) }
        let installed = officeApplicationURL() != nil
        if action == "status" {
            return .value(status(available: installed, ready: false, reason: installed ? "provider_not_implemented" : "dependency_missing", supportedActions: supported))
        }
        return .failure(code: "UNSUPPORTED_PLATFORM", message: "macOS Office automation is dependency-gated until an Apple Events bridge is implemented", recoverable: true)
    }

    private static func status(available: Bool, ready: Bool, reason: String?, supportedActions: [String]) -> [String: AnyEncodable] {
        var value: [String: AnyEncodable] = ["available": AnyEncodable(available), "ready": AnyEncodable(ready), "supportedActions": AnyEncodable(supportedActions)]
        if let reason { value["reason"] = AnyEncodable(reason); value["readinessReason"] = AnyEncodable(reason) }
        return value
    }

    private static func windowList() -> MacNativeResult {
        guard let infos = windowInfo() else { return dependencyFailure("macOS window metadata is unavailable") }
        return .value(["available": AnyEncodable(true), "ready": AnyEncodable(true), "windows": AnyEncodable(infos)])
    }

    private static func windowInfo() -> [WindowRecord]? {
        guard let raw = MacWindowProvider.onScreenWindowInfo() else { return nil }
        return raw.prefix(maxWindows).compactMap { info in
            guard let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue else { return nil }
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.intValue
            let owner = (info[kCGWindowOwnerName as String] as? String)
            let title = (info[kCGWindowName as String] as? String).map { String($0.prefix(512)) }
            let bounds = (info[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }.map(rect)
            return WindowRecord(id: number, pid: pid, app: owner, title: title, bounds: bounds)
        }
    }

    private static func selectedWindow(_ input: [String: Any]) -> WindowRecord? {
        let windows = windowInfo() ?? []
        if value(input, "window_index") != nil {
            guard let index = number(input, "window_index"), index.isFinite, index.rounded(.towardZero) == index, index >= 0, index < Double(windows.count) else { return nil }
            return windows[Int(index)]
        }
        // The shared capability schema calls the native window handle `hwnd`
        // for historical Windows compatibility.  On macOS the corresponding
        // stable selector is the CoreGraphics window number, exposed here as
        // either `window_id` (native spelling) or `hwnd` (shared spelling).
        if value(input, "window_id") != nil || value(input, "hwnd") != nil {
            let key = value(input, "window_id") != nil ? "window_id" : "hwnd"
            guard let id = boundedInteger(input, key, maximum: Double(CGWindowID.max)) else { return nil }
            return windows.first { $0.id == id }
        }
        let expectedPid: Int?
        if value(input, "pid") != nil {
            guard let pid = boundedInteger(input, "pid", maximum: Double(Int32.max)) else { return nil }
            expectedPid = pid
        } else if value(input, "process_id") != nil {
            guard let pid = boundedInteger(input, "process_id", maximum: Double(Int32.max)) else { return nil }
            expectedPid = pid
        } else {
            expectedPid = nil
        }
        let expectedTitle = string(input, "title")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let expectedProcess = string(input, "process_name")?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard expectedPid != nil || !(expectedTitle ?? "").isEmpty || !(expectedProcess ?? "").isEmpty else { return nil }
        return windows.first { window in
            if let expectedPid, window.pid != expectedPid { return false }
            if let expectedTitle, !expectedTitle.isEmpty, window.title?.localizedCaseInsensitiveContains(expectedTitle) != true { return false }
            if let expectedProcess, !expectedProcess.isEmpty, window.app?.localizedCaseInsensitiveCompare(expectedProcess) != .orderedSame { return false }
            return true
        }
    }

    private static func selectedWindowId(_ input: [String: Any]) -> CGWindowID? {
        guard let selected = selectedWindow(input), selected.id >= 0 else { return nil }
        return CGWindowID(selected.id)
    }

    private static func selectedPid(_ input: [String: Any]) -> pid_t? {
        let hasWindowSelector = value(input, "window_id") != nil
            || value(input, "hwnd") != nil
            || value(input, "window_index") != nil
            || value(input, "title") != nil
        if hasWindowSelector {
            guard let selected = selectedWindow(input), let pid = selected.pid, pid > 0 else { return nil }
            return pid_t(pid)
        }
        if value(input, "pid") != nil {
            guard let pid = boundedInteger(input, "pid", maximum: Double(Int32.max)) else { return nil }
            return pid_t(pid)
        }
        if value(input, "process_id") != nil {
            guard let pid = boundedInteger(input, "process_id", maximum: Double(Int32.max)) else { return nil }
            return pid_t(pid)
        }
        if value(input, "process_name") != nil {
            guard let name = string(input, "process_name"), !name.isEmpty else { return nil }
            return NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.localizedCaseInsensitiveCompare(name) == .orderedSame })?.processIdentifier
        }
        if let active = NSWorkspace.shared.frontmostApplication { return active.processIdentifier }
        return nil
    }

    private static func activeWindow() -> [String: AnyEncodable] {
        var value: [String: AnyEncodable] = ["available": AnyEncodable(true)]
        if let app = NSWorkspace.shared.frontmostApplication {
            value["pid"] = AnyEncodable(Int(app.processIdentifier))
            value["app"] = AnyEncodable(app.localizedName ?? "")
        }
        return value
    }

    private static func displayList() -> [[String: AnyEncodable]] {
        MacWindowProvider.screens().enumerated().map { index, screen in
            var value: [String: AnyEncodable] = ["index": AnyEncodable(index), "bounds": AnyEncodable(rect(screen.frame)), "scale_factor": AnyEncodable(screen.backingScaleFactor)]
            if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                value["id"] = AnyEncodable(number.intValue)
                value["bounds"] = AnyEncodable(rect(CGDisplayBounds(CGDirectDisplayID(number.uint32Value))))
            }
            return value
        }
    }

    private static func captureImage(action: String, input: [String: Any]) -> CGImage? {
        if action == "capture_window" {
            guard let id = selectedWindowId(input) else { return nil }
            return MacScreenCaptureProvider.captureWindow(id)
        }
        var bounds = CGRect.null
        let region = value(input, "region") as? [String: Any] ?? input
        if action == "capture_region" {
            guard let x = number(region, "x"), let y = number(region, "y"), let width = number(region, "width"), let height = number(region, "height"), x.isFinite, y.isFinite, width > 0, height > 0, width <= 16_384, height <= 16_384 else { return nil }
            guard abs(x) <= maxWindowCoordinate, abs(y) <= maxWindowCoordinate, regionIntersectsKnownDisplay(x: x, y: y, width: width, height: height) else { return nil }
            bounds = CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
        }
        return MacScreenCaptureProvider.captureDisplay(bounds)
    }

    private static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    private static func officeApplicationURL() -> URL? {
        let identifiers = ["com.microsoft.Excel", "com.microsoft.Word", "com.microsoft.Powerpoint"]
        return identifiers.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
    }

    private static func point(_ input: [String: Any], _ xName: String, _ yName: String) -> CGPoint? {
        guard let x = number(input, xName), let y = number(input, yName), x.isFinite, y.isFinite else { return nil }
        return CGPoint(x: CGFloat(x), y: CGFloat(y))
    }

    private static func hasValue(_ input: [String: Any], _ key: String) -> Bool { value(input, key) != nil }

    private static func optionalWindowCoordinate(_ input: [String: Any], _ key: String) -> CGFloat? {
        guard value(input, key) != nil else { return nil }
        guard let value = number(input, key), value.isFinite, abs(value) <= maxWindowCoordinate else { return nil }
        return CGFloat(value)
    }

    private static func optionalWindowDimension(_ input: [String: Any], _ key: String) -> CGFloat? {
        guard let raw = value(input, key) else { return nil }
        guard raw is NSNumber, let value = number(input, key), value.isFinite, value > 0, value <= maxWindowDimension else { return nil }
        return CGFloat(value)
    }

    private static func isOnKnownDisplay(_ point: CGPoint) -> Bool { MacWindowProvider.displayBounds().contains { $0.contains(point) } }

    private static func regionIntersectsKnownDisplay(x: Double, y: Double, width: Double, height: Double) -> Bool {
        let region = CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
        return MacWindowProvider.displayBounds().contains { $0.intersects(region) }
    }

    private static func virtualKey(_ input: [String: Any]) -> CGKeyCode? {
        guard let raw = value(input, "key") else { return nil }
        if let key = raw as? String { return virtualKey(for: key) }
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let numeric = number.doubleValue
        guard numeric.isFinite, numeric.rounded(.towardZero) == numeric, numeric >= 0, numeric <= 127 else { return nil }
        return CGKeyCode(Int(numeric))
    }

    private static func virtualKey(for key: String) -> CGKeyCode? {
        let named: [String: CGKeyCode] = [
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        ]
        if let value = named[key.lowercased()] { return value }
        return nil
    }

    private static func mouseButton(_ input: [String: Any]) -> CGMouseButton? {
        guard let raw = value(input, "button") else { return .left }
        if let named = raw as? String {
            switch named.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "left", "primary": return .left
            case "middle", "center", "auxiliary": return .center
            case "right", "secondary": return .right
            default: return nil
            }
        }
        guard let numeric = raw as? NSNumber, CFGetTypeID(numeric) != CFBooleanGetTypeID() else { return nil }
        let value = numeric.doubleValue
        guard value.isFinite, value.rounded(.towardZero) == value, value >= 1, value <= 3 else { return nil }
        switch Int(value) {
        case 1: return .left
        case 2: return .center
        case 3: return .right
        default: return nil
        }
    }

    private static func flags(_ input: [String: Any]) -> CGEventFlags {
        let modifiers = (value(input, "modifiers") as? [Any])?.compactMap { $0 as? String }.map { $0.lowercased() } ?? []
        var value: CGEventFlags = []
        if modifiers.contains("command") || modifiers.contains("cmd") { value.insert(.maskCommand) }
        if modifiers.contains("control") || modifiers.contains("ctrl") { value.insert(.maskControl) }
        if modifiers.contains("option") || modifiers.contains("alt") { value.insert(.maskAlternate) }
        if modifiers.contains("shift") { value.insert(.maskShift) }
        return value
    }

    private static func permissionFailure(_ message: String) -> MacNativeResult { .failure(code: "PERMISSION_REQUIRED", message: message, recoverable: true) }
    private static func dependencyFailure(_ message: String) -> MacNativeResult { .failure(code: "EXECUTABLE_NOT_FOUND", message: message, recoverable: true) }
    private static func invalidInput(_ message: String) -> MacNativeResult { .failure(code: "INVALID_INPUT", message: message, recoverable: false) }
    private static func value(_ input: [String: Any], _ key: String) -> Any? {
        if let direct = lookup(input, key) { return direct }
        if let parameters = input["parameters"] as? [String: Any], let nested = lookup(parameters, key) { return nested }
        return nil
    }

    private static func lookup(_ input: [String: Any], _ key: String) -> Any? {
        if let direct = input[key] { return direct }
        var current: Any = input
        for component in key.split(separator: ".") {
            guard let dictionary = current as? [String: Any], let next = dictionary[String(component)] else { return nil }
            current = next
        }
        return current
    }

    private static func string(_ input: [String: Any], _ key: String) -> String? { (value(input, key) as? String).map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4_096)) } }

    static func payloadString(_ input: [String: Any], _ key: String, maxBytes: Int) -> String? {
        guard let text = value(input, key) as? String, text.utf8.count <= maxBytes else { return nil }
        return text
    }

    private static func accessibilitySelection(_ input: [String: Any]) -> (pid: pid_t, window: MacWindowTarget?)? {
        let hasWindowSelector = ["window_id", "hwnd", "window_index", "title"].contains { value(input, $0) != nil }
        if hasWindowSelector {
            guard let selected = selectedWindow(input), let pid = selected.pid, pid > 0, pid <= Int(Int32.max), let bounds = selected.bounds else { return nil }
            return (pid_t(pid), MacWindowTarget(bounds: CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height), title: selected.title))
        }
        guard let pid = selectedPid(input) else { return nil }
        return (pid, nil)
    }

    private static func boundedAccessibilityDepth(_ input: [String: Any], key: String) -> Int? {
        guard hasValue(input, key) else { return 6 }
        return boundedInteger(input, key, maximum: 12)
    }

    private static func boundedAccessibilityItems(_ input: [String: Any], key: String) -> Int? {
        guard hasValue(input, key) else { return 500 }
        return boundedInteger(input, key, maximum: 500)
    }

    static func number(_ input: [String: Any], _ key: String) -> Double? {
        guard let raw = value(input, key), let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }
    private static func boundedInteger(_ input: [String: Any], _ key: String, maximum: Double) -> Int? {
        guard let value = number(input, key), value.isFinite, value.rounded(.towardZero) == value, value >= 0, value <= maximum else { return nil }
        return Int(value)
    }
    private static func rect(_ rect: CGRect) -> WindowRect { WindowRect(x: Double(rect.origin.x), y: Double(rect.origin.y), width: Double(rect.width), height: Double(rect.height)) }
}
