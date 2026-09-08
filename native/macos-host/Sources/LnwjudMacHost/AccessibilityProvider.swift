import ApplicationServices
import CoreGraphics
import Foundation

enum MacWindowMutationResult {
    case applied
    case permissionRequired
    case unavailable
}

enum MacAccessibilityResult {
    case value([String: AnyEncodable])
    case applied
    case permissionRequired
    case unavailable
    case invalid
}

struct MacWindowTarget {
    let bounds: CGRect
    let title: String?

    // Public AX APIs do not expose a CoreGraphics window ID. Require a unique
    // geometry/title match within its owner process; never guess on ambiguity.
    func uniqueMatch(in candidates: [MacWindowTarget]) -> Int? {
        let matches = candidates.indices.filter { index in
            let candidate = candidates[index]
            return candidate.bounds == bounds
                && (title == nil || title?.isEmpty == true || candidate.title == title)
        }
        return matches.count == 1 ? matches[0] : nil
    }
}

/// Permission and semantic-observation boundary for macOS accessibility.
/// Mutating AX actions remain owned by the existing capability confirmation
/// path; this helper only exposes the native trust probe to the provider.
enum MacAccessibilityProvider {
    // AXFullScreen is an AX attribute name, not a public SDK constant.
    private static let fullScreenAttribute = "AXFullScreen"

    static func element(_ raw: CFTypeRef?) -> AXUIElement? {
        guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }

    static func axValue(_ raw: CFTypeRef?) -> AXValue? {
        guard let raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        return (raw as! AXValue)
    }

    static func isTrusted() -> Bool { AXIsProcessTrusted() }

    /// A bounded, read-only semantic probe.  Trust alone only says that TCC
    /// permits AX messaging; querying the focused application proves that the
    /// current session can actually answer an accessibility request.
    static func semanticProbe() -> Bool {
        guard isTrusted() else { return false }
        let systemWide = AXUIElementCreateSystemWide()
        _ = AXUIElementSetMessagingTimeout(systemWide, 0.5)
        var focusedApplication: CFTypeRef?
        return AXUIElementCopyAttributeValue(
            systemWide,
            "AXFocusedApplication" as CFString,
            &focusedApplication
        ) == .success
    }

    /// Return a bounded semantic snapshot rooted at the selected application's
    /// focused window. The snapshot is deliberately finite: AX trees can be
    /// cyclic or extremely large, and a native provider must never let an
    /// accessibility query become an unbounded IPC response.
    static func observe(
        pid: pid_t,
        windowTarget: MacWindowTarget? = nil,
        maxDepth: Int = 6,
        maxItems: Int = 500
    ) -> MacAccessibilityResult {
        guard isTrusted() else { return .permissionRequired }
        let application = AXUIElementCreateApplication(pid)
        guard let root = observationRoot(pid: pid, target: windowTarget, application: application) else { return .unavailable }
        let limit = max(1, min(maxItems, 500))
        var remaining = limit
        let element = record(root, depth: 0, maxDepth: max(0, min(maxDepth, 12)), remaining: &remaining)
        return .value([
            "available": AnyEncodable(true),
            "ready": AnyEncodable(true),
            "pid": AnyEncodable(Int(pid)),
            "semantic_available": AnyEncodable(true),
            "element": AnyEncodable(element),
            "element_count": AnyEncodable(limit - remaining),
            "truncated": AnyEncodable(remaining == 0),
        ])
    }

    /// Find one semantic element using stable, user-visible selectors. A
    /// caller can provide a name/title, automation_id, and/or role; all
    /// supplied selectors must match the same element.
    static func find(
        pid: pid_t,
        windowTarget: MacWindowTarget? = nil,
        name: String?,
        automationID: String?,
        role: String?,
        maxDepth: Int = 8,
        maxItems: Int = 500
    ) -> MacAccessibilityResult {
        guard isTrusted() else { return .permissionRequired }
        guard name != nil || automationID != nil || role != nil else { return .invalid }
        let application = AXUIElementCreateApplication(pid)
        guard let root = observationRoot(pid: pid, target: windowTarget, application: application) else { return .unavailable }
        var remaining = max(1, min(maxItems, 500))
        guard let element = findElement(root, name: name, automationID: automationID, role: role, depth: 0, maxDepth: max(0, min(maxDepth, 12)), remaining: &remaining) else {
            return .unavailable
        }
        var recordRemaining = 1
        let value = record(element, depth: 0, maxDepth: 0, remaining: &recordRemaining)
        return .value([
            "available": AnyEncodable(true),
            "ready": AnyEncodable(true),
            "pid": AnyEncodable(Int(pid)),
            "element": AnyEncodable(value),
        ])
    }

    /// Execute a semantic action against a freshly-resolved element. Elements
    /// are intentionally not retained between requests, so stale AX objects
    /// cannot be replayed after the target application changes.
    static func perform(
        pid: pid_t,
        windowTarget: MacWindowTarget? = nil,
        action: String,
        name: String?,
        automationID: String?,
        role: String?,
        value: String?,
        maxDepth: Int = 8,
        maxItems: Int = 500
    ) -> MacAccessibilityResult {
        guard isTrusted() else { return .permissionRequired }
        guard name != nil || automationID != nil || role != nil else { return .invalid }
        guard let root = observationRoot(pid: pid, target: windowTarget, application: AXUIElementCreateApplication(pid)) else { return .unavailable }
        var remaining = max(1, min(maxItems, 500))
        guard let target = findElement(
            root,
            name: name,
            automationID: automationID,
            role: role,
            depth: 0,
            maxDepth: max(0, min(maxDepth, 12)),
            remaining: &remaining
        ) else { return .unavailable }

        switch action {
        case "read_value":
            guard let raw = attribute(target, kAXValueAttribute as CFString) else { return .unavailable }
            let text = scalarText(raw)
            return .value([
                "available": AnyEncodable(true),
                "ready": AnyEncodable(true),
                "value": AnyEncodable(text),
            ])
        case "click":
            return AXUIElementPerformAction(target, kAXPressAction as CFString) == .success ? .applied : .unavailable
        case "focus":
            return AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success ? .applied : .unavailable
        case "set_value":
            guard let value else { return .invalid }
            return AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString) == .success ? .applied : .unavailable
        case "select_item":
            if AXUIElementSetAttributeValue(target, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return .applied }
            return AXUIElementPerformAction(target, kAXPressAction as CFString) == .success ? .applied : .unavailable
        case "menu_select":
            return AXUIElementPerformAction(target, kAXPressAction as CFString) == .success ? .applied : .unavailable
        default:
            return .invalid
        }
    }

    /// Apply only the bounded window mutations used by the public window
    /// capability. Accessibility permission is checked again at the point of
    /// mutation because TCC grants may be revoked while lnwjud is running.
    static func mutateWindow(
        pid: pid_t,
        windowTarget: MacWindowTarget? = nil,
        action: String,
        x: CGFloat? = nil,
        y: CGFloat? = nil,
        width: CGFloat? = nil,
        height: CGFloat? = nil
    ) -> MacWindowMutationResult {
        guard isTrusted() else { return .permissionRequired }
        guard let window = selectedWindow(for: pid, target: windowTarget) else { return .unavailable }

        switch action {
        case "close", "close_window":
            var rawButton: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &rawButton) == .success,
                  let rawButton,
                  let button = element(rawButton),
                  AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
                return .unavailable
            }
            return .applied
        case "minimize":
            return setBoolean(window, attribute: kAXMinimizedAttribute, value: true) ? .applied : .unavailable
        case "restore":
            if boolAttribute(window, kAXMinimizedAttribute as CFString) == true,
               !setBoolean(window, attribute: kAXMinimizedAttribute, value: false) { return .unavailable }
            if boolAttribute(window, fullScreenAttribute as CFString) == true,
               !setBoolean(window, attribute: fullScreenAttribute, value: false) { return .unavailable }
            return .applied
        case "maximize":
            // Prefer the explicit full-screen AX state when the application
            // exposes it; otherwise press the standard zoom button. Both
            // routes remain bounded to the selected focused window.
            if setBoolean(window, attribute: fullScreenAttribute, value: true) { return .applied }
            return pressZoomButton(window) ? .applied : .unavailable
        case "move":
            guard let x, let y else { return .unavailable }
            return setPoint(window, attribute: kAXPositionAttribute, value: CGPoint(x: x, y: y)) ? .applied : .unavailable
        case "resize":
            guard let width, let height else { return .unavailable }
            return setSize(window, attribute: kAXSizeAttribute, value: CGSize(width: width, height: height)) ? .applied : .unavailable
        case "set_window_frame":
            guard let x, let y, let width, let height else { return .unavailable }
            guard setPoint(window, attribute: kAXPositionAttribute, value: CGPoint(x: x, y: y)) else { return .unavailable }
            return setSize(window, attribute: kAXSizeAttribute, value: CGSize(width: width, height: height)) ? .applied : .unavailable
        default:
            return .unavailable
        }
    }

    private static func focusedWindow(for pid: pid_t) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        var rawWindow: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success,
              let rawWindow else { return nil }
        return element(rawWindow)
    }

    private static func observationRoot(pid: pid_t, target: MacWindowTarget?, application: AXUIElement) -> AXUIElement? {
        if target != nil { return selectedWindow(for: pid, target: target) }
        return focusedWindow(for: pid) ?? application
    }

    static func selectedWindow(for pid: pid_t, target: MacWindowTarget?) -> AXUIElement? {
        guard let target else { return focusedWindow(for: pid) }
        let application = AXUIElementCreateApplication(pid)
        guard let raw = attribute(application, kAXWindowsAttribute as CFString) as? [AnyObject] else { return nil }
        let candidates: [(AXUIElement, MacWindowTarget)] = raw.compactMap { value in
            guard let window = element(value), let bounds = windowBounds(window) else { return nil }
            return (window, MacWindowTarget(bounds: bounds, title: stringAttribute(window, kAXTitleAttribute as CFString)))
        }
        guard let index = target.uniqueMatch(in: candidates.map { $0.1 }) else { return nil }
        return candidates[index].0
    }

    private static func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
        return value
    }

    private static func record(
        _ element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        remaining: inout Int
    ) -> [String: AnyEncodable] {
        guard remaining > 0 else { return ["truncated": AnyEncodable(true)] }
        remaining -= 1
        var value: [String: AnyEncodable] = ["depth": AnyEncodable(depth)]
        if let title = stringAttribute(element, kAXTitleAttribute as CFString), !title.isEmpty { value["name"] = AnyEncodable(title) }
        if let description = stringAttribute(element, kAXDescriptionAttribute as CFString), !description.isEmpty, value["name"] == nil { value["name"] = AnyEncodable(description) }
        if let identifier = stringAttribute(element, kAXIdentifierAttribute as CFString), !identifier.isEmpty { value["automation_id"] = AnyEncodable(identifier) }
        if let role = stringAttribute(element, kAXRoleAttribute as CFString), !role.isEmpty { value["role"] = AnyEncodable(role) }
        if let subrole = stringAttribute(element, kAXSubroleAttribute as CFString), !subrole.isEmpty { value["subrole"] = AnyEncodable(subrole) }
        if let text = scalarText(attribute(element, kAXValueAttribute as CFString)), !text.isEmpty { value["value"] = AnyEncodable(text) }
        if let enabled = boolAttribute(element, kAXEnabledAttribute as CFString) { value["enabled"] = AnyEncodable(enabled) }
        if let focused = boolAttribute(element, kAXFocusedAttribute as CFString) { value["focused"] = AnyEncodable(focused) }
        if let bounds = boundsAttribute(element) { value["bounds"] = AnyEncodable(bounds) }

        guard depth < maxDepth, remaining > 0, let children = children(of: element), !children.isEmpty else { return value }
        var records: [[String: AnyEncodable]] = []
        for child in children {
            guard remaining > 0 else { break }
            records.append(record(child, depth: depth + 1, maxDepth: maxDepth, remaining: &remaining))
        }
        if !records.isEmpty { value["children"] = AnyEncodable(records) }
        if remaining == 0 { value["children_truncated"] = AnyEncodable(true) }
        return value
    }

    private static func findElement(
        _ element: AXUIElement,
        name: String?,
        automationID: String?,
        role: String?,
        depth: Int,
        maxDepth: Int,
        remaining: inout Int
    ) -> AXUIElement? {
        guard remaining > 0 else { return nil }
        remaining -= 1
        let title = stringAttribute(element, kAXTitleAttribute as CFString)
        let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
        let identifier = stringAttribute(element, kAXIdentifierAttribute as CFString)
        let elementRole = stringAttribute(element, kAXRoleAttribute as CFString)
        let nameMatches = name.map { needle in
            [title, description].compactMap { $0 }.contains { $0.localizedCaseInsensitiveContains(needle) }
        } ?? true
        let idMatches = automationID.map { identifier == $0 } ?? true
        let roleMatches = role.map { elementRole?.localizedCaseInsensitiveCompare($0) == .orderedSame } ?? true
        if nameMatches && idMatches && roleMatches { return element }
        guard depth < maxDepth, let children = children(of: element) else { return nil }
        for child in children {
            if let found = findElement(child, name: name, automationID: automationID, role: role, depth: depth + 1, maxDepth: maxDepth, remaining: &remaining) { return found }
        }
        return nil
    }

    private static func children(of element: AXUIElement) -> [AXUIElement]? {
        guard let raw = attribute(element, kAXChildrenAttribute as CFString) else { return nil }
        if let children = raw as? [AnyObject] { return children.compactMap { self.element($0) } }
        return nil
    }

    private static func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
        guard let raw = attribute(element, name) else { return nil }
        if let value = raw as? String { return String(value.prefix(4_096)) }
        if let value = raw as? NSString { return String(value).prefix(4_096).description }
        return nil
    }

    private static func scalarText(_ raw: CFTypeRef?) -> String? {
        guard let raw else { return nil }
        if let value = raw as? String { return String(value.prefix(4_096)) }
        if let value = raw as? NSString { return String(value).prefix(4_096).description }
        if let value = raw as? NSNumber { return value.stringValue }
        return nil
    }

    private static func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
        guard let raw = attribute(element, name) else { return nil }
        if let value = raw as? Bool { return value }
        if let value = raw as? NSNumber { return value.boolValue }
        return nil
    }

    private static func boundsAttribute(_ element: AXUIElement) -> [String: AnyEncodable]? {
        guard let bounds = windowBounds(element) else { return nil }
        return [
            "x": AnyEncodable(Double(bounds.origin.x)),
            "y": AnyEncodable(Double(bounds.origin.y)),
            "width": AnyEncodable(Double(bounds.width)),
            "height": AnyEncodable(Double(bounds.height)),
        ]
    }

    private static func windowBounds(_ element: AXUIElement) -> CGRect? {
        guard let rawPosition = axValue(attribute(element, kAXPositionAttribute as CFString)),
              let rawSize = axValue(attribute(element, kAXSizeAttribute as CFString)) else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetType(rawPosition) == .cgPoint,
              AXValueGetType(rawSize) == .cgSize,
              AXValueGetValue(rawPosition, .cgPoint, &position),
              AXValueGetValue(rawSize, .cgSize, &size),
              position.x.isFinite, position.y.isFinite,
              size.width.isFinite, size.height.isFinite,
              size.width >= 0, size.height >= 0,
              abs(position.x) <= 1_000_000, abs(position.y) <= 1_000_000,
              size.width <= 16_384, size.height <= 16_384 else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func setBoolean(_ element: AXUIElement, attribute: String, value: Bool) -> Bool {
        AXUIElementSetAttributeValue(element, attribute as CFString, value ? kCFBooleanTrue : kCFBooleanFalse) == .success
    }

    private static func setPoint(_ element: AXUIElement, attribute: String, value: CGPoint) -> Bool {
        var value = value
        guard let axValue = AXValueCreate(.cgPoint, &value) else { return false }
        return AXUIElementSetAttributeValue(element, attribute as CFString, axValue) == .success
    }

    private static func setSize(_ element: AXUIElement, attribute: String, value: CGSize) -> Bool {
        var value = value
        guard let axValue = AXValueCreate(.cgSize, &value) else { return false }
        return AXUIElementSetAttributeValue(element, attribute as CFString, axValue) == .success
    }

    private static func pressZoomButton(_ window: AXUIElement) -> Bool {
        var rawButton: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXZoomButtonAttribute as CFString, &rawButton) == .success,
              let rawButton,
              let button = element(rawButton) else { return false }
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }
}
