import Foundation
import CryptoKit
import Darwin
import MacProcessOwnerSupport

struct MacProcessBinding: Codable, Equatable {
    let taskId: String
    let reservationId: String
    let attemptId: String
    let generation: Int
    let requestDigest: String
    let ownerClientId: String
    let ownerSessionId: String
    let workspaceId: String

    func validate() throws {
        guard generation > 0, generation <= Int(Int32.max),
              requestDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              UUID(uuidString: attemptId)?.uuidString.lowercased() == attemptId,
              [taskId, reservationId, ownerClientId, ownerSessionId, workspaceId].allSatisfy({
                  !$0.isEmpty && $0.utf8.count <= 512 && !$0.contains("\0")
              }) else { throw MacOwnerFailure("MACOS_ATTEMPT_BINDING_INVALID") }
    }
}

struct MacOwnedProcess: Codable, Hashable {
    let pid: Int32
    let version: UInt32
    var key: String { "\(pid):\(version)" }
}

enum MacOwnershipPhase: String, Codable { case prepared, launchIntent, running, terminal, aborted, unknown }

struct MacOwnershipAttempt: Codable {
    let binding: MacProcessBinding
    let uid: UInt32
    let bootId: String
    var operationDigest: String?
    var phase: MacOwnershipPhase
    var processes: Set<MacOwnedProcess>
    var root: MacOwnedProcess?
    var exitCode: Int?
    var outcome: String
    var reason: String?
    var deadline: Date?
}

struct MacOwnerFailure: Error {
    let reason: String
    init(_ reason: String) { self.reason = reason }
}

// The ledger accepts only kernel events. Request payloads cannot report a process exit.
final class MacProcessOwnershipLedger {
    private(set) var attempts: [String: MacOwnershipAttempt] = [:]
    private(set) var healthy = true
    private(set) var revision: UInt64 = 0
    private var sequence: UInt64?
    private var pendingLaunch: String?
    let bootId: String
    var hasSequenceBaseline: Bool { sequence != nil }

    init(bootId: String, restored: [MacOwnershipAttempt] = []) throws {
        guard UUID(uuidString: bootId) != nil else { throw MacOwnerFailure("MACOS_BOOT_ID_UNAVAILABLE") }
        self.bootId = bootId
        guard restored.count <= 4096 else { throw MacOwnerFailure("MACOS_JOURNAL_INVALID") }
        for var entry in restored {
            try entry.binding.validate()
            try Self.validateRestored(entry)
            guard attempts[entry.binding.attemptId] == nil else { throw MacOwnerFailure("MACOS_JOURNAL_CONFLICT") }
            if [.launchIntent, .running].contains(entry.phase) {
                entry.phase = .unknown
                entry.reason = "MACOS_MONITOR_RESTARTED"
            }
            attempts[entry.binding.attemptId] = entry
        }
    }

    func prepare(_ binding: MacProcessBinding, uid: UInt32) throws -> MacOwnershipAttempt {
        try binding.validate()
        if let entry = attempts[binding.attemptId] { try authorize(entry, binding, uid); return entry }
        guard healthy, attempts.count < 4096 else { throw MacOwnerFailure("MACOS_OWNER_UNAVAILABLE") }
        let entry = MacOwnershipAttempt(binding: binding, uid: uid, bootId: bootId, phase: .prepared,
            processes: [], outcome: "completed")
        attempts[binding.attemptId] = entry
        revision &+= 1
        return entry
    }

    func begin(_ binding: MacProcessBinding, uid: UInt32, digest: String, timeout: TimeInterval) throws -> MacOwnershipAttempt {
        var entry = try inspect(binding, uid: uid)
        if let previous = entry.operationDigest, previous != digest { throw MacOwnerFailure("MACOS_OPERATION_CONFLICT") }
        guard entry.phase == .prepared else { return entry }
        guard healthy, pendingLaunch == nil else { throw MacOwnerFailure("MACOS_OWNER_UNAVAILABLE") }
        entry.operationDigest = digest
        entry.phase = .launchIntent
        entry.deadline = Date().addingTimeInterval(timeout)
        attempts[binding.attemptId] = entry
        pendingLaunch = binding.attemptId
        revision &+= 1
        return entry
    }

    func didResume(_ binding: MacProcessBinding, uid: UInt32, pid: Int32) throws {
        var entry = try inspect(binding, uid: uid)
        guard healthy, pendingLaunch == binding.attemptId, entry.phase == .launchIntent,
              entry.root?.pid == pid, entry.processes.count == 1 else { throw MacOwnerFailure("MACOS_ROOT_OBSERVATION_UNAVAILABLE") }
        entry.phase = .running
        attempts[binding.attemptId] = entry
        pendingLaunch = nil
        revision &+= 1
    }

    func bindStoppedRoot(_ binding: MacProcessBinding, uid: UInt32, process: MacOwnedProcess) throws {
        var entry = try inspect(binding, uid: uid)
        guard entry.phase == .launchIntent, pendingLaunch == binding.attemptId, process.pid > 1, process.version > 0,
              entry.root == nil || entry.root == process else { throw MacOwnerFailure("MACOS_ROOT_OBSERVATION_UNAVAILABLE") }
        entry.root = process
        entry.processes.insert(process)
        attempts[binding.attemptId] = entry
        revision &+= 1
    }

    func abort(_ binding: MacProcessBinding, uid: UInt32, stoppedChildReaped: Bool = false) throws -> MacOwnershipAttempt {
        var entry = try inspect(binding, uid: uid)
        guard entry.phase == .prepared || stoppedChildReaped && pendingLaunch == binding.attemptId
            && [.launchIntent, .unknown].contains(entry.phase) else { return entry }
        entry.phase = .aborted
        entry.processes.removeAll()
        entry.reason = nil
        attempts[binding.attemptId] = entry
        if pendingLaunch == binding.attemptId { pendingLaunch = nil }
        revision &+= 1
        return entry
    }

    func inspect(_ binding: MacProcessBinding, uid: UInt32) throws -> MacOwnershipAttempt {
        guard let entry = attempts[binding.attemptId] else { throw MacOwnerFailure("MACOS_ATTEMPT_UNKNOWN") }
        try authorize(entry, binding, uid)
        return entry
    }

    func recoverAfterBoot(_ binding: MacProcessBinding, uid: UInt32) throws -> MacOwnershipAttempt {
        var entry = try inspect(binding, uid: uid)
        guard entry.bootId != bootId else { return entry }
        if entry.phase == .prepared { entry.phase = .aborted }
        else if ![.aborted, .terminal].contains(entry.phase) {
            entry.phase = .terminal
            entry.exitCode = 125
            entry.outcome = "interrupted"
        }
        entry.processes.removeAll()
        entry.reason = nil
        attempts[binding.attemptId] = entry
        revision &+= 1
        return entry
    }

    func requestCancellation(_ binding: MacProcessBinding, uid: UInt32, timedOut: Bool = false) throws -> MacOwnershipAttempt {
        var entry = try inspect(binding, uid: uid)
        if [.running, .launchIntent, .unknown].contains(entry.phase) {
            entry.outcome = timedOut ? "timed_out" : "cancelled"
            attempts[binding.attemptId] = entry
            revision &+= 1
        }
        return entry
    }

    func hold(_ reason: String) {
        if healthy { revision &+= 1 }
        healthy = false
        for id in Array(attempts.keys) {
            guard var entry = attempts[id], [.running, .launchIntent].contains(entry.phase) else { continue }
            entry.phase = .unknown
            entry.reason = reason
            attempts[id] = entry
        }
    }

    func consume(_ event: LnwjudProcessEvent, daemonPid: Int32) -> Bool {
        if event.sequenced == 0 || sequence.map({ $0 == UInt64.max || event.sequence != $0 + 1 }) == true {
            hold("MACOS_EVENT_STREAM_GAP")
        }
        sequence = event.sequence
        let process = MacOwnedProcess(pid: event.pid, version: event.pid_version)
        let owner = attempts.first(where: { $0.value.processes.contains(process) })?.key
        if event.kind == 1 {
            let child = MacOwnedProcess(pid: event.child_pid, version: event.child_version)
            guard child.pid > 1, child.version > 0 else { hold("MACOS_EVENT_IDENTITY_INVALID"); return true }
            if let id = owner, var entry = attempts[id] {
                guard entry.processes.count < 4096 else { hold("MACOS_PROCESS_LIMIT_EXCEEDED"); return true }
                entry.processes.insert(child)
                attempts[id] = entry
                revision &+= 1
            } else if event.pid == daemonPid, let id = pendingLaunch, var entry = attempts[id], entry.root == nil {
                entry.root = child
                entry.processes.insert(child)
                attempts[id] = entry
                revision &+= 1
            }
        } else if event.kind == 2, let id = owner, var entry = attempts[id] {
            entry.processes.remove(process)
            if process == entry.root { entry.exitCode = Int(event.exit_status) }
            if entry.processes.isEmpty, entry.exitCode != nil, entry.phase == .running, healthy {
                entry.phase = .terminal
                entry.reason = nil
            }
            attempts[id] = entry
            revision &+= 1
        } else if event.kind == 3, let id = owner, var entry = attempts[id] {
            guard healthy, event.effective_uid == entry.uid else {
                hold("MACOS_EXEC_IDENTITY_UNVERIFIED")
                return false
            }
            let target = MacOwnedProcess(pid: event.child_pid, version: event.child_version)
            guard target.pid == process.pid, target.version > 0 else { hold("MACOS_EVENT_IDENTITY_INVALID"); return false }
            entry.processes.remove(process)
            entry.processes.insert(target)
            if process == entry.root { entry.root = target }
            attempts[id] = entry
            revision &+= 1
        }
        return true
    }

    private func authorize(_ entry: MacOwnershipAttempt, _ binding: MacProcessBinding, _ uid: UInt32) throws {
        guard entry.binding == binding, entry.uid == uid else { throw MacOwnerFailure("MACOS_ATTEMPT_OWNER_MISMATCH") }
    }

    private static func validateRestored(_ entry: MacOwnershipAttempt) throws {
        let digestIsValid = entry.operationDigest.map {
            $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        } ?? true
        guard UUID(uuidString: entry.bootId) != nil, digestIsValid,
              entry.processes.count <= 4096,
              entry.processes.allSatisfy({ $0.pid > 1 && $0.version > 0 }),
              entry.root.map({ $0.pid > 1 && $0.version > 0 }) ?? true,
              ["completed", "cancelled", "timed_out", "interrupted"].contains(entry.outcome),
              entry.exitCode.map({ (-1...255).contains($0) }) ?? true,
              entry.deadline.map({ $0.timeIntervalSince1970.isFinite }) ?? true else {
            throw MacOwnerFailure("MACOS_JOURNAL_INVALID")
        }
        switch entry.phase {
        case .prepared:
            guard entry.operationDigest == nil, entry.root == nil, entry.processes.isEmpty,
                  entry.exitCode == nil, entry.deadline == nil else { throw MacOwnerFailure("MACOS_JOURNAL_INVALID") }
        case .aborted:
            guard entry.processes.isEmpty else { throw MacOwnerFailure("MACOS_JOURNAL_INVALID") }
        case .terminal:
            guard entry.processes.isEmpty, entry.exitCode != nil, entry.operationDigest != nil else {
                throw MacOwnerFailure("MACOS_JOURNAL_INVALID")
            }
        case .running:
            guard entry.root != nil, entry.operationDigest != nil, entry.deadline != nil else {
                throw MacOwnerFailure("MACOS_JOURNAL_INVALID")
            }
        case .launchIntent:
            guard entry.operationDigest != nil, entry.deadline != nil else { throw MacOwnerFailure("MACOS_JOURNAL_INVALID") }
        case .unknown: break
        }
    }
}
