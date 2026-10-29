using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

internal enum UpdateTransactionPhase
{
    CandidateReady,
    QuiesceIntent,
    Quiesced,
    TunnelStopIntent,
    TunnelStopped,
    CandidateSelectionIntent,
    CandidateSelected,
    CandidateLaunchIntent,
    TrialStarted,
    HealthVerified,
    CommitIntent,
    Committed,
    RollbackIntent,
    PreviousSelectionIntent,
    PreviousSelected,
    PreviousLaunchIntent,
    PreviousStarted,
    RollbackVerified,
    RollbackUnverified,
}

internal sealed record TunnelSnapshot(bool Enabled, bool WasConnected, string? ProfileDigest)
{
    internal void Validate()
    {
        if (WasConnected && !Enabled) throw new Refusal("UPDATE_TRANSACTION_INVALID");
        if (Enabled && (ProfileDigest is null || !Wire.Digest(ProfileDigest))) throw new Refusal("UPDATE_TRANSACTION_INVALID");
        if (ProfileDigest is not null && !Wire.Digest(ProfileDigest)) throw new Refusal("UPDATE_TRANSACTION_INVALID");
    }
}

internal sealed record DataGeneration
{
    internal string Id { get; }
    internal string ManifestDigest { get; }

    private DataGeneration(string id, string manifestDigest)
    {
        Id = id;
        ManifestDigest = manifestDigest;
    }

    internal static DataGeneration Create(string id, string manifestDigest)
    {
        if (!Guid.TryParseExact(id, "D", out var guid) || guid == Guid.Empty || guid.ToString("D") != id
            || manifestDigest is null || !Wire.Digest(manifestDigest)) throw new Refusal("UPDATE_DATA_GENERATION_INVALID");
        return new DataGeneration(id, manifestDigest);
    }

    internal JsonObject Encode() => new()
    {
        ["id"] = Id,
        ["manifestDigest"] = ManifestDigest,
    };

    internal static DataGeneration Decode(JsonObject value)
    {
        Wire.Fields(value, "id", "manifestDigest");
        return Create(Wire.Text(value, "id"), Wire.Text(value, "manifestDigest"));
    }
}

internal sealed record SlotSelection(
    string InstallationId,
    ulong Generation,
    ulong Revision,
    string PreviousDigest,
    ProcessOwner Owner,
    string TransactionId,
    string Slot,
    string SlotDigest,
    DataGeneration DataGeneration)
{
    internal string Digest => Hash(Encode());

    internal static SlotSelection Create(string installationId, ulong generation, ulong revision, string previousDigest,
        ProcessOwner owner, string transactionId, string slot, string slotDigest, DataGeneration dataGeneration)
    {
        var value = new SlotSelection(installationId, generation, revision, previousDigest, owner, transactionId, slot, slotDigest,
            dataGeneration);
        value.Validate();
        return value;
    }

    internal byte[] Encode()
    {
        Validate();
        var payload = new JsonObject
        {
            ["transactionId"] = TransactionId,
            ["slot"] = Slot,
            ["slotDigest"] = SlotDigest,
            ["dataGeneration"] = DataGeneration.Encode(),
        };
        return Wire.Encode(new JsonObject
        {
            ["schema"] = 2,
            ["installationId"] = InstallationId,
            ["generation"] = Wire.Decimal(Generation),
            ["revision"] = Wire.Decimal(Revision),
            ["previousDigest"] = PreviousDigest,
            ["owner"] = EncodeOwner(Owner),
            ["payloadDigest"] = Hash(Wire.Encode(payload)),
            ["payload"] = payload,
        });
    }

    internal static SlotSelection Decode(byte[] bytes, string installationId)
    {
        try
        {
            if (bytes.Length is 0 or > 65_536) throw new Refusal("UPDATE_SLOT_SELECTION_INVALID");
            var value = Wire.Object(bytes);
            Wire.Fields(value, "schema", "installationId", "generation", "revision", "previousDigest", "owner", "payloadDigest", "payload");
            if (Wire.Integer(value, "schema") != 2) throw new Refusal("UPDATE_SLOT_SELECTION_INVALID");
            var actualInstallation = Wire.Text(value, "installationId");
            if (actualInstallation != installationId) throw new Refusal("UPDATE_SLOT_SELECTION_IDENTITY_MISMATCH");
            var payload = value["payload"] as JsonObject ?? throw new Refusal("UPDATE_SLOT_SELECTION_INVALID");
            Wire.Fields(payload, "transactionId", "slot", "slotDigest", "dataGeneration");
            if (Wire.Text(value, "payloadDigest") != Hash(Wire.Encode(payload)))
                throw new Refusal("UPDATE_SLOT_SELECTION_CHECKSUM_INVALID");
            return Create(actualInstallation, Wire.Decimal(Wire.Text(value, "generation")),
                Wire.Decimal(Wire.Text(value, "revision")), Wire.Text(value, "previousDigest"),
                DecodeOwner(value["owner"] as JsonObject ?? throw new Refusal("UPDATE_SLOT_SELECTION_INVALID")),
                Wire.Text(payload, "transactionId"), Wire.Text(payload, "slot"), Wire.Text(payload, "slotDigest"),
                DataGeneration.Decode(payload["dataGeneration"] as JsonObject ?? throw new Refusal("UPDATE_SLOT_SELECTION_INVALID")));
        }
        catch (Refusal error) when (error.Reason is "UPDATE_SLOT_SELECTION_IDENTITY_MISMATCH" or "UPDATE_SLOT_SELECTION_CHECKSUM_INVALID")
        {
            throw;
        }
        catch (Exception)
        {
            throw new Refusal("UPDATE_SLOT_SELECTION_INVALID");
        }
    }

    internal SlotSelection SelectCandidate(UpdateTransactionJournal transaction, string expectedDigest, ProcessOwner owner)
    {
        if (transaction.Phase != UpdateTransactionPhase.CandidateSelectionIntent)
            throw new Refusal("UPDATE_SLOT_SELECTION_PHASE_INVALID");
        if (expectedDigest != Digest || transaction.InstallationId != InstallationId)
            throw new Refusal("UPDATE_SLOT_SELECTION_CONFLICT");
        if (Generation == transaction.Generation && TransactionId == transaction.TransactionId
            && Revision == 1 && PreviousDigest == transaction.PreviousSelectionDigest
            && Slot == transaction.CandidateSlot && SlotDigest == transaction.CandidateSlotDigest
            && DataGeneration == transaction.CandidateDataGeneration) return this;
        if (transaction.PreviousSelectionDigest != Digest || Generation == ulong.MaxValue
            || transaction.Generation != Generation + 1 || transaction.PreviousSlot != Slot
            || transaction.PreviousSlotDigest != SlotDigest || transaction.PreviousDataGeneration != DataGeneration)
            throw new Refusal("UPDATE_SLOT_SELECTION_CONFLICT");
        return Create(InstallationId, transaction.Generation, 1, Digest, owner, transaction.TransactionId,
            transaction.CandidateSlot, transaction.CandidateSlotDigest, transaction.CandidateDataGeneration);
    }

    internal SlotSelection SelectPrevious(UpdateTransactionJournal transaction, string expectedDigest, ProcessOwner owner)
    {
        if (transaction.Phase != UpdateTransactionPhase.PreviousSelectionIntent)
            throw new Refusal("UPDATE_SLOT_SELECTION_PHASE_INVALID");
        if (expectedDigest != Digest || transaction.InstallationId != InstallationId
            || transaction.PreviousSlot.Length == 0 || transaction.PreviousSlotDigest.Length == 0)
            throw new Refusal("UPDATE_SLOT_SELECTION_CONFLICT");
        if (Digest == transaction.PreviousSelectionDigest && Generation != ulong.MaxValue && Generation + 1 == transaction.Generation
            && Slot == transaction.PreviousSlot && SlotDigest == transaction.PreviousSlotDigest
            && DataGeneration == transaction.PreviousDataGeneration)
            return this;
        if (Generation != transaction.Generation || TransactionId != transaction.TransactionId)
            throw new Refusal("UPDATE_SLOT_SELECTION_CONFLICT");
        if (Slot == transaction.PreviousSlot && SlotDigest == transaction.PreviousSlotDigest
            && DataGeneration == transaction.PreviousDataGeneration) return this;
        if (Slot != transaction.CandidateSlot || SlotDigest != transaction.CandidateSlotDigest
            || DataGeneration != transaction.CandidateDataGeneration)
            throw new Refusal("UPDATE_SLOT_SELECTION_CONFLICT");
        try
        {
            return Create(InstallationId, Generation, checked(Revision + 1), Digest, owner,
                transaction.TransactionId, transaction.PreviousSlot, transaction.PreviousSlotDigest, transaction.PreviousDataGeneration);
        }
        catch (OverflowException) { throw new Refusal("UPDATE_SLOT_SELECTION_INVALID"); }
    }

    private void Validate()
    {
        if (!Wire.Digest(InstallationId) || Generation == 0 || Revision == 0 || !ValidPreviousDigest(PreviousDigest)
            || !CanonicalGuid(TransactionId) || Slot is not ("A" or "B") || !Wire.Digest(SlotDigest) || DataGeneration is null)
            throw new Refusal("UPDATE_SLOT_SELECTION_INVALID");
        ValidateOwner(Owner, "UPDATE_SLOT_SELECTION_INVALID");
    }

    private static bool ValidPreviousDigest(string value) => value == "none" || Wire.Digest(value);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static bool CanonicalGuid(string value) => Guid.TryParseExact(value, "D", out var guid) && guid.ToString("D") == value;

    private static JsonObject EncodeOwner(ProcessOwner owner) => new()
    {
        ["pid"] = owner.Pid,
        ["creationTime"] = owner.CreationTime,
        ["executable"] = owner.Executable,
    };

    private static ProcessOwner DecodeOwner(JsonObject value)
    {
        Wire.Fields(value, "pid", "creationTime", "executable");
        return new ProcessOwner(Wire.Integer(value, "pid"), Wire.Text(value, "creationTime"), Wire.Text(value, "executable"));
    }

    private static void ValidateOwner(ProcessOwner owner, string reason)
    {
        if (owner.Pid <= 0 || Wire.Decimal(owner.CreationTime) == 0 || owner.Executable.Length is < 1 or > 32_768
            || owner.Executable.Contains('\0') || !Path.IsPathFullyQualified(owner.Executable)) throw new Refusal(reason);
    }
}

internal sealed record UpdateTransactionJournal(
    string InstallationId,
    ulong Generation,
    ulong Revision,
    string PreviousDigest,
    ProcessOwner Owner,
    string TransactionId,
    string RequestId,
    string ReleaseId,
    int PolicyRevision,
    string ReleaseEnvelopeDigest,
    string CandidateVersion,
    string PreviousSelectionDigest,
    string PreviousSlot,
    string PreviousSlotDigest,
    DataGeneration PreviousDataGeneration,
    string CandidateSlot,
    string CandidateSlotDigest,
    DataGeneration CandidateDataGeneration,
    string MaintenanceEpoch,
    string OperationNonce,
    TunnelSnapshot Tunnel,
    UpdateTransactionPhase Phase)
{
    internal bool IsTerminal => Phase is UpdateTransactionPhase.Committed or UpdateTransactionPhase.RollbackVerified;
    internal bool SafeToStart => Phase is UpdateTransactionPhase.Committed or UpdateTransactionPhase.RollbackVerified;
    internal string Digest => Hash(Encode());

    internal static UpdateTransactionJournal Create(SlotSelection previousSelection, string previousJournalDigest,
        ProcessOwner owner, string requestId, string releaseId, int policyRevision, string releaseEnvelopeDigest,
        string candidateVersion, string candidateSlotDigest, DataGeneration candidateDataGeneration, TunnelSnapshot tunnel, string transactionId,
        string maintenanceEpoch, string operationNonce)
    {
        try
        {
            var value = new UpdateTransactionJournal(previousSelection.InstallationId,
                checked(previousSelection.Generation + 1), 1, previousJournalDigest, owner, transactionId,
                requestId, releaseId, policyRevision, releaseEnvelopeDigest, candidateVersion,
                previousSelection.Digest, previousSelection.Slot, previousSelection.SlotDigest, previousSelection.DataGeneration,
                previousSelection.Slot == "A" ? "B" : "A", candidateSlotDigest, candidateDataGeneration,
                maintenanceEpoch, operationNonce, tunnel, UpdateTransactionPhase.CandidateReady);
            value.Validate();
            if (candidateSlotDigest == previousSelection.SlotDigest) throw new Refusal("UPDATE_TRANSACTION_INVALID");
            return value;
        }
        catch (OverflowException) { throw new Refusal("UPDATE_TRANSACTION_INVALID"); }
    }

    internal UpdateTransactionJournal Advance(UpdateTransactionPhase next, string previousDigest, ProcessOwner owner)
    {
        if (!ValidPreviousDigest(previousDigest)) throw new Refusal("UPDATE_TRANSACTION_INVALID");
        ValidateOwner(owner);
        var evidenceRequired = EvidenceRequired(next);
        if (evidenceRequired is not null) throw new Refusal(evidenceRequired);
        if (!CanAdvance(Phase, next))
            throw new Refusal(IsTerminal ? "UPDATE_PHASE_TERMINAL" : "UPDATE_PHASE_TRANSITION_INVALID");
        try
        {
            var value = this with { Revision = checked(Revision + 1), PreviousDigest = previousDigest, Owner = owner, Phase = next };
            value.Validate();
            return value;
        }
        catch (OverflowException) { throw new Refusal("UPDATE_TRANSACTION_INVALID"); }
    }

    internal byte[] Encode()
    {
        Validate();
        var payload = new JsonObject
        {
            ["transactionId"] = TransactionId,
            ["requestId"] = RequestId,
            ["releaseId"] = ReleaseId,
            ["policyRevision"] = PolicyRevision,
            ["releaseEnvelopeDigest"] = ReleaseEnvelopeDigest,
            ["candidateVersion"] = CandidateVersion,
            ["previousSelectionDigest"] = PreviousSelectionDigest,
            ["previousSlot"] = PreviousSlot,
            ["previousSlotDigest"] = PreviousSlotDigest,
            ["previousDataGeneration"] = PreviousDataGeneration.Encode(),
            ["candidateSlot"] = CandidateSlot,
            ["candidateSlotDigest"] = CandidateSlotDigest,
            ["candidateDataGeneration"] = CandidateDataGeneration.Encode(),
            ["maintenanceEpoch"] = MaintenanceEpoch,
            ["operationNonce"] = OperationNonce,
            ["phase"] = PhaseName(Phase),
            ["tunnel"] = EncodeTunnel(Tunnel),
        };
        return Wire.Encode(new JsonObject
        {
            ["schema"] = 2,
            ["installationId"] = InstallationId,
            ["generation"] = Wire.Decimal(Generation),
            ["revision"] = Wire.Decimal(Revision),
            ["previousDigest"] = PreviousDigest,
            ["owner"] = EncodeOwner(Owner),
            ["payloadDigest"] = Hash(Wire.Encode(payload)),
            ["payload"] = payload,
        });
    }

    internal static UpdateTransactionJournal Decode(byte[] bytes, string installationId)
    {
        try
        {
            if (bytes.Length is 0 or > 65_536) throw new Refusal("UPDATE_TRANSACTION_INVALID");
            var value = Wire.Object(bytes);
            Wire.Fields(value, "schema", "installationId", "generation", "revision", "previousDigest", "owner", "payloadDigest", "payload");
            if (Wire.Integer(value, "schema") != 2) throw new Refusal("UPDATE_TRANSACTION_INVALID");
            var actualInstallation = Wire.Text(value, "installationId");
            if (actualInstallation != installationId) throw new Refusal("UPDATE_TRANSACTION_IDENTITY_MISMATCH");
            var payload = value["payload"] as JsonObject ?? throw new Refusal("UPDATE_TRANSACTION_INVALID");
            Wire.Fields(payload, "transactionId", "requestId", "releaseId", "policyRevision", "releaseEnvelopeDigest",
                "candidateVersion", "previousSelectionDigest", "previousSlot", "previousSlotDigest", "previousDataGeneration", "candidateSlot",
                "candidateSlotDigest", "candidateDataGeneration", "maintenanceEpoch", "operationNonce", "phase", "tunnel");
            if (Wire.Text(value, "payloadDigest") != Hash(Wire.Encode(payload)))
                throw new Refusal("UPDATE_TRANSACTION_CHECKSUM_INVALID");
            var result = new UpdateTransactionJournal(actualInstallation,
                Wire.Decimal(Wire.Text(value, "generation")), Wire.Decimal(Wire.Text(value, "revision")),
                Wire.Text(value, "previousDigest"), DecodeOwner(value["owner"] as JsonObject ?? throw new Refusal("UPDATE_TRANSACTION_INVALID")),
                Wire.Text(payload, "transactionId"), Wire.Text(payload, "requestId"), Wire.Text(payload, "releaseId"),
                Wire.Integer(payload, "policyRevision"), Wire.Text(payload, "releaseEnvelopeDigest"),
                Wire.Text(payload, "candidateVersion"), Wire.Text(payload, "previousSelectionDigest"),
                Wire.Text(payload, "previousSlot"), Wire.Text(payload, "previousSlotDigest"),
                DataGeneration.Decode(payload["previousDataGeneration"] as JsonObject ?? throw new Refusal("UPDATE_TRANSACTION_INVALID")),
                Wire.Text(payload, "candidateSlot"), Wire.Text(payload, "candidateSlotDigest"),
                DataGeneration.Decode(payload["candidateDataGeneration"] as JsonObject ?? throw new Refusal("UPDATE_TRANSACTION_INVALID")),
                Wire.Text(payload, "maintenanceEpoch"), Wire.Text(payload, "operationNonce"),
                DecodeTunnel(payload["tunnel"] as JsonObject ?? throw new Refusal("UPDATE_TRANSACTION_INVALID")),
                ParsePhase(Wire.Text(payload, "phase")));
            result.Validate();
            return result;
        }
        catch (Refusal error) when (error.Reason is "UPDATE_TRANSACTION_IDENTITY_MISMATCH" or "UPDATE_TRANSACTION_CHECKSUM_INVALID")
        {
            throw;
        }
        catch (Exception)
        {
            throw new Refusal("UPDATE_TRANSACTION_INVALID");
        }
    }

    private void Validate()
    {
        if (!Wire.Digest(InstallationId) || Generation == 0 || Revision == 0 || !ValidPreviousDigest(PreviousDigest)
            || !CanonicalGuid(TransactionId) || !Wire.Identifier(RequestId) || !Wire.Identifier(ReleaseId)
            || PolicyRevision < 1 || !Wire.Digest(ReleaseEnvelopeDigest) || !Wire.Digest(PreviousSelectionDigest)
            || PreviousSlot is not ("A" or "B") || CandidateSlot is not ("A" or "B") || CandidateSlot == PreviousSlot
            || !Wire.Digest(PreviousSlotDigest) || !Wire.Digest(CandidateSlotDigest) || CandidateSlotDigest == PreviousSlotDigest
            || PreviousDataGeneration is null || CandidateDataGeneration is null || CandidateDataGeneration.Id == PreviousDataGeneration.Id
            || !CanonicalGuid(MaintenanceEpoch) || !CanonicalGuid(OperationNonce)
            || !Enum.IsDefined(Phase)) throw new Refusal("UPDATE_TRANSACTION_INVALID");
        _ = StableVersion.Parse(CandidateVersion);
        ValidateOwner(Owner);
        Tunnel.Validate();
        var evidenceRequired = EvidenceRequired(Phase);
        if (evidenceRequired is not null) throw new Refusal(evidenceRequired);
    }

    private static string? EvidenceRequired(UpdateTransactionPhase phase) => phase switch
    {
        UpdateTransactionPhase.HealthVerified => "UPDATE_CANDIDATE_HEALTH_EVIDENCE_REQUIRED",
        UpdateTransactionPhase.Committed => "UPDATE_COMMIT_EVIDENCE_REQUIRED",
        UpdateTransactionPhase.RollbackVerified => "UPDATE_ROLLBACK_EVIDENCE_REQUIRED",
        _ => null,
    };

    private static bool CanAdvance(UpdateTransactionPhase current, UpdateTransactionPhase next)
    {
        if (current is UpdateTransactionPhase.Committed or UpdateTransactionPhase.RollbackVerified or UpdateTransactionPhase.RollbackUnverified)
            return false;
        if (next == UpdateTransactionPhase.RollbackIntent)
            return current is not (UpdateTransactionPhase.RollbackIntent or UpdateTransactionPhase.PreviousSelectionIntent
                or UpdateTransactionPhase.PreviousSelected or UpdateTransactionPhase.PreviousLaunchIntent
                or UpdateTransactionPhase.PreviousStarted);
        if (next == UpdateTransactionPhase.RollbackUnverified)
            return current is UpdateTransactionPhase.RollbackIntent or UpdateTransactionPhase.PreviousSelectionIntent
                or UpdateTransactionPhase.PreviousSelected or UpdateTransactionPhase.PreviousLaunchIntent or UpdateTransactionPhase.PreviousStarted;
        return (current, next) switch
        {
            (UpdateTransactionPhase.CandidateReady, UpdateTransactionPhase.QuiesceIntent) => true,
            (UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced) => true,
            (UpdateTransactionPhase.Quiesced, UpdateTransactionPhase.TunnelStopIntent) => true,
            (UpdateTransactionPhase.TunnelStopIntent, UpdateTransactionPhase.TunnelStopped) => true,
            (UpdateTransactionPhase.TunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent) => true,
            (UpdateTransactionPhase.CandidateSelectionIntent, UpdateTransactionPhase.CandidateSelected) => true,
            (UpdateTransactionPhase.CandidateSelected, UpdateTransactionPhase.CandidateLaunchIntent) => true,
            (UpdateTransactionPhase.CandidateLaunchIntent, UpdateTransactionPhase.TrialStarted) => true,
            (UpdateTransactionPhase.HealthVerified, UpdateTransactionPhase.CommitIntent) => true,
            (UpdateTransactionPhase.RollbackIntent, UpdateTransactionPhase.PreviousSelectionIntent) => true,
            (UpdateTransactionPhase.PreviousSelectionIntent, UpdateTransactionPhase.PreviousSelected) => true,
            (UpdateTransactionPhase.PreviousSelected, UpdateTransactionPhase.PreviousLaunchIntent) => true,
            (UpdateTransactionPhase.PreviousLaunchIntent, UpdateTransactionPhase.PreviousStarted) => true,
            _ => false,
        };
    }

    private static JsonObject EncodeTunnel(TunnelSnapshot tunnel) => new()
    {
        ["enabled"] = tunnel.Enabled,
        ["wasConnected"] = tunnel.WasConnected,
        ["profileDigest"] = tunnel.ProfileDigest,
    };

    private static TunnelSnapshot DecodeTunnel(JsonObject value)
    {
        Wire.Fields(value, "enabled", "wasConnected", "profileDigest");
        var enabled = ReadBoolean(value, "enabled");
        var connected = ReadBoolean(value, "wasConnected");
        var profile = value["profileDigest"] is null ? null : Wire.Text(value, "profileDigest");
        return new TunnelSnapshot(enabled, connected, profile);
    }

    private static bool ReadBoolean(JsonObject value, string name) =>
        value[name] is JsonValue node && node.TryGetValue<bool>(out var result)
            ? result : throw new Refusal("UPDATE_TRANSACTION_INVALID");

    private static string PhaseName(UpdateTransactionPhase phase) => phase switch
    {
        UpdateTransactionPhase.CandidateReady => "candidate-ready",
        UpdateTransactionPhase.QuiesceIntent => "quiesce-intent",
        UpdateTransactionPhase.Quiesced => "quiesced",
        UpdateTransactionPhase.TunnelStopIntent => "tunnel-stop-intent",
        UpdateTransactionPhase.TunnelStopped => "tunnel-stopped",
        UpdateTransactionPhase.CandidateSelectionIntent => "candidate-selection-intent",
        UpdateTransactionPhase.CandidateSelected => "candidate-selected",
        UpdateTransactionPhase.CandidateLaunchIntent => "candidate-launch-intent",
        UpdateTransactionPhase.TrialStarted => "trial-started",
        UpdateTransactionPhase.HealthVerified => "health-verified",
        UpdateTransactionPhase.CommitIntent => "commit-intent",
        UpdateTransactionPhase.Committed => "committed",
        UpdateTransactionPhase.RollbackIntent => "rollback-intent",
        UpdateTransactionPhase.PreviousSelectionIntent => "previous-selection-intent",
        UpdateTransactionPhase.PreviousSelected => "previous-selected",
        UpdateTransactionPhase.PreviousLaunchIntent => "previous-launch-intent",
        UpdateTransactionPhase.PreviousStarted => "previous-started",
        UpdateTransactionPhase.RollbackVerified => "rollback-verified",
        UpdateTransactionPhase.RollbackUnverified => "rollback-unverified",
        _ => throw new Refusal("UPDATE_TRANSACTION_INVALID"),
    };

    private static UpdateTransactionPhase ParsePhase(string value) => value switch
    {
        "candidate-ready" => UpdateTransactionPhase.CandidateReady,
        "quiesce-intent" => UpdateTransactionPhase.QuiesceIntent,
        "quiesced" => UpdateTransactionPhase.Quiesced,
        "tunnel-stop-intent" => UpdateTransactionPhase.TunnelStopIntent,
        "tunnel-stopped" => UpdateTransactionPhase.TunnelStopped,
        "candidate-selection-intent" => UpdateTransactionPhase.CandidateSelectionIntent,
        "candidate-selected" => UpdateTransactionPhase.CandidateSelected,
        "candidate-launch-intent" => UpdateTransactionPhase.CandidateLaunchIntent,
        "trial-started" => UpdateTransactionPhase.TrialStarted,
        "health-verified" => UpdateTransactionPhase.HealthVerified,
        "commit-intent" => UpdateTransactionPhase.CommitIntent,
        "committed" => UpdateTransactionPhase.Committed,
        "rollback-intent" => UpdateTransactionPhase.RollbackIntent,
        "previous-selection-intent" => UpdateTransactionPhase.PreviousSelectionIntent,
        "previous-selected" => UpdateTransactionPhase.PreviousSelected,
        "previous-launch-intent" => UpdateTransactionPhase.PreviousLaunchIntent,
        "previous-started" => UpdateTransactionPhase.PreviousStarted,
        "rollback-verified" => UpdateTransactionPhase.RollbackVerified,
        "rollback-unverified" => UpdateTransactionPhase.RollbackUnverified,
        _ => throw new Refusal("UPDATE_TRANSACTION_INVALID"),
    };

    private static JsonObject EncodeOwner(ProcessOwner owner) => new()
    {
        ["pid"] = owner.Pid,
        ["creationTime"] = owner.CreationTime,
        ["executable"] = owner.Executable,
    };

    private static ProcessOwner DecodeOwner(JsonObject value)
    {
        Wire.Fields(value, "pid", "creationTime", "executable");
        return new ProcessOwner(Wire.Integer(value, "pid"), Wire.Text(value, "creationTime"), Wire.Text(value, "executable"));
    }

    private void ValidateOwner(ProcessOwner owner)
    {
        if (owner.Pid <= 0 || Wire.Decimal(owner.CreationTime) == 0 || owner.Executable.Length is < 1 or > 32_768
            || owner.Executable.Contains('\0') || !Path.IsPathFullyQualified(owner.Executable)) throw new Refusal("UPDATE_TRANSACTION_INVALID");
    }

    private static bool ValidPreviousDigest(string value) => value == "none" || Wire.Digest(value);
    private static bool CanonicalGuid(string value) => Guid.TryParseExact(value, "D", out var guid) && guid.ToString("D") == value;
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
