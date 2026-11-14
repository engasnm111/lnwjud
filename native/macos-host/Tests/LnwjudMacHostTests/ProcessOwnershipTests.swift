import XCTest
import MacProcessOwnerSupport
@testable import LnwjudMacHost

final class ProcessOwnershipTests: XCTestCase {
    private let boot = "dbaf7777-9d8f-428a-9dd7-20b810e46719"
    private func binding() -> MacProcessBinding {
        MacProcessBinding(taskId: "task", reservationId: "reservation", attemptId: "52f03b8f-71f7-469c-8ee8-81595525e758",
            generation: 1, requestDigest: String(repeating: "a", count: 64), ownerClientId: "client", ownerSessionId: "session", workspaceId: "workspace")
    }
    private func event(_ sequence: UInt64, _ kind: Int32, pid: Int32, version: UInt32 = 1,
        child: Int32 = 0, childVersion: UInt32 = 1, uid: UInt32 = 501, exit: Int32 = 0) -> LnwjudProcessEvent {
        LnwjudProcessEvent(sequence: sequence, sequenced: 1, kind: kind, pid: pid, pid_version: version,
            child_pid: child, child_version: childVersion, effective_uid: uid, exit_status: exit)
    }
    private func running() throws -> MacProcessOwnershipLedger {
        let ledger = try MacProcessOwnershipLedger(bootId: boot)
        _ = try ledger.prepare(binding(), uid: 501)
        _ = try ledger.begin(binding(), uid: 501, digest: String(repeating: "b", count: 64), timeout: 60)
        XCTAssertTrue(ledger.consume(event(1, 1, pid: 10, child: 20), daemonPid: 10))
        try ledger.didResume(binding(), uid: 501, pid: 20)
        return ledger
    }
    func testRootExitCannotReleaseAnEscapedDescendant() throws {
        let ledger = try running()
        _ = ledger.consume(event(2, 1, pid: 20, child: 30), daemonPid: 10)
        _ = ledger.consume(event(3, 2, pid: 20), daemonPid: 10)
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).phase, .running)
        _ = ledger.consume(event(4, 2, pid: 30), daemonPid: 10)
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).phase, .terminal)
    }
    func testGapIsPermanentEvenWhenAllKnownProcessesExit() throws {
        let ledger = try running()
        _ = ledger.consume(event(3, 2, pid: 20), daemonPid: 10)
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).phase, .unknown)
        XCTAssertFalse(ledger.healthy)
    }
    func testReusedPidCannotCompleteTheOriginalProcess() throws {
        let ledger = try running()
        _ = ledger.consume(event(2, 2, pid: 20, version: 2), daemonPid: 10)
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).phase, .running)
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).processes.count, 1)
    }
    func testRestartNeedsAnIndependentlyDifferentBootBeforeRecovery() throws {
        let original = try running()
        let sameBoot = try MacProcessOwnershipLedger(bootId: boot, restored: Array(original.attempts.values))
        XCTAssertEqual(try sameBoot.recoverAfterBoot(binding(), uid: 501).phase, .unknown)
        let nextBoot = try MacProcessOwnershipLedger(bootId: "5cd305cd-cc64-4708-a738-0c6ced665025", restored: Array(original.attempts.values))
        XCTAssertEqual(try nextBoot.recoverAfterBoot(binding(), uid: 501).outcome, "interrupted")
        XCTAssertEqual(try nextBoot.inspect(binding(), uid: 501).phase, .terminal)
    }
    func testUnregisteredAndCrossUserAbortCannotMintTerminalProof() throws {
        let ledger = try MacProcessOwnershipLedger(bootId: boot)
        XCTAssertThrowsError(try ledger.abort(binding(), uid: 501))
        _ = try ledger.prepare(binding(), uid: 501)
        XCTAssertThrowsError(try ledger.abort(binding(), uid: 502))
        XCTAssertEqual(try ledger.abort(binding(), uid: 501).phase, .aborted)
    }
    func testChangingTheOperationCannotReplayAnAttempt() throws {
        let ledger = try running()
        XCTAssertThrowsError(try ledger.begin(binding(), uid: 501, digest: String(repeating: "c", count: 64), timeout: 60))
    }
    func testPrivilegeChangingExecIsDeniedAndHeld() throws {
        let ledger = try running()
        XCTAssertFalse(ledger.consume(event(2, 3, pid: 20, child: 20, uid: 0), daemonPid: 10))
        XCTAssertEqual(try ledger.inspect(binding(), uid: 501).phase, .unknown)
    }
    func testCorruptTerminalJournalCannotMintZeroProof() throws {
        let ledger = try running()
        var entry = try ledger.inspect(binding(), uid: 501)
        entry.phase = .terminal
        entry.exitCode = 0
        XCTAssertThrowsError(try MacProcessOwnershipLedger(bootId: boot, restored: [entry]))
    }
}
