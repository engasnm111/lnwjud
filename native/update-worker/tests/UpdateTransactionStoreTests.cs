using System.Diagnostics;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateWorker;

[SupportedOSPlatform("windows")]
internal static class UpdateTransactionStoreTests
{
    private static int assertions;
    private const string Installation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string PreviousDataId = "a1111111-1111-4111-8111-111111111111";
    private const string CandidateDataId = "b2222222-2222-4222-8222-222222222222";
    private const string OtherDataId = "c3333333-3333-4333-8333-333333333333";

    internal static int Run()
    {
        assertions = 0;
        var testDirectory = Path.Combine(Path.GetTempPath(), "lnwjud-update-transaction-tests-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(testDirectory, "state");
        try
        {
            var owner = WindowsStoreIO.CurrentOwner();
            var initial = SlotSelection.Create(Installation, 4, 1, "none", owner,
                Guid.NewGuid().ToString("D"), "A", Digest('a'), DataGeneration.Create(PreviousDataId, Digest('1')));
            var created = UpdateTransactionJournal.Create(initial, "none", owner,
                "request-1", "release-6-0-0", 1, Digest('e'), "6.0.0", Digest('b'),
                DataGeneration.Create(CandidateDataId, Digest('2')),
                new TunnelSnapshot(true, true, Digest('f')),
                Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));

            using (var store = new UpdateTransactionStore(root, Installation))
                store.InitializeSelection(initial);
            using (var store = new UpdateTransactionStore(root, Installation))
            {
                var enrolled = store.RecoverPublications();
                Check(enrolled.Selection == initial && enrolled.Transaction is null, "slot enrollment survives store reopen");
            }

            UpdateTransactionJournal ready;
            using (var store = new UpdateTransactionStore(root, Installation))
                ready = store.PersistTransaction(created, "none");
            Check(ready == created, "candidate-ready transaction is durably published");

            CrashAtBoundary(root, "quiesce-intent", "transaction-stage-flushed");
            using (var store = new UpdateTransactionStore(root, Installation))
            {
                var recovered = store.RecoverPublications();
                Check(recovered.Transaction?.Phase == UpdateTransactionPhase.QuiesceIntent,
                    "startup publishes a fully flushed transaction stage");
                Check(recovered.Selection == initial, "transaction-stage recovery leaves the prior slot selected");
            }

            CrashAtBoundary(root, "quiesced", "transaction-publication-readback");
            UpdateTransactionSnapshot snapshot;
            using (var store = new UpdateTransactionStore(root, Installation)) snapshot = store.RecoverPublications();
            Check(snapshot.Transaction?.Phase == UpdateTransactionPhase.Quiesced,
                "startup accepts the exact transaction atomically published before a crash");

            var tunnelIntent = PersistAdvance(root, snapshot.Transaction!, UpdateTransactionPhase.TunnelStopIntent, owner);
            var tunnelStopped = PersistAdvance(root, tunnelIntent, UpdateTransactionPhase.TunnelStopped, owner);
            var selectionIntent = PersistAdvance(root, tunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent, owner);
            ExpectRefusal(() =>
            {
                using var store = new UpdateTransactionStore(root, Installation);
                var premature = selectionIntent.Advance(UpdateTransactionPhase.CandidateSelected, selectionIntent.Digest, owner);
                _ = store.PersistTransaction(premature, selectionIntent.Digest);
            }, "UPDATE_SLOT_SELECTION_PHASE_CONFLICT", "candidate cannot become startable before the candidate slot is durably selected");
            CrashAtBoundary(root, "select-candidate", "active-slot-stage-flushed");
            using (var store = new UpdateTransactionStore(root, Installation)) snapshot = store.RecoverPublications();
            Check(snapshot.Transaction?.Phase == UpdateTransactionPhase.CandidateSelected,
                "startup reconciles candidate selection after a stage-flush crash");
            Check(snapshot.Selection?.Slot == "B" && snapshot.Selection.SlotDigest == Digest('b')
                && snapshot.Selection.DataGeneration == created.CandidateDataGeneration,
                "candidate selection publishes the exact inactive application and data generation");

            var rollbackIntent = PersistAdvance(root, snapshot.Transaction!, UpdateTransactionPhase.RollbackIntent, owner);
            _ = PersistAdvance(root, rollbackIntent, UpdateTransactionPhase.PreviousSelectionIntent, owner);
            CrashAtBoundary(root, "select-previous", "active-slot-publication-readback");
            using (var store = new UpdateTransactionStore(root, Installation)) snapshot = store.RecoverPublications();
            Check(snapshot.Transaction?.Phase == UpdateTransactionPhase.PreviousSelected,
                "startup reconciles rollback selection after atomic publication");
            Check(snapshot.Selection?.Slot == "A" && snapshot.Selection.SlotDigest == Digest('a')
                && snapshot.Selection.DataGeneration == initial.DataGeneration,
                "rollback restores the exact prior application and data generation");
            Check(!snapshot.Transaction!.SafeToStart, "prior slot remains gated until rollback health is verified");

            var previousLaunch = PersistAdvance(root, snapshot.Transaction!, UpdateTransactionPhase.PreviousLaunchIntent, owner);
            var previousStarted = PersistAdvance(root, previousLaunch, UpdateTransactionPhase.PreviousStarted, owner);
            var rollbackUnverified = PersistAdvance(root, previousStarted, UpdateTransactionPhase.RollbackUnverified, owner);
            Check(!rollbackUnverified.SafeToStart, "unverified rollback remains non-startable");
            using (var store = new UpdateTransactionStore(root, Installation))
            {
                snapshot = store.RecoverPublications();
                Check(snapshot.Transaction == rollbackUnverified && snapshot.Selection?.Slot == "A",
                    "unverified rollback hold survives store reopen");
                var next = UpdateTransactionJournal.Create(snapshot.Selection!, rollbackUnverified.Digest, owner,
                    "request-2", "release-6-0-1", 1, Digest('e'), "6.0.1", Digest('c'),
                    DataGeneration.Create(OtherDataId, Digest('3')),
                    new TunnelSnapshot(true, true, Digest('f')), Guid.NewGuid().ToString("D"),
                    Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
                ExpectRefusal(() => store.PersistTransaction(next, rollbackUnverified.Digest),
                    "UPDATE_TRANSACTION_SUCCESSOR_INVALID", "held rollback cannot admit another update");
            }

            ExpectRefusal(() =>
            {
                using var store = new UpdateTransactionStore(root, Installation);
                _ = store.PersistTransaction(rollbackUnverified, "none");
            }, "UPDATE_TRANSACTION_CAS_CONFLICT", "stale transaction writer cannot replace a newer record");
            RejectCorruptTransactionSuccessors(testDirectory, owner);
            RejectCrossedSelections(testDirectory, owner);
            RecoverPairedSelectionPublications(testDirectory, owner);
            return assertions;
        }
        finally
        {
            try { if (Directory.Exists(testDirectory)) Directory.Delete(testDirectory, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void RejectCorruptTransactionSuccessors(string testDirectory, ProcessOwner owner)
    {
        foreach (var field in new[] { "previous-identity", "previous-manifest", "candidate-identity", "candidate-manifest" })
        {
            var root = Path.Combine(testDirectory, "transaction-" + field);
            var initial = InitialSelection(owner);
            var created = CreateTransaction(initial, owner);
            using (var store = new UpdateTransactionStore(root, Installation))
            {
                store.InitializeSelection(initial);
                if (field.StartsWith("previous", StringComparison.Ordinal))
                {
                    var invalidInitial = ChangeDataGeneration(created, field);
                    ExpectRefusal(() => store.PersistTransaction(invalidInitial, "none"),
                        "UPDATE_TRANSACTION_SUCCESSOR_INVALID", "first transaction rejects a crossed predecessor " + field);
                    Check(store.ReadTransaction() is null && store.ReadSelection() == initial,
                        "invalid first transaction leaves the paired predecessor enrolled");
                }
                _ = store.PersistTransaction(created, "none");
                var successor = created.Advance(UpdateTransactionPhase.QuiesceIntent, created.Digest, owner);
                var corrupt = ChangeDataGeneration(successor, field);
                ExpectRefusal(() => store.PersistTransaction(corrupt, created.Digest),
                    "UPDATE_TRANSACTION_SUCCESSOR_INVALID", "transaction successor cannot change a bound " + field);
                Check(store.ReadTransaction() == created, "corrupt successor preserves the published journal");
            }

            var staged = ChangeDataGeneration(created.Advance(UpdateTransactionPhase.QuiesceIntent, created.Digest, owner), field);
            using (var io = new WindowsStoreIO(root)) io.Stage("transaction.pending.json", staged.Encode());
            var publishedBytes = File.ReadAllBytes(Path.Combine(root, "transaction.json"));
            var pendingBytes = File.ReadAllBytes(Path.Combine(root, "transaction.pending.json"));
            var selectionBytes = File.ReadAllBytes(Path.Combine(root, "active-slot.json"));
            using (var store = new UpdateTransactionStore(root, Installation))
                ExpectRefusal(() => store.RecoverPublications(), "UPDATE_TRANSACTION_SUCCESSOR_INVALID",
                    "interrupted journal publication rejects a corrupt " + field);
            Check(File.ReadAllBytes(Path.Combine(root, "transaction.json")).SequenceEqual(publishedBytes)
                && File.ReadAllBytes(Path.Combine(root, "transaction.pending.json")).SequenceEqual(pendingBytes)
                && File.ReadAllBytes(Path.Combine(root, "active-slot.json")).SequenceEqual(selectionBytes),
                "recovery preserves all bytes when a data-bound journal successor is corrupt");
        }
    }

    private static UpdateTransactionJournal ChangeDataGeneration(UpdateTransactionJournal transaction, string field) => field switch
    {
        "previous-identity" => transaction with
        {
            PreviousDataGeneration = DataGeneration.Create(OtherDataId, transaction.PreviousDataGeneration.ManifestDigest),
        },
        "previous-manifest" => transaction with { PreviousDataGeneration = DataGeneration.Create(PreviousDataId, Digest('3')) },
        "candidate-identity" => transaction with
        {
            CandidateDataGeneration = DataGeneration.Create(OtherDataId, transaction.CandidateDataGeneration.ManifestDigest),
        },
        "candidate-manifest" => transaction with { CandidateDataGeneration = DataGeneration.Create(CandidateDataId, Digest('3')) },
        _ => throw new Exception("invalid data generation fixture"),
    };

    private static void RejectCrossedSelections(string testDirectory, ProcessOwner owner)
    {
        foreach (var rollback in new[] { false, true })
        foreach (var published in new[] { false, true })
        foreach (var changedManifest in new[] { false, true })
        {
            var name = $"selection-{rollback}-{published}-{changedManifest}";
            var root = Path.Combine(testDirectory, name);
            var fixture = PrepareSelectionIntent(root, owner, rollback);
            var expected = rollback
                ? fixture.Selection.SelectPrevious(fixture.Transaction, fixture.Selection.Digest, owner)
                : fixture.Selection.SelectCandidate(fixture.Transaction, fixture.Selection.Digest, owner);
            var otherData = rollback ? fixture.Transaction.CandidateDataGeneration : fixture.Transaction.PreviousDataGeneration;
            var crossed = expected with
            {
                DataGeneration = changedManifest ? DataGeneration.Create(expected.DataGeneration.Id, Digest('3')) : otherData,
            };
            var transactionBytes = File.ReadAllBytes(Path.Combine(root, "transaction.json"));
            var selectionBytes = File.ReadAllBytes(Path.Combine(root, "active-slot.json"));
            using (var io = new WindowsStoreIO(root))
            {
                io.Stage("active-slot.pending.json", crossed.Encode());
                if (published) io.PublishStage("active-slot.pending.json", "active-slot.json", fixture.Selection.Digest);
            }
            var expectedReason = published ? "UPDATE_SLOT_SELECTION_PHASE_CONFLICT" : "UPDATE_SLOT_PUBLICATION_UNVERIFIED";
            using (var store = new UpdateTransactionStore(root, Installation))
                ExpectRefusal(() => store.RecoverPublications(), expectedReason,
                    "selection recovery rejects a mixed application and data pair " + name);
            Check(File.ReadAllBytes(Path.Combine(root, "transaction.json")).SequenceEqual(transactionBytes),
                "crossed selection cannot advance its journal " + name);
            Check(File.ReadAllBytes(Path.Combine(root, "active-slot.json")).SequenceEqual(published ? crossed.Encode() : selectionBytes),
                "crossed selection recovery does not rewrite the published descriptor " + name);
            if (!published)
                Check(File.ReadAllBytes(Path.Combine(root, "active-slot.pending.json")).SequenceEqual(crossed.Encode()),
                    "crossed selection retains its refused publication for attended recovery " + name);
        }
    }

    private static void RecoverPairedSelectionPublications(string testDirectory, ProcessOwner owner)
    {
        foreach (var rollback in new[] { false, true })
        {
            var root = Path.Combine(testDirectory, "paired-crash-" + rollback);
            var fixture = PrepareSelectionIntent(root, owner, rollback);
            var boundary = rollback ? "active-slot-stage-flushed" : "active-slot-publication-readback";
            CrashAtBoundary(root, rollback ? "select-previous" : "select-candidate", boundary);
            var selectionBytes = File.ReadAllBytes(Path.Combine(root, rollback ? "active-slot.pending.json" : "active-slot.json"));
            var selected = SlotSelection.Decode(selectionBytes, Installation);
            using (var store = new UpdateTransactionStore(root, Installation))
            {
                if (!rollback)
                {
                    var repeated = store.SelectCandidate(fixture.Transaction, fixture.Transaction.Digest, selected.Digest, owner);
                    Check(repeated == selected && !File.Exists(Path.Combine(root, "active-slot.pending.json")),
                        "lost candidate publication reply retries the exact pair without publishing it again");
                }
                var recovered = store.RecoverPublications();
                Check(recovered.Selection == selected && recovered.Selection.DataGeneration ==
                    (rollback ? fixture.Transaction.PreviousDataGeneration : fixture.Transaction.CandidateDataGeneration),
                    "crash recovery publishes the exact application and data descriptor");
                Check(recovered.Transaction?.Phase == (rollback ? UpdateTransactionPhase.PreviousSelected : UpdateTransactionPhase.CandidateSelected)
                    && recovered.Transaction.PreviousDataGeneration == fixture.Transaction.PreviousDataGeneration
                    && recovered.Transaction.CandidateDataGeneration == fixture.Transaction.CandidateDataGeneration
                    && !recovered.Transaction.SafeToStart,
                    "crash recovery retains both data generations and holds admission for native evidence");
                var recoveredJournal = File.ReadAllBytes(Path.Combine(root, "transaction.json"));
                var repeatedRecovery = store.RecoverPublications();
                Check(repeatedRecovery == recovered
                    && File.ReadAllBytes(Path.Combine(root, "transaction.json")).SequenceEqual(recoveredJournal)
                    && File.ReadAllBytes(Path.Combine(root, "active-slot.json")).SequenceEqual(selectionBytes),
                    "repeated paired publication recovery is byte-for-byte idempotent");
            }
        }
    }

    private static (UpdateTransactionJournal Transaction, SlotSelection Selection) PrepareSelectionIntent(
        string root, ProcessOwner owner, bool rollback)
    {
        using var store = new UpdateTransactionStore(root, Installation);
        var selection = InitialSelection(owner);
        store.InitializeSelection(selection);
        var current = store.PersistTransaction(CreateTransaction(selection, owner), "none");
        foreach (var phase in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced,
            UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent })
            current = store.PersistTransaction(current.Advance(phase, current.Digest, owner), current.Digest);
        if (rollback)
        {
            selection = store.SelectCandidate(current, current.Digest, selection.Digest, owner);
            foreach (var phase in new[] { UpdateTransactionPhase.CandidateSelected, UpdateTransactionPhase.RollbackIntent,
                UpdateTransactionPhase.PreviousSelectionIntent })
                current = store.PersistTransaction(current.Advance(phase, current.Digest, owner), current.Digest);
        }
        return (current, selection);
    }

    private static SlotSelection InitialSelection(ProcessOwner owner) => SlotSelection.Create(Installation, 4, 1, "none", owner,
        "d4444444-4444-4444-8444-444444444444", "A", Digest('a'), DataGeneration.Create(PreviousDataId, Digest('1')));

    private static UpdateTransactionJournal CreateTransaction(SlotSelection initial, ProcessOwner owner) =>
        UpdateTransactionJournal.Create(initial, "none", owner, "request-1", "release-6-0-0", 1, Digest('e'), "6.0.0", Digest('b'),
            DataGeneration.Create(CandidateDataId, Digest('2')), new TunnelSnapshot(true, true, Digest('f')),
            "e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777");

    private static UpdateTransactionJournal PersistAdvance(string root, UpdateTransactionJournal current,
        UpdateTransactionPhase next, ProcessOwner owner)
    {
        using var store = new UpdateTransactionStore(root, Installation);
        return store.PersistTransaction(current.Advance(next, current.Digest, owner), current.Digest);
    }

    private static void CrashAtBoundary(string root, string action, string expectedBoundary)
    {
        assertions++;
        var executable = Environment.ProcessPath ?? throw new Exception("test process path unavailable");
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in new[] { "transaction-crash-child", root, action, expectedBoundary })
            start.ArgumentList.Add(argument);
        using var child = Process.Start(start) ?? throw new Exception("transaction crash child failed to start");
        var stderr = child.StandardError.ReadToEndAsync();
        var boundary = child.StandardOutput.ReadLineAsync();
        if (!boundary.Wait(TimeSpan.FromSeconds(15)))
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
            child.WaitForExit();
            throw new Exception($"transaction child did not reach {expectedBoundary}: {stderr.GetAwaiter().GetResult()}");
        }
        var observed = boundary.GetAwaiter().GetResult();
        if (observed != "BOUNDARY")
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
            child.WaitForExit();
            throw new Exception($"transaction child reached unexpected boundary '{observed}': {stderr.GetAwaiter().GetResult()}");
        }
        child.Kill(entireProcessTree: true);
        if (!child.WaitForExit(15_000)) throw new Exception("transaction child did not terminate after forced kill");
        _ = stderr.GetAwaiter().GetResult();
    }

    private static string Digest(char value) => new(value, 64);

    private static void Check(bool condition, string message)
    {
        assertions++;
        if (!condition) throw new Exception(message);
    }

    private static void ExpectRefusal(Action action, string reason, string message)
    {
        assertions++;
        try { action(); }
        catch (Refusal refusal) when (refusal.Reason == reason) { return; }
        throw new Exception(message);
    }
}
