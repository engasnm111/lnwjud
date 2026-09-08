import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import LnwjudMacHost

final class NativeRegressionTests: XCTestCase {
    func testInputOwnershipTracksOrdinaryHeldKeysAndButtonsWithoutPosting() throws {
        var state = MacInputState()
        let down = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        let up = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false))
        let buttonDown = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: CGPoint(x: 1, y: 1), mouseButton: .right))
        let buttonUp = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: CGPoint(x: 1, y: 1), mouseButton: .right))
        state.record(down)
        state.record(buttonDown)
        XCTAssertEqual(state.keys, Set<CGKeyCode>([0]))
        XCTAssertEqual(state.buttons, Set<UInt32>([CGMouseButton.right.rawValue]))
        state.record(up)
        state.record(buttonUp)
        XCTAssertTrue(state.keys.isEmpty)
        XCTAssertTrue(state.buttons.isEmpty)
    }

    func testJSONZeroAndOneAreNumbersButBooleansAreRejected() throws {
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(#"{"parameters":{"zero":0,"one":1,"yes":true,"no":false}}"#.utf8)) as? [String: Any])
        XCTAssertEqual(MacNativeProviders.number(input, "zero"), 0)
        XCTAssertEqual(MacNativeProviders.number(input, "one"), 1)
        XCTAssertNil(MacNativeProviders.number(input, "yes"))
        XCTAssertNil(MacNativeProviders.number(input, "no"))
    }

    func testPayloadPreservesWhitespaceAndLongTextAndRejectsOversize() {
        let text = "  \n" + String(repeating: "ไทย", count: 2_000) + "\n  "
        let input: [String: Any] = ["parameters": ["text": text]]
        XCTAssertEqual(MacNativeProviders.payloadString(input, "text", maxBytes: 65_536), text)
        XCTAssertNil(MacNativeProviders.payloadString(input, "text", maxBytes: text.utf8.count - 1))
        XCTAssertEqual(MacNativeProviders.payloadString(["value": ""], "value", maxBytes: 65_536), "")
    }

    func testTextEventsRoundTripUnicodeWithoutPostingInput() throws {
        // Put a surrogate pair across the first 20-code-unit boundary.
        let text = String(repeating: "a", count: 19) + "😀 ไทย\n" + String(repeating: "x", count: 5_000) + "  "
        let events = try XCTUnwrap(MacInputProvider.textEvents(text))
        XCTAssertEqual(events.count % 2, 0)
        var reconstructed = ""
        for index in stride(from: 0, to: events.count, by: 2) {
            XCTAssertEqual(events[index].type, .keyDown)
            XCTAssertEqual(events[index + 1].type, .keyUp)
            var buffer = [UniChar](repeating: 0, count: 20)
            var count = 0
            buffer.withUnsafeMutableBufferPointer { pointer in
                events[index].keyboardGetUnicodeString(maxStringLength: pointer.count, actualStringLength: &count, unicodeString: pointer.baseAddress)
            }
            XCTAssertGreaterThan(count, 0)
            XCTAssertLessThanOrEqual(count, 20)
            reconstructed += String(decoding: buffer.prefix(count), as: UTF16.self)
        }
        XCTAssertEqual(reconstructed, text)
    }

    func testCoreFoundationConversionsValidateRuntimeType() throws {
        let element = AXUIElementCreateApplication(getpid())
        var point = CGPoint(x: 0, y: 1)
        let value = try XCTUnwrap(AXValueCreate(.cgPoint, &point))
        XCTAssertNotNil(MacAccessibilityProvider.element(element))
        XCTAssertNil(MacAccessibilityProvider.element(value))
        XCTAssertNil(MacAccessibilityProvider.element("wrong type" as CFString))
        XCTAssertNotNil(MacAccessibilityProvider.axValue(value))
        XCTAssertNil(MacAccessibilityProvider.axValue(element))
        XCTAssertNil(MacAccessibilityProvider.axValue(nil))
    }

    func testSuccessfulAccessibilityReadIsReturnedToCaller() throws {
        let text = "value from AX"
        let result = MacNativeProviders.accessibilityActionResult(.value(["value": AnyEncodable(text)]), action: "read_value", pid: getpid())
        guard case let .value(value) = result else { return XCTFail("Successful AX read became an error") }
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        XCTAssertEqual(decoded["value"] as? String, text)
    }

    func testWindowSelectionDoesNotFallBackToFocusedOrAmbiguousWindow() {
        let focused = MacWindowTarget(bounds: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Other")
        let selected = MacWindowTarget(bounds: CGRect(x: 100, y: 100, width: 800, height: 600), title: "Selected")
        XCTAssertEqual(selected.uniqueMatch(in: [focused, selected]), 1)
        XCTAssertNil(selected.uniqueMatch(in: [focused]))
        XCTAssertNil(selected.uniqueMatch(in: [selected, selected]))
        XCTAssertNil(selected.uniqueMatch(in: [MacWindowTarget(bounds: selected.bounds, title: "Other")]))
    }

    func testImageLargerThan4096Base64CharactersCanBeDecodedAndAnnotated() throws {
        let encoded = try pngFixture().base64EncodedString()
        XCTAssertGreaterThan(encoded.count, 4_096)
        let image = try XCTUnwrap(MacNativeProviders.decodedImage(["image_base64": encoded]))
        XCTAssertEqual(image.width, 128)
        XCTAssertEqual(image.height, 128)
        let result = MacNativeProviders.execute(operation: "vision", input: [
            "action": "annotate", "image_base64": encoded,
            "marks": [["bounds": ["x": 0, "y": 1, "width": 40, "height": 40]]],
        ])
        guard case let .value(value) = result else { return XCTFail("Valid image annotation failed") }
        let output = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        let outputImage = try XCTUnwrap(MacNativeProviders.decodedImage(["image_base64": try XCTUnwrap(output["data_base64"] as? String)]))
        XCTAssertEqual(outputImage.width, 128)
        XCTAssertEqual(outputImage.height, 128)
    }

    private func pngFixture() throws -> Data {
        var seed: UInt32 = 12345
        let bytes: [UInt8] = (0..<(128 * 128 * 4)).map { index in
            if index % 4 == 3 { return 255 }
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return UInt8(truncatingIfNeeded: seed >> 24)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        let image = try XCTUnwrap(CGImage(width: 128, height: 128, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 512, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
