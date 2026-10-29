using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

internal static class UpdateTransactionJournalTests
{
    private static int assertions;
    private const string Installation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string PreviousDataId = "a1111111-1111-4111-8111-111111111111";
    private const string CandidateDataId = "b2222222-2222-4222-8222-222222222222";
    private const string OtherDataId = "c3333333-3333-4333-8333-333333333333";
    private static string Digest(char value) => new(value, 64);

    internal static int Run()
    {
        assertions = 0;
        var owner = Owner();
        var enrollmentTransaction = Guid.NewGuid().ToString("D");
        var previous = SlotSelection.Create(Installation, 4, 1, "none", owner,
            enrollmentTransaction, "A", Digest('a'), DataGeneration.Create(PreviousDataId, Digest('1')));
        var transaction = Create(previous, owner);

        var encoded = transaction.Encode();
        var decoded = UpdateTransactionJournal.Decode(encoded, Installation);
        Check(decoded == transaction, "transaction journal round trip");
        Check(decoded.Digest == Convert.ToHexString(SHA256.HashData(encoded)).ToLowerInvariant(), "transaction digest binds encoded bytes");
        Check(decoded.Encode().SequenceEqual(encoded), "paired transaction encoding is deterministic after decode");
        Check(JsonNode.Parse(encoded)!["schema"]!.GetValue<int>() == 2, "paired transaction uses schema two");
        Check(decoded.PreviousDataGeneration == previous.DataGeneration
            && decoded.CandidateDataGeneration == transaction.CandidateDataGeneration,
            "journal retains both exact data generations");
        ValidateDataGeneration(previous, owner, encoded);
        foreach (var unsupported in new[] { "health-verified", "committed", "rollback-verified" })
            ExpectRefusal(() => UpdateTransactionJournal.Decode(EncodePhase(encoded, unsupported), Installation),
                "UPDATE_TRANSACTION_INVALID", unsupported + " cannot be restored without native evidence");

        var quiesce = transaction.Advance(UpdateTransactionPhase.QuiesceIntent, transaction.Digest, owner);
        var quiesced = quiesce.Advance(UpdateTransactionPhase.Quiesced, quiesce.Digest, owner);
        var tunnelIntent = quiesced.Advance(UpdateTransactionPhase.TunnelStopIntent, quiesced.Digest, owner);
        var tunnelStopped = tunnelIntent.Advance(UpdateTransactionPhase.TunnelStopped, tunnelIntent.Digest, owner);
        var selectIntent = tunnelStopped.Advance(UpdateTransactionPhase.CandidateSelectionIntent, tunnelStopped.Digest, owner);
        var selected = previous.SelectCandidate(selectIntent, previous.Digest, owner);
        Check(selected.Slot == "B" && selected.SlotDigest == Digest('b')
            && selected.DataGeneration == transaction.CandidateDataGeneration,
            "candidate selection chooses the inactive slot and its isolated data generation");
        Check(selected.Generation == transaction.Generation && selected.TransactionId == transaction.TransactionId,
            "candidate selection binds transaction generation and identity");
        Check(SlotSelection.Decode(selected.Encode(), Installation) == selected, "slot selection round trip");
        Check(SlotSelection.Decode(selected.Encode(), Installation).Encode().SequenceEqual(selected.Encode()),
            "paired selection encoding is deterministic after decode");
        Check(JsonNode.Parse(selected.Encode())!["schema"]!.GetValue<int>() == 2, "paired selection uses schema two");
        Check(selected.SelectCandidate(selectIntent, selected.Digest, owner) == selected,
            "candidate selection retry preserves the exact published application and data pair");
        ExpectRefusal(() => previous.SelectCandidate(selectIntent with
        {
            PreviousDataGeneration = DataGeneration.Create(OtherDataId, previous.DataGeneration.ManifestDigest),
        }, previous.Digest, owner), "UPDATE_SLOT_SELECTION_CONFLICT", "candidate selection rejects a crossed predecessor data identity");
        var crossedCandidate = selected with { DataGeneration = previous.DataGeneration };
        ExpectRefusal(() => crossedCandidate.SelectCandidate(selectIntent, crossedCandidate.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "candidate selection retry rejects the previous data generation");
        var changedCandidateManifest = selected with { DataGeneration = DataGeneration.Create(CandidateDataId, Digest('3')) };
        ExpectRefusal(() => changedCandidateManifest.SelectCandidate(selectIntent, changedCandidateManifest.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "candidate selection retry rejects a changed data manifest");

        var candidateSelected = selectIntent.Advance(UpdateTransactionPhase.CandidateSelected, selectIntent.Digest, owner);
        var launchIntent = candidateSelected.Advance(UpdateTransactionPhase.CandidateLaunchIntent, candidateSelected.Digest, owner);
        var trial = launchIntent.Advance(UpdateTransactionPhase.TrialStarted, launchIntent.Digest, owner);
        ExpectRefusal(() => trial.Advance(UpdateTransactionPhase.HealthVerified, trial.Digest, owner),
            "UPDATE_CANDIDATE_HEALTH_EVIDENCE_REQUIRED", "candidate process start alone cannot verify health");

        ExpectRefusal(() => transaction.Advance(UpdateTransactionPhase.CandidateSelected, transaction.Digest, owner),
            "UPDATE_PHASE_TRANSITION_INVALID", "selection cannot skip the quiesce and tunnel phases");
        ExpectRefusal(() => previous.SelectCandidate(transaction, previous.Digest, owner),
            "UPDATE_SLOT_SELECTION_PHASE_INVALID", "slot cannot change before durable selection intent");
        ExpectRefusal(() => previous.SelectCandidate(selectIntent, Digest('f'), owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "slot selection uses compare-and-swap against exact predecessor");

        var rollbackIntent = trial.Advance(UpdateTransactionPhase.RollbackIntent, trial.Digest, owner);
        var priorSelectionIntent = rollbackIntent.Advance(UpdateTransactionPhase.PreviousSelectionIntent, rollbackIntent.Digest, owner);
        var rollbackSelection = selected.SelectPrevious(priorSelectionIntent, selected.Digest, owner);
        Check(rollbackSelection.Slot == previous.Slot && rollbackSelection.SlotDigest == previous.SlotDigest
            && rollbackSelection.DataGeneration == previous.DataGeneration,
            "rollback selects the exact immutable prior application and data generation");
        Check(rollbackSelection.Generation == selected.Generation && rollbackSelection.Revision == selected.Revision + 1,
            "rollback advances selection revision without changing transaction generation");
        Check(rollbackSelection.SelectPrevious(priorSelectionIntent, rollbackSelection.Digest, owner) == rollbackSelection,
            "rollback selection is idempotent after readback");
        Check(previous.SelectPrevious(priorSelectionIntent, previous.Digest, owner) == previous,
            "rollback before candidate selection retains the exact predecessor pair");
        ExpectRefusal(() => crossedCandidate.SelectPrevious(priorSelectionIntent, crossedCandidate.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "rollback rejects a candidate application paired with predecessor data");
        ExpectRefusal(() => changedCandidateManifest.SelectPrevious(priorSelectionIntent, changedCandidateManifest.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "rollback rejects a candidate data generation with a changed manifest");
        var crossedPrevious = rollbackSelection with { DataGeneration = selected.DataGeneration };
        ExpectRefusal(() => crossedPrevious.SelectPrevious(priorSelectionIntent, crossedPrevious.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "rollback retry rejects the prior application paired with candidate data");
        var changedPreviousManifest = rollbackSelection with { DataGeneration = DataGeneration.Create(PreviousDataId, Digest('3')) };
        ExpectRefusal(() => changedPreviousManifest.SelectPrevious(priorSelectionIntent, changedPreviousManifest.Digest, owner),
            "UPDATE_SLOT_SELECTION_CONFLICT", "rollback retry rejects a changed predecessor data manifest");
        var priorSelected = priorSelectionIntent.Advance(UpdateTransactionPhase.PreviousSelected, priorSelectionIntent.Digest, owner);
        var priorLaunch = priorSelected.Advance(UpdateTransactionPhase.PreviousLaunchIntent, priorSelected.Digest, owner);
        var priorStarted = priorLaunch.Advance(UpdateTransactionPhase.PreviousStarted, priorLaunch.Digest, owner);
        ExpectRefusal(() => priorStarted.Advance(UpdateTransactionPhase.RollbackVerified, priorStarted.Digest, owner),
            "UPDATE_ROLLBACK_EVIDENCE_REQUIRED", "previous-version start alone cannot verify rollback");
        var unverifiedRollback = priorStarted.Advance(UpdateTransactionPhase.RollbackUnverified, priorStarted.Digest, owner);
        Check(!unverifiedRollback.IsTerminal && !unverifiedRollback.SafeToStart,
            "unverified rollback remains held and cannot admit another update");
        ExpectRefusal(() => unverifiedRollback.Advance(UpdateTransactionPhase.RollbackVerified, unverifiedRollback.Digest, owner),
            "UPDATE_ROLLBACK_EVIDENCE_REQUIRED", "held rollback cannot be marked verified without native recovery evidence");
        ExpectRefusal(() => priorStarted.Advance(UpdateTransactionPhase.RollbackVerified, "not-a-digest", owner),
            "UPDATE_TRANSACTION_INVALID", "transition rejects an unverified predecessor digest");

        var tampered = JsonNode.Parse(encoded)!.AsObject();
        tampered["payload"]!["candidateSlotDigest"] = Digest('c');
        ExpectRefusal(() => UpdateTransactionJournal.Decode(Wire.Encode(tampered), Installation),
            "UPDATE_TRANSACTION_CHECKSUM_INVALID", "tampered transaction payload is rejected");
        ExpectRefusal(() => UpdateTransactionJournal.Decode(encoded, Digest('d')),
            "UPDATE_TRANSACTION_IDENTITY_MISMATCH", "transaction is bound to one installation identity");

        var invalidTunnel = new TunnelSnapshot(true, false, null);
        ExpectRefusal(() => Create(previous, owner, tunnel: invalidTunnel),
            "UPDATE_TRANSACTION_INVALID", "enabled tunnel state must retain profile identity without credentials");
        ExpectRefusal(() => Create(previous, owner, candidateDigest: previous.SlotDigest),
            "UPDATE_TRANSACTION_INVALID", "candidate cannot reuse the immutable prior-slot digest");

        return assertions;
    }

    private static UpdateTransactionJournal Create(SlotSelection previous, ProcessOwner owner, TunnelSnapshot? tunnel = null,
        string? candidateDigest = null, DataGeneration? candidateDataGeneration = null) =>
        UpdateTransactionJournal.Create(previous, Digest('c'), owner,
            "request-1", "release-6-0-0", 1, Digest('e'), "6.0.0", candidateDigest ?? Digest('b'),
            candidateDataGeneration ?? DataGeneration.Create(CandidateDataId, Digest('2')),
            tunnel ?? new TunnelSnapshot(true, true, Digest('f')),
            Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));

    private static void ValidateDataGeneration(SlotSelection previous, ProcessOwner owner, byte[] transactionBytes)
    {
        foreach (var id in new[] { "", Guid.Empty.ToString("D"), PreviousDataId.ToUpperInvariant(), PreviousDataId.Replace("-", ""),
            "../data", "C:\\data\\generation" })
            ExpectRefusal(() => DataGeneration.Create(id, Digest('1')), "UPDATE_DATA_GENERATION_INVALID",
                "data generation rejects a noncanonical identity " + id);
        foreach (var manifest in new[] { "", "sha256:" + Digest('1'), Digest('A'), new string('1', 63) })
            ExpectRefusal(() => DataGeneration.Create(PreviousDataId, manifest), "UPDATE_DATA_GENERATION_INVALID",
                "data generation requires a canonical SHA256 manifest");
        ExpectRefusal(() => DataGeneration.Create(PreviousDataId, null!), "UPDATE_DATA_GENERATION_INVALID",
            "data generation requires a manifest");

        var unchangedData = DataGeneration.Create(CandidateDataId, previous.DataGeneration.ManifestDigest);
        var unchanged = Create(previous, owner, candidateDataGeneration: unchangedData);
        Check(unchanged.CandidateDataGeneration == unchangedData && unchanged.PreviousDataGeneration != unchangedData,
            "isolated candidate generation may retain an unchanged snapshot manifest");
        ExpectRefusal(() => Create(previous, owner, candidateDataGeneration: previous.DataGeneration),
            "UPDATE_TRANSACTION_INVALID", "candidate cannot reuse the predecessor data generation");
        ExpectRefusal(() => Create(previous, owner, candidateDataGeneration: DataGeneration.Create(PreviousDataId, Digest('3'))),
            "UPDATE_TRANSACTION_INVALID", "a changed manifest cannot reuse the predecessor generation identity");

        var selectionBytes = previous.Encode();
        Check((previous with { DataGeneration = DataGeneration.Create(OtherDataId, previous.DataGeneration.ManifestDigest) }).Digest != previous.Digest,
            "selection digest binds the data identity");
        Check((previous with { DataGeneration = DataGeneration.Create(PreviousDataId, Digest('3')) }).Digest != previous.Digest,
            "selection digest binds the data manifest");
        ExpectRefusal(() => (previous with { DataGeneration = null! }).Encode(), "UPDATE_SLOT_SELECTION_INVALID",
            "selection cannot encode a missing application and data pair");
        foreach (var field in new[] { "id", "manifestDigest" })
            ExpectRefusal(() => SlotSelection.Decode(MutatePayload(selectionBytes,
                payload => payload["dataGeneration"]!.AsObject().Remove(field)), Installation),
                "UPDATE_SLOT_SELECTION_INVALID", "selection rejects an incomplete data generation " + field);
        ExpectRefusal(() => SlotSelection.Decode(MutatePayload(selectionBytes, payload => payload.Remove("dataGeneration")), Installation),
            "UPDATE_SLOT_SELECTION_INVALID", "selection refuses a missing data generation");
        ExpectRefusal(() => SlotSelection.Decode(MutatePayload(selectionBytes, payload => payload["dataGeneration"] = null), Installation),
            "UPDATE_SLOT_SELECTION_INVALID", "selection refuses a null data generation");
        ExpectRefusal(() => SlotSelection.Decode(MutatePayload(selectionBytes, payload => payload["dataGeneration"]!["id"] = "../data"), Installation),
            "UPDATE_SLOT_SELECTION_INVALID", "selection decoder refuses paths as data generation identities");
        var oldSelection = JsonNode.Parse(MutatePayload(selectionBytes, payload => payload.Remove("dataGeneration")))!.AsObject();
        oldSelection["schema"] = 1;
        ExpectRefusal(() => SlotSelection.Decode(Wire.Encode(oldSelection), Installation),
            "UPDATE_SLOT_SELECTION_INVALID", "unpaired prototype selection schema is refused without inferred migration");
        var tamperedSelection = JsonNode.Parse(selectionBytes)!.AsObject();
        tamperedSelection["payload"]!["dataGeneration"]!["manifestDigest"] = Digest('3');
        ExpectRefusal(() => SlotSelection.Decode(Wire.Encode(tamperedSelection), Installation),
            "UPDATE_SLOT_SELECTION_CHECKSUM_INVALID", "selection checksum binds its data manifest");

        foreach (var field in new[] { "previousDataGeneration", "candidateDataGeneration" })
        {
            ExpectRefusal(() => UpdateTransactionJournal.Decode(MutatePayload(transactionBytes, payload => payload.Remove(field)), Installation),
                "UPDATE_TRANSACTION_INVALID", "journal refuses a missing " + field);
            ExpectRefusal(() => UpdateTransactionJournal.Decode(MutatePayload(transactionBytes, payload => payload[field] = null), Installation),
                "UPDATE_TRANSACTION_INVALID", "journal refuses a null " + field);
            foreach (var dataField in new[] { "id", "manifestDigest" })
                ExpectRefusal(() => UpdateTransactionJournal.Decode(MutatePayload(transactionBytes,
                    payload => payload[field]!.AsObject().Remove(dataField)), Installation),
                    "UPDATE_TRANSACTION_INVALID", "journal rejects an incomplete " + field + " " + dataField);
        }
        ExpectRefusal(() => UpdateTransactionJournal.Decode(MutatePayload(transactionBytes,
            payload => payload["candidateDataGeneration"]!["id"] = PreviousDataId), Installation),
            "UPDATE_TRANSACTION_INVALID", "journal decoder requires a distinct candidate data generation");
        var oldTransaction = JsonNode.Parse(MutatePayload(transactionBytes, payload =>
        {
            payload.Remove("previousDataGeneration");
            payload.Remove("candidateDataGeneration");
        }))!.AsObject();
        oldTransaction["schema"] = 1;
        ExpectRefusal(() => UpdateTransactionJournal.Decode(Wire.Encode(oldTransaction), Installation),
            "UPDATE_TRANSACTION_INVALID", "unpaired prototype journal schema is refused without inferred migration");
        var tamperedTransaction = JsonNode.Parse(transactionBytes)!.AsObject();
        tamperedTransaction["payload"]!["candidateDataGeneration"]!["manifestDigest"] = Digest('3');
        ExpectRefusal(() => UpdateTransactionJournal.Decode(Wire.Encode(tamperedTransaction), Installation),
            "UPDATE_TRANSACTION_CHECKSUM_INVALID", "journal checksum binds candidate data evidence");
    }

    private static byte[] EncodePhase(byte[] encoded, string phase) => MutatePayload(encoded, payload => payload["phase"] = phase);

    private static byte[] MutatePayload(byte[] encoded, Action<JsonObject> mutate)
    {
        var value = JsonNode.Parse(encoded)!.AsObject();
        var payload = value["payload"]!.AsObject();
        mutate(payload);
        value["payloadDigest"] = Convert.ToHexString(SHA256.HashData(Wire.Encode(payload))).ToLowerInvariant();
        return Wire.Encode(value);
    }

    private static ProcessOwner Owner() => new(Environment.ProcessId, "1",
        Path.GetFullPath(Environment.ProcessPath ?? throw new Exception("test process path unavailable")));

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
