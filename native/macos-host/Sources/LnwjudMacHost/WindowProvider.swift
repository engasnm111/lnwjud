import AppKit
import CoreGraphics

/// Bounded window/display metadata source. AXUIElement semantic queries can be
/// layered on this source without changing the NDJSON host contract.
enum MacWindowProvider {
    static func onScreenWindowInfo() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    }

    static func screens() -> [NSScreen] { NSScreen.screens }

    static func displayBounds() -> [CGRect] {
        screens().compactMap { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
        }
    }
}
