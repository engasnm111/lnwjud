import CoreGraphics

/// Screen recording is intentionally separate from one-shot screenshot/OCR.
/// The task owner must be implemented before this helper advertises start/stop.
enum MacScreenRecordingProvider {
    static func permissionGranted() -> Bool { CGPreflightScreenCaptureAccess() }
}
