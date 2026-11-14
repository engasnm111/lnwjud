import Foundation
import CryptoKit
import CoreFoundation
import Darwin
import MacProcessOwnerSupport

private let macOwnerRoot = "/Library/Application Support/lnwjud/process-owner"
private let macOwnerMaximumFrame = 2 * 1024 * 1024

private final class MacOwnerOutput {
    var output = Data()
    var error = Data()
    var outputTruncated = false
    var errorTruncated = false
    var outputClosed = false
    var errorClosed = false
    let limit: Int
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    init(limit: Int) { self.limit = limit }
}

final class MacProcessOwnerDaemon {
    private let condition = NSCondition()
    private let ledger: MacProcessOwnershipLedger
    private let privateKey: Curve25519.Signing.PrivateKey
    private let requirement: String
    private var output: [String: MacOwnerOutput] = [:]
    private var publicationFailed = false
    private var resumedRoots: Set<Int32> = []
    private let lockDescriptor: Int32

    private init() throws {
        guard geteuid() == 0 else { throw MacOwnerFailure("MACOS_OWNER_ROOT_REQUIRED") }
        guard lnwjud_owner_disable_core_dumps() == 0 else { throw MacOwnerFailure("MACOS_OWNER_MEMORY_PROTECTION_UNAVAILABLE") }
        umask(0o077)
        try Self.protectedDirectory(macOwnerRoot)
        try Self.protectedDirectory(macOwnerRoot + "/private")
        lockDescriptor = (macOwnerRoot + "/private/owner.lock").withCString { lnwjud_owner_lock($0) }
        guard lockDescriptor >= 0 else { throw MacOwnerFailure("MACOS_OWNER_ALREADY_RUNNING") }
        let requirementData = try Self.protectedFile(macOwnerRoot + "/host-requirement.txt", maximum: 16_384)
        guard let requirement = String(data: requirementData, encoding: .utf8), requirement.contains("identifier"),
              requirement.contains("anchor"), requirement.contains("certificate"), !requirement.contains("\0") else {
            throw MacOwnerFailure("MACOS_HOST_ENROLLMENT_REQUIRED")
        }
        self.requirement = requirement.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyPath = macOwnerRoot + "/private/signing.key"
        if FileManager.default.fileExists(atPath: keyPath) {
            privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: Self.protectedFile(keyPath, maximum: 32))
        } else {
            let key = Curve25519.Signing.PrivateKey()
            try key.rawRepresentation.write(to: URL(fileURLWithPath: keyPath), options: .withoutOverwriting)
            privateKey = key
        }
        let publicPath = macOwnerRoot + "/public.key"
        let publicBytes = privateKey.publicKey.rawRepresentation
        if FileManager.default.fileExists(atPath: publicPath) {
            guard try Self.protectedFile(publicPath, maximum: 32) == publicBytes else {
                throw MacOwnerFailure("MACOS_OWNER_KEY_MISMATCH")
            }
        } else {
            try publicBytes.write(to: URL(fileURLWithPath: publicPath), options: .withoutOverwriting)
            guard chmod(publicPath, 0o644) == 0 else { throw MacOwnerFailure("MACOS_OWNER_PUBLIC_KEY_UNAVAILABLE") }
        }
        var boot = [CChar](repeating: 0, count: 128)
        guard lnwjud_owner_boot_id(&boot, boot.count) == 0 else { throw MacOwnerFailure("MACOS_BOOT_ID_UNAVAILABLE") }
        let previous: [MacOwnershipAttempt]
        let journalPath = macOwnerRoot + "/private/journal.json"
        if FileManager.default.fileExists(atPath: journalPath) {
            previous = try JSONDecoder().decode([MacOwnershipAttempt].self,
                from: Self.protectedFile(journalPath, maximum: 16 * 1024 * 1024))
        } else { previous = [] }
        ledger = try MacProcessOwnershipLedger(bootId: String(cString: boot), restored: previous)
        try persist()
    }

    static func run() -> Int32 {
        do {
            signal(SIGCHLD, SIG_DFL)
            let owner = try MacProcessOwnerDaemon()
            let context = Unmanaged.passUnretained(owner).toOpaque()
            let monitor = lnwjud_owner_monitor_start(context, { context, event in
                guard let context, let event else { return 0 }
                return Unmanaged<MacProcessOwnerDaemon>.fromOpaque(context).takeUnretainedValue().consume(event.pointee) ? 1 : 0
            })
            guard monitor == 0 else { throw MacOwnerFailure("MACOS_ENDPOINT_SECURITY_ENROLLMENT_REQUIRED") }
            _ = lnwjud_owner_probe()
            owner.condition.lock()
            let barrierDeadline = Date().addingTimeInterval(5)
            while !owner.ledger.hasSequenceBaseline && Date() < barrierDeadline { owner.condition.wait(until: barrierDeadline) }
            let observedStream = owner.ledger.hasSequenceBaseline && owner.ledger.healthy
            owner.condition.unlock()
            guard observedStream else { throw MacOwnerFailure("MACOS_EVENT_STREAM_BARRIER_UNAVAILABLE") }
            let listener = (macOwnerRoot + "/owner.sock").withCString { lnwjud_owner_listen($0) }
            guard listener >= 0 else { throw MacOwnerFailure("MACOS_OWNER_SOCKET_UNAVAILABLE") }
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
            timer.setEventHandler { owner.enforceDeadlines() }
            timer.resume()
            while true {
                var uid: UInt32 = 0, gid: UInt32 = 0
                let connection = owner.requirement.withCString { lnwjud_owner_accept(listener, &uid, &gid, $0) }
                guard connection >= 0 else { continue }
                owner.serve(connection, uid: uid, gid: gid)
                close(connection)
            }
        } catch {
            let reason = (error as? MacOwnerFailure)?.reason ?? "MACOS_OWNER_ENROLLMENT_UNAVAILABLE"
            FileHandle.standardError.write(Data((reason + "\n").utf8))
            return 125
        }
    }

    private func serve(_ descriptor: Int32, uid: UInt32, gid: UInt32) {
        do {
            let bytes = try readFrame(descriptor)
            guard let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  Self.integer(request["protocol"]) == 1, let nonce = request["nonce"] as? String,
                  UUID(uuidString: nonce)?.uuidString.lowercased() == nonce,
                  let command = request["command"] as? String,
                  Set(request.keys).isSubset(of: ["protocol", "nonce", "command", "binding", "operation", "cursor"]) else {
                throw MacOwnerFailure("MACOS_OWNER_REQUEST_INVALID")
            }
            let result: [String: Any]
            do { result = try execute(command, request: request, uid: uid, gid: gid) }
            catch { result = ["state": "error", "reason": (error as? MacOwnerFailure)?.reason ?? "MACOS_OWNER_REQUEST_UNAVAILABLE"] }
            let body: [String: Any] = ["protocol": 1, "nonce": nonce, "requestDigest": Self.digest(bytes), "uid": uid,
                "bootId": ledger.bootId, "result": result]
            let payload = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
            let reply: [String: Any] = ["payload": payload.base64EncodedString(),
                "signature": try privateKey.signature(for: payload).base64EncodedString()]
            var frame = try JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys, .withoutEscapingSlashes])
            frame.append(0x0a)
            try writeFrame(descriptor, frame)
        } catch { }
    }

    private func execute(_ command: String, request: [String: Any], uid: UInt32, gid: UInt32) throws -> [String: Any] {
        if command == "health" {
            condition.lock(); defer { condition.unlock() }
            return ["state": ledger.healthy && !publicationFailed ? "available" : "unavailable",
                "contract": "lnwjud-macos-process-owner-v1", "bootId": ledger.bootId]
        }
        guard let bindingObject = request["binding"] as? [String: Any], bindingObject.count == 8 else {
            throw MacOwnerFailure("MACOS_ATTEMPT_BINDING_INVALID")
        }
        let binding = try JSONDecoder().decode(MacProcessBinding.self, from: JSONSerialization.data(withJSONObject: bindingObject))
        try binding.validate()
        if command == "run" { return try launch(binding, request: request, uid: uid, gid: gid) }
        condition.lock(); defer { condition.unlock() }
        guard !publicationFailed else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
        var entry: MacOwnershipAttempt
        switch command {
        case "prepare": entry = try ledger.prepare(binding, uid: uid)
        case "inspect": entry = try ledger.inspect(binding, uid: uid)
        case "recover_after_reboot": entry = try ledger.recoverAfterBoot(binding, uid: uid)
        case "abort": entry = try ledger.abort(binding, uid: uid)
        case "cancel":
            let current = try ledger.inspect(binding, uid: uid)
            if current.phase == .prepared { entry = try ledger.abort(binding, uid: uid) }
            else { entry = try ledger.requestCancellation(binding, uid: uid) }
            for process in entry.processes { _ = lnwjud_owner_terminate(process.pid, process.version) }
        case "read_output":
            let observed = try ledger.inspect(binding, uid: uid)
            return try readOutput(observed, cursor: request["cursor"] as? [String: Any])
        default: throw MacOwnerFailure("MACOS_OWNER_COMMAND_INVALID")
        }
        try persist()
        entry = try ledger.inspect(binding, uid: uid)
        return try observation(entry)
    }

    private func launch(_ binding: MacProcessBinding, request: [String: Any], uid: UInt32, gid: UInt32) throws -> [String: Any] {
        guard let operation = request["operation"] as? [String: Any],
              Set(operation.keys) == ["executable", "args", "cwd", "environment", "timeoutMs", "maximumOutputBytes"],
              let executable = operation["executable"] as? String, executable.hasPrefix("/"), !executable.contains("\0"),
              let arguments = operation["args"] as? [String], arguments.count <= 512,
              arguments.allSatisfy({ !$0.contains("\0") && $0.utf8.count <= 65_536 }),
              let cwd = operation["cwd"] as? String, cwd.hasPrefix("/"), !cwd.contains("\0"),
              let environment = operation["environment"] as? [String: String], environment.count <= 256,
              environment.allSatisfy({ !$0.key.isEmpty && !$0.key.contains("=") && !$0.key.contains("\0") && !$0.value.contains("\0") }),
              let timeout = Self.integer(operation["timeoutMs"]), timeout > 0, timeout <= 604_800_000,
              let maximumOutput = Self.integer(operation["maximumOutputBytes"]), maximumOutput >= 0, maximumOutput <= 512 * 1024 else {
            throw MacOwnerFailure("MACOS_PROCESS_OPERATION_INVALID")
        }
        let digest = Self.digest(try JSONSerialization.data(withJSONObject: operation, options: [.sortedKeys, .withoutEscapingSlashes]))
        condition.lock()
        do {
            guard !publicationFailed else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
            let current = try ledger.inspect(binding, uid: uid)
            if current.phase == .prepared && output.count >= 64 { throw MacOwnerFailure("MACOS_ACTIVE_PROCESS_LIMIT") }
            let prepared = try ledger.begin(binding, uid: uid, digest: digest, timeout: Double(timeout) / 1000)
            guard prepared.phase == .launchIntent else { let result = try observation(prepared); condition.unlock(); return result }
            try persist()
            let stream = MacOwnerOutput(limit: maximumOutput)
            output[binding.attemptId] = stream
            configureOutput(stream, id: binding.attemptId)
            condition.unlock()
            var pidVersion: UInt32 = 0
            let pid = try withStrings([executable] + arguments) { argv in
                try withStrings(environment.sorted(by: { $0.key < $1.key }).map({ "\($0.key)=\($0.value)" })) { env in
                    executable.withCString { file in cwd.withCString { directory in
                        lnwjud_owner_spawn_stopped(file, argv, env, directory, uid, gid,
                            stream.outputPipe.fileHandleForWriting.fileDescriptor, stream.errorPipe.fileHandleForWriting.fileDescriptor, &pidVersion)
                    } }
                }
            }
            try? stream.outputPipe.fileHandleForWriting.close()
            try? stream.errorPipe.fileHandleForWriting.close()
            condition.lock()
            guard pid > 1 else { ledger.hold("MACOS_SPAWN_OUTCOME_UNKNOWN"); try persist(); throw MacOwnerFailure("MACOS_SPAWN_OUTCOME_UNKNOWN") }
            var bound = false
            do { try ledger.bindStoppedRoot(binding, uid: uid, process: MacOwnedProcess(pid: pid, version: pidVersion)); bound = true } catch { }
            if !bound || !ledger.healthy || ledger.attempts[binding.attemptId]?.root?.pid != pid {
                condition.unlock()
                let reaped = lnwjud_owner_abort_stopped_child(pid) == 0
                condition.lock()
                _ = try ledger.abort(binding, uid: uid, stoppedChildReaped: reaped)
                try persist()
                let result = try observation(ledger.inspect(binding, uid: uid))
                condition.unlock()
                return result
            }
            // Keep the child unreaped until SIGCONT has targeted this exact native child.
            resumedRoots.insert(pid)
            let resumed = lnwjud_owner_resume_child(pid)
            if resumed != 0 { ledger.hold("MACOS_RESUME_OUTCOME_UNKNOWN") }
            else { try ledger.didResume(binding, uid: uid, pid: pid) }
            try persist()
            let result = try observation(ledger.inspect(binding, uid: uid))
            condition.unlock()
            return result
        } catch {
            condition.unlock()
            throw error
        }
    }

    private func consume(_ event: LnwjudProcessEvent) -> Bool {
        condition.lock(); defer { condition.unlock() }
        let wasOwned = ledger.attempts.values.contains { $0.processes.contains(MacOwnedProcess(pid: event.pid, version: event.pid_version)) }
        let previousRevision = ledger.revision
        let allowed = ledger.consume(event, daemonPid: getpid())
        if event.kind == 1 {
            let child = MacOwnedProcess(pid: event.child_pid, version: event.child_version)
            if ledger.attempts.values.contains(where: {
                $0.processes.contains(child) && ["cancelled", "timed_out"].contains($0.outcome)
            }) { _ = lnwjud_owner_terminate(child.pid, child.version) }
        }
        if ledger.revision != previousRevision {
            do { try persist() } catch { publicationFailed = true; ledger.hold("MACOS_JOURNAL_UNAVAILABLE") }
        }
        condition.broadcast()
        return allowed && !(publicationFailed && wasOwned)
    }

    private func enforceDeadlines() {
        condition.lock(); defer { condition.unlock() }
        let now = Date()
        let previousRevision = ledger.revision
        for pid in Array(resumedRoots) where lnwjud_owner_reap_child(pid) == 1 { resumedRoots.remove(pid) }
        for entry in ledger.attempts.values where entry.phase == .running && entry.outcome == "completed" && entry.deadline.map({ $0 <= now }) == true {
            guard let current = try? ledger.requestCancellation(entry.binding, uid: entry.uid, timedOut: true) else { continue }
            for process in current.processes { _ = lnwjud_owner_terminate(process.pid, process.version) }
        }
        if ledger.revision != previousRevision {
            do { try persist() } catch { publicationFailed = true; ledger.hold("MACOS_JOURNAL_UNAVAILABLE") }
        }
    }

    private func observation(_ entry: MacOwnershipAttempt) throws -> [String: Any] {
        let binding = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.binding))
        switch entry.phase {
        case .aborted: return ["state": "launch_not_started", "binding": binding]
        case .terminal: return ["state": "terminal_verified", "binding": binding, "activeProcesses": 0,
            "outcome": entry.outcome, "exitCode": entry.exitCode ?? -1]
        case .running:
            guard let root = entry.root else { throw MacOwnerFailure("MACOS_ROOT_OBSERVATION_UNAVAILABLE") }
            return ["state": "running", "binding": binding, "targetPid": root.pid]
        default: return ["state": "termination_unknown", "binding": binding,
            "reason": entry.reason ?? (entry.phase == .prepared ? "MACOS_ATTEMPT_PREPARED" : "MACOS_TERMINATION_UNVERIFIED")]
        }
    }

    private func configureOutput(_ stream: MacOwnerOutput, id: String) {
        for (isError, pipe) in [(false, stream.outputPipe), (true, stream.errorPipe)] {
            pipe.fileHandleForReading.readabilityHandler = { [weak self, weak stream] handle in
                let data = handle.availableData
                guard let self, let stream else { return }
                self.condition.lock(); defer { self.condition.unlock() }
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    if isError { stream.errorClosed = true } else { stream.outputClosed = true }
                    try? handle.close()
                } else {
                    let remaining = stream.limit - (isError ? stream.error.count : stream.output.count)
                    if isError { stream.error.append(data.prefix(max(0, remaining))); stream.errorTruncated = stream.errorTruncated || data.count > remaining }
                    else { stream.output.append(data.prefix(max(0, remaining))); stream.outputTruncated = stream.outputTruncated || data.count > remaining }
                }
                do {
                    try self.saveOutput(stream, id: id)
                    if stream.outputClosed && stream.errorClosed { self.output.removeValue(forKey: id) }
                } catch { self.publicationFailed = true; self.ledger.hold("MACOS_OUTPUT_PERSISTENCE_UNAVAILABLE") }
            }
        }
    }

    private func saveOutput(_ stream: MacOwnerOutput, id: String) throws {
        let bytes: [String: Any] = ["stdout": stream.output.base64EncodedString(), "stderr": stream.error.base64EncodedString(),
            "stdoutTruncated": stream.outputTruncated, "stderrTruncated": stream.errorTruncated,
            "complete": stream.outputClosed && stream.errorClosed]
        try durableWrite(JSONSerialization.data(withJSONObject: bytes), to: macOwnerRoot + "/private/" + id + ".output")
    }

    private func readOutput(_ entry: MacOwnershipAttempt, cursor: [String: Any]?) throws -> [String: Any] {
        let binding = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.binding))
        let bytes = try Self.protectedFile(macOwnerRoot + "/private/" + entry.binding.attemptId + ".output", maximum: 2 * 1024 * 1024)
        guard let stored = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let encodedOut = stored["stdout"] as? String, let stdout = Data(base64Encoded: encodedOut),
              let encodedError = stored["stderr"] as? String, let stderr = Data(base64Encoded: encodedError),
              let outOffset = Self.integer(cursor?["stdoutOffset"]), let errorOffset = Self.integer(cursor?["stderrOffset"]),
              outOffset >= 0, outOffset <= stdout.count, errorOffset >= 0, errorOffset <= stderr.count,
              let complete = stored["complete"] as? Bool else { throw MacOwnerFailure("MACOS_OUTPUT_CURSOR_INVALID") }
        let next: [String: Int] = ["stdoutOffset": stdout.count, "stderrOffset": stderr.count]
        return ["state": "available", "binding": binding, "stdout": stdout.dropFirst(outOffset).base64EncodedString(),
            "stderr": stderr.dropFirst(errorOffset).base64EncodedString(), "stdoutTruncated": stored["stdoutTruncated"] as? Bool ?? true,
            "stderrTruncated": stored["stderrTruncated"] as? Bool ?? true, "complete": complete, "nextCursor": next,
            "finalCursor": complete ? next as Any : NSNull(), "persistence": ["state": "persisted"]]
    }

    private func persist() throws {
        guard !publicationFailed else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
        do {
            let bytes = try JSONEncoder().encode(Array(ledger.attempts.values))
            try durableWrite(bytes, to: macOwnerRoot + "/private/journal.json")
        } catch {
            publicationFailed = true
            ledger.hold("MACOS_JOURNAL_UNAVAILABLE")
            throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE")
        }
    }

    private func durableWrite(_ bytes: Data, to file: String) throws {
        try bytes.write(to: URL(fileURLWithPath: file), options: .atomic)
        let descriptor = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
        let parent = open(macOwnerRoot + "/private", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
        defer { close(parent) }
        guard fsync(parent) == 0 else { throw MacOwnerFailure("MACOS_JOURNAL_UNAVAILABLE") }
    }

    private static func protectedDirectory(_ directory: String) throws {
        var current = URL(fileURLWithPath: directory, isDirectory: true)
        if !FileManager.default.fileExists(atPath: directory) {
            let parent = current.deletingLastPathComponent().path
            if parent != "/" { try protectedDirectory(parent) }
            guard mkdir(directory, directory.hasSuffix("/private") ? 0o700 : 0o755) == 0 else { throw MacOwnerFailure("MACOS_OWNER_DIRECTORY_UNAVAILABLE") }
        }
        while true {
            var info = stat()
            guard lstat(current.path, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
                  info.st_uid == 0, info.st_mode & 0o022 == 0,
                  !current.path.hasSuffix("/private") || info.st_mode & 0o077 == 0 else { throw MacOwnerFailure("MACOS_OWNER_DIRECTORY_UNTRUSTED") }
            if current.path == "/" { return }
            current.deleteLastPathComponent()
        }
    }

    private static func protectedFile(_ file: String, maximum: Int) throws -> Data {
        try protectedDirectory(URL(fileURLWithPath: file).deletingLastPathComponent().path)
        let fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw MacOwnerFailure("MACOS_OWNER_ENROLLMENT_MISSING") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_nlink == 1, info.st_mode & 0o022 == 0, info.st_size <= maximum else {
            throw MacOwnerFailure("MACOS_OWNER_FILE_UNTRUSTED")
        }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        guard data.count <= maximum else { throw MacOwnerFailure("MACOS_OWNER_FILE_TOO_LARGE") }
        return data
    }

    private func readFrame(_ fd: Int32) throws -> Data {
        var frame = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let count = read(fd, &chunk, chunk.count)
            guard count > 0 else { break }
            let bytes = chunk.prefix(count)
            if let newline = bytes.firstIndex(of: 0x0a) {
                guard newline == count - 1, frame.count + newline <= macOwnerMaximumFrame else { throw MacOwnerFailure("MACOS_OWNER_FRAME_INVALID") }
                frame.append(contentsOf: bytes.prefix(newline))
                return frame
            }
            guard frame.count + count <= macOwnerMaximumFrame else { throw MacOwnerFailure("MACOS_OWNER_FRAME_TOO_LARGE") }
            frame.append(contentsOf: bytes)
        }
        throw MacOwnerFailure("MACOS_OWNER_FRAME_UNAVAILABLE")
    }

    private func writeFrame(_ fd: Int32, _ data: Data) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard DispatchTime.now().uptimeNanoseconds < deadline else { throw MacOwnerFailure("MACOS_OWNER_REPLY_TIMEOUT") }
                let count = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw MacOwnerFailure("MACOS_OWNER_REPLY_UNAVAILABLE") }
                offset += count
            }
        }
    }

    private func withStrings<T>(_ values: [String], _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> T) rethrows -> T {
        var pointers = values.map { strdup($0) } + [nil]
        defer { for pointer in pointers { free(pointer) } }
        return try pointers.withUnsafeMutableBufferPointer { try body($0.baseAddress!) }
    }

    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue, abs(number.doubleValue) <= 9_007_199_254_740_991 else { return nil }
        return number.intValue
    }
}
