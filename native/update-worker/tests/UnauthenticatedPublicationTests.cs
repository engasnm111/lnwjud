using System.Runtime.Versioning;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

[SupportedOSPlatform("windows")]
internal static class UnauthenticatedPublicationTests
{
    private const string Installation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static int assertions;

    internal static int Run()
    {
        assertions = 0;
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-unverified-publication-" + Guid.NewGuid().ToString("N"));
        try
        {
            foreach (var phase in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced,
                UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped })
                PendingTransaction(Path.Combine(directory, "transaction-" + phase), phase);
            foreach (var rollback in new[] { false, true })
            foreach (var published in new[] { false, true })
                SelectionPublication(Path.Combine(directory, $"selection-{rollback}-{published}"), rollback, published);
            foreach (var rollback in new[] { false, true })
                ForgedTerminal(Path.Combine(directory, "terminal-" + rollback), rollback);
            RejectMalformedStage(Path.Combine(directory, "malformed-transaction"), false);
            RejectMalformedStage(Path.Combine(directory, "malformed-slot"), true);
            return assertions;
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    private static void RejectMalformedStage(string root, bool slot)
    {
        _ = Initialize(root, WindowsStoreIO.CurrentOwner());
        var name = slot ? "active-slot.pending.json" : "transaction.pending.json";
        using (var io = new WindowsStoreIO(root)) io.Stage(name, "{}"u8.ToArray());
        var before = ReadExisting(root);
        using (var store = new UpdateTransactionStore(root, Installation))
            Refuses(() => store.RecoverPublications(), slot ? "UPDATE_SLOT_SELECTION_INVALID" : "UPDATE_TRANSACTION_INVALID");
        CheckUnchanged(root, before);
    }

    private static void ForgedTerminal(string root, bool rollback)
    {
        var owner = WindowsStoreIO.CurrentOwner();
        var fixture = Initialize(root, owner);
        var current = fixture.Transaction;
        foreach (var phase in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced,
            UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent })
            current = Advance(root, current, phase, owner);
        SlotSelection candidate;
        using (var store = new UpdateTransactionStore(root, Installation))
            candidate = store.SelectCandidate(current, current.Digest, fixture.Selection.Digest, owner);
        if (rollback)
        {
            foreach (var phase in new[] { UpdateTransactionPhase.CandidateSelected, UpdateTransactionPhase.RollbackIntent,
                UpdateTransactionPhase.PreviousSelectionIntent }) current = Advance(root, current, phase, owner);
            using var store = new UpdateTransactionStore(root, Installation);
            _ = store.SelectPrevious(current, current.Digest, candidate.Digest, owner);
        }
        var forged = Wire.Object(current.Encode());
        var payload = forged["payload"]!.AsObject();
        payload["phase"] = rollback ? "rollback-verified" : "committed";
        forged["payloadDigest"] = WindowsStoreIO.Hash(Wire.Encode(payload));
        using (var io = new WindowsStoreIO(root))
        {
            io.Stage("transaction.pending.json", Wire.Encode(forged));
            io.PublishStage("transaction.pending.json", "transaction.json", current.Digest);
        }
        var before = ReadExisting(root);
        using (var core = new UpdateWorkerCore(root, Installation))
        foreach (var command in new[] { "status", "recover" })
        {
            var result = core.Execute(new Command("forged-terminal-" + command, command))["result"]!;
            Check(result["kind"]!.GetValue<string>() == "held" && !result["safeToStart"]!.GetValue<bool>(),
                "worker rejects an unauthenticated terminal claim");
        }
        CheckUnchanged(root, before);
    }

    private static void PendingTransaction(string root, UpdateTransactionPhase phase)
    {
        var owner = WindowsStoreIO.CurrentOwner();
        var fixture = Initialize(root, owner);
        var current = fixture.Transaction;
        foreach (var next in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced,
            UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped })
        {
            var successor = current.Advance(next, current.Digest, owner);
            if (next == phase)
            {
                using (var io = new WindowsStoreIO(root)) io.Stage("transaction.pending.json", successor.Encode());
                break;
            }
            using var store = new UpdateTransactionStore(root, Installation);
            current = store.PersistTransaction(successor, current.Digest);
        }
        var before = ReadExisting(root);
        using (var store = new UpdateTransactionStore(root, Installation))
            Refuses(() => store.RecoverPublications(), "UPDATE_TRANSACTION_PUBLICATION_UNVERIFIED");
        CheckUnchanged(root, before);
        using (var core = new UpdateWorkerCore(root, Installation))
        {
            var result = core.Execute(new Command("unverified-transaction", "recover"))["result"]!;
            Check(result["kind"]!.GetValue<string>() == "held" && !result["safeToStart"]!.GetValue<bool>()
                && result["reason"]!.GetValue<string>() == "UPDATE_TRANSACTION_PUBLICATION_UNVERIFIED", "worker holds unverified transaction stage");
        }
        CheckUnchanged(root, before);
    }

    private static void SelectionPublication(string root, bool rollback, bool published)
    {
        var owner = WindowsStoreIO.CurrentOwner();
        var fixture = Initialize(root, owner);
        var current = fixture.Transaction;
        foreach (var phase in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced,
            UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent })
            current = Advance(root, current, phase, owner);
        var selection = fixture.Selection;
        if (rollback)
        {
            using (var store = new UpdateTransactionStore(root, Installation))
                selection = store.SelectCandidate(current, current.Digest, selection.Digest, owner);
            foreach (var phase in new[] { UpdateTransactionPhase.CandidateSelected, UpdateTransactionPhase.RollbackIntent,
                UpdateTransactionPhase.PreviousSelectionIntent }) current = Advance(root, current, phase, owner);
        }
        var staged = rollback ? selection.SelectPrevious(current, selection.Digest, owner)
            : selection.SelectCandidate(current, selection.Digest, owner);
        using (var io = new WindowsStoreIO(root))
        {
            io.Stage("active-slot.pending.json", staged.Encode());
            if (published) io.PublishStage("active-slot.pending.json", "active-slot.json", selection.Digest);
        }
        var before = ReadExisting(root);
        using (var store = new UpdateTransactionStore(root, Installation))
            Refuses(() => store.RecoverPublications(), "UPDATE_SLOT_PUBLICATION_UNVERIFIED");
        CheckUnchanged(root, before);
        using (var core = new UpdateWorkerCore(root, Installation))
        {
            var result = core.Execute(new Command("unverified-slot", "recover"))["result"]!;
            Check(result["kind"]!.GetValue<string>() == "held" && !result["safeToStart"]!.GetValue<bool>(),
                "worker holds unverified selection and intent");
            if (!published) Check(result["reason"]!.GetValue<string>() == "UPDATE_SLOT_PUBLICATION_UNVERIFIED", "worker reports unverified slot stage");
        }
        CheckUnchanged(root, before);
    }

    private static (SlotSelection Selection, UpdateTransactionJournal Transaction) Initialize(string root, ProcessOwner owner)
    {
        var selection = SlotSelection.Create(Installation, 4, 1, "none", owner,
            "d4444444-4444-4444-8444-444444444444", "A", Digest('a'),
            DataGeneration.Create("a1111111-1111-4111-8111-111111111111", Digest('1')));
        var transaction = UpdateTransactionJournal.Create(selection, "none", owner, "request-1", "release-6-0-0", 1,
            Digest('e'), "6.0.0", Digest('b'), DataGeneration.Create("b2222222-2222-4222-8222-222222222222", Digest('2')),
            new TunnelSnapshot(true, true, Digest('f')), "e5555555-5555-4555-8555-555555555555",
            "f6666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777");
        using var store = new UpdateTransactionStore(root, Installation);
        store.InitializeSelection(selection);
        return (selection, store.PersistTransaction(transaction, "none"));
    }

    private static UpdateTransactionJournal Advance(string root, UpdateTransactionJournal current, UpdateTransactionPhase next, ProcessOwner owner)
    {
        using var store = new UpdateTransactionStore(root, Installation);
        return store.PersistTransaction(current.Advance(next, current.Digest, owner), current.Digest);
    }

    private static Dictionary<string, byte[]> ReadExisting(string root) => new[] {
        "transaction.json", "transaction.pending.json", "active-slot.json", "active-slot.pending.json"
    }.Where(name => File.Exists(Path.Combine(root, name)))
        .ToDictionary(name => name, name => File.ReadAllBytes(Path.Combine(root, name)));

    private static void CheckUnchanged(string root, Dictionary<string, byte[]> before)
    {
        var after = ReadExisting(root);
        Check(before.Count == after.Count && before.All(item => after.TryGetValue(item.Key, out var bytes)
            && bytes.AsSpan().SequenceEqual(item.Value)), "recovery preserves all current and pending bytes");
    }

    private static string Digest(char value) => new(value, 64);
    private static void Check(bool condition, string message) { assertions++; if (!condition) throw new Exception(message); }
    private static void Refuses(Action action, string reason)
    {
        assertions++;
        try { action(); }
        catch (Refusal error) when (error.Reason == reason) { return; }
        throw new Exception("expected " + reason);
    }
}
