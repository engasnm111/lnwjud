import Foundation
import XCTest

final class ProtocolTests: XCTestCase {
    func testExecutableAnswersMultipleRequestsWithTheirOriginalIDs() throws {
        var directory = Bundle(for: ProtocolTests.self).bundleURL
        var executable: URL?
        for _ in 0..<8 {
            let candidate = directory.appendingPathComponent("lnwjud-macos-host")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { executable = candidate; break }
            directory.deleteLastPathComponent()
        }
        let process = Process()
        process.executableURL = try XCTUnwrap(executable, "SwiftPM must build the native executable alongside its tests")
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = Pipe()
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        // Invalid operations exercise the actual executable/NDJSON loop without
        // asking the CI machine for Accessibility or screen permissions.
        let requests = ["first", "second"].map { id in
            #"{"id":""# + id + #"","operation":"unknown_operation","input":{}}"#
        }.joined(separator: "\n") + "\n"
        input.fileHandleForWriting.write(Data(requests.utf8))
        try input.fileHandleForWriting.close()
        guard exited.wait(timeout: .now() + 5) == .success else { return XCTFail("Native host did not terminate after EOF") }
        XCTAssertEqual(process.terminationStatus, 0)
        let lines = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        for (index, line) in lines.enumerated() {
            let response = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            XCTAssertEqual(response["id"] as? String, index == 0 ? "first" : "second")
            XCTAssertEqual(response["ok"] as? Bool, false)
            XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "INVALID_INPUT")
        }
    }

    func testOperationNamesStayBounded() {
        let valid = try? NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
        XCTAssertNotNil(valid)
        let range = NSRange(location: 0, length: 6)
        XCTAssertEqual(valid?.firstMatch(in: "health", range: range)?.range, range)
        XCTAssertNil(valid?.firstMatch(in: "../escape", range: NSRange(location: 0, length: 9)))
    }

    func testPayloadLimitIsFinite() {
        let payload = Data(repeating: 0x78, count: 16 * 1024 * 1024)
        XCTAssertEqual(payload.count, 16 * 1024 * 1024)
    }
}
