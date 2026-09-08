import Vision
import CoreGraphics
import Foundation

enum MacVisionOcrProvider {
    private static let maxTextBytes = 64 * 1024

    static func recognize(_ image: CGImage) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            let supported = try request.supportedRecognitionLanguages()
            let preferred = ["en-US", "th-TH"].filter { supported.contains($0) }
            if !preferred.isEmpty { request.recognitionLanguages = preferred }
            try handler.perform([request])
        } catch {
            return nil
        }
        let result = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        return String(decoding: Data(result.utf8).prefix(maxTextBytes), as: UTF8.self)
    }
}
