import CoreGraphics

enum MacScreenCaptureProvider {
    static func captureWindow(_ id: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(.null, [.optionIncludingWindow], id, [.bestResolution])
    }

    static func captureDisplay(_ bounds: CGRect) -> CGImage? {
        CGWindowListCreateImage(bounds, [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID, [.bestResolution])
    }
}
