import CoreGraphics

struct MacInputState {
    private(set) var keys = Set<CGKeyCode>()
    private(set) var buttons = Set<UInt32>()

    mutating func record(_ event: CGEvent) {
        switch event.type {
        case .keyDown: keys.insert(CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)))
        case .keyUp: keys.remove(CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode)))
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            buttons.insert(UInt32(event.getIntegerValueField(.mouseEventButtonNumber)))
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            buttons.remove(UInt32(event.getIntegerValueField(.mouseEventButtonNumber)))
        default: break
        }
    }
}

/// Single posting boundary for governed CGEvent dispatch.
enum MacInputProvider {
    private(set) static var state = MacInputState()

    static func post(_ event: CGEvent) {
        state.record(event)
        event.post(tap: .cghidEventTap)
    }

    static func textEvents(_ text: String) -> [CGEvent]? {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return nil }
        let units = Array(text.utf16)
        var events: [CGEvent] = []
        var start = 0
        while start < units.count {
            var end = min(start + 20, units.count)
            if end < units.count, (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return nil }
            Array(units[start..<end]).withUnsafeBufferPointer { buffer in
                if let baseAddress = buffer.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
                    up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
                }
            }
            events.append(contentsOf: [down, up])
            start = end
        }
        return events
    }
}
