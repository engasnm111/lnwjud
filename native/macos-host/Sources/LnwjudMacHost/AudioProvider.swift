import AVFoundation

/// Audio remains dependency-gated until the owned recording task contract is
/// implemented. Permission state is still available for a future provider.
enum MacAudioProvider {
    static func permissionGranted() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }
}
