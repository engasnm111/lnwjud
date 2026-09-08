import Foundation

// Capture responses are bounded to 8 MiB before base64 encoding. Keep enough
// envelope headroom without allowing an unbounded native-host line.
private let maxPayloadBytes = 16 * 1024 * 1024

struct HostError: Encodable {
    let code: String
    let message: String
    let recoverable: Bool
}

struct HostResponse: Encodable {
    let id: String
    let ok: Bool
    let value: AnyEncodable?
    let error: HostError?
}

struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

private func writeResponse(_ response: HostResponse) {
    guard let data = try? JSONEncoder().encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func fail(_ id: String, _ code: String, _ message: String, recoverable: Bool = false) {
    writeResponse(HostResponse(id: id, ok: false, value: nil, error: HostError(code: code, message: String(message.prefix(2048)), recoverable: recoverable)))
}

private func run() {
    while let line = readLine(strippingNewline: true) {
        guard let bytes = line.data(using: .utf8), bytes.count <= maxPayloadBytes else {
            fail("unknown", "FILE_TOO_LARGE", "Native host request exceeds the payload limit")
            continue
        }
        guard let json = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else {
            fail("unknown", "INVALID_INPUT", "Native host request must be one JSON object")
            continue
        }
        let keys = Set(json.keys)
        guard keys.isSubset(of: ["id", "operation", "input", "authorization"]) else {
            fail("unknown", "INVALID_INPUT", "Native host request has an unknown field")
            continue
        }
        guard let id = json["id"] as? String else {
            fail("unknown", "INVALID_INPUT", "Native host request id must be a string")
            continue
        }
        guard !id.isEmpty,
              let operation = json["operation"] as? String,
              operation.range(of: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$", options: .regularExpression) != nil else {
            fail(id, "INVALID_INPUT", "Native host request has an invalid id, operation, or key")
            continue
        }
        let knownOperations = Set(["health", "accessibility", "input_event", "vision", "window", "audio", "screen_record", "office"])
        guard knownOperations.contains(operation) else {
            fail(id, "INVALID_INPUT", "Native host operation is not supported")
            continue
        }
        if operation == "health" {
            writeResponse(HostResponse(id: id, ok: true, value: AnyEncodable(MacNativeProviders.health()), error: nil))
        } else {
            let input: [String: Any]
            if let rawInput = json["input"] {
                guard let object = rawInput as? [String: Any] else {
                    fail(id, "INVALID_INPUT", "Native host provider input must be a JSON object")
                    continue
                }
                input = object
            } else {
                input = [:]
            }
            switch MacNativeProviders.execute(operation: operation, input: input) {
            case let .value(value):
                writeResponse(HostResponse(id: id, ok: true, value: AnyEncodable(value), error: nil))
            case let .failure(code, message, recoverable):
                fail(id, code, message, recoverable: recoverable)
            }
        }
    }
}

run()
