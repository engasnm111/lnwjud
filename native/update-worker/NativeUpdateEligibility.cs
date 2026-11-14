using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

internal sealed record UpdateEligibilityPosition(string InstallationId, string BootId, string Epoch, ulong Revision);
internal sealed record UpdateEligibilityObservation(string Kind, string Reason, UpdateEligibilityPosition Position, int Writers);

// This state is in the protected authority store, outside every rollback generation.
[SupportedOSPlatform("windows")]
internal sealed class NativeUpdateEligibility
{
    private sealed record Writer(string Id, string BootId);
    private sealed record State(string InstallationId, string OwnerSid, string BootId, string Epoch, ulong Revision,
        string Phase, string? TransactionId, bool UnboundHistory, string? OpaqueBootId, Writer[] Writers, string? Seal);

    private readonly WindowsStoreIO store;
    private readonly string installationId;
    private readonly string bootId;
    private State state;
    private string digest;
    private bool unavailable;

    private NativeUpdateEligibility(WindowsStoreIO store, string installationId, string bootId, State state, string digest)
        => (this.store, this.installationId, this.bootId, this.state, this.digest) = (store, installationId, bootId, state, digest);

    // Only the native enrollment path may call this after binding the installed tree and intended owner.
    internal static NativeUpdateEligibility Enroll(WindowsStoreIO store, string installationId, string intendedOwnerSid)
        => EnrollForBoot(store, installationId, intendedOwnerSid, NativeBootIdentity.Read());

    private static NativeUpdateEligibility EnrollForBoot(WindowsStoreIO store, string installationId, string ownerSid, string bootId)
    {
        if (!Wire.Digest(installationId) || !ValidSid(ownerSid) || !CanonicalGuid(bootId))
            throw new Refusal("UPDATE_ELIGIBILITY_IDENTITY_INVALID");
        if (store.Read("eligibility.json") is not null || store.Read("eligibility.pending.json") is not null)
            throw new Refusal("UPDATE_ELIGIBILITY_ALREADY_ENROLLED");
        var state = new State(installationId, ownerSid, bootId, Guid.NewGuid().ToString("D"), 1, "open", null, false, null, [], null);
        var result = new NativeUpdateEligibility(store, installationId, bootId, state, "none");
        result.Publish(state);
        return result;
    }

    internal static NativeUpdateEligibility Open(WindowsStoreIO store, string installationId)
        => OpenForBoot(store, installationId, NativeBootIdentity.Read());

    private static NativeUpdateEligibility OpenForBoot(WindowsStoreIO store, string installationId, string bootId)
    {
        // A lost publication cannot be guessed from the current file or repaired by a client.
        if (store.Read("eligibility.pending.json") is not null) throw new Refusal("UPDATE_ELIGIBILITY_PUBLICATION_PENDING");
        var file = store.Read("eligibility.json") ?? throw new Refusal("UPDATE_ELIGIBILITY_ENROLLMENT_MISSING");
        var state = Decode(file.Bytes, installationId);
        return new(store, installationId, bootId, state, file.Digest);
    }

    internal UpdateEligibilityObservation Inspect(string authenticatedOwnerSid)
    {
        RequireOwner(authenticatedOwnerSid);
        var reason = state.Phase != "open" ? "UPDATE_ADMISSION_CLOSED"
            : state.UnboundHistory ? "UPDATE_UNBOUND_ACTIVITY_HISTORY"
            : state.OpaqueBootId is not null ? "UPDATE_OPAQUE_ACTIVITY_HISTORY"
            : state.BootId != bootId ? "UPDATE_COLD_EPOCH_REQUIRED"
            : state.Writers.Length != 0 ? "UPDATE_WRITERS_ACTIVE_OR_UNKNOWN" : "UPDATE_EPOCH_ELIGIBLE";
        return new(reason == "UPDATE_EPOCH_ELIGIBLE" ? "eligible" : "held", reason, Position(), state.Writers.Length);
    }

    // Persist before dispatch; completion, proxy exit, or an empty scoped Job cannot clear it.
    internal void BeforeOpaqueDispatch(string authenticatedOwnerSid)
    {
        RequireOpen(authenticatedOwnerSid);
        Publish(Next() with { UnboundHistory = true, OpaqueBootId = bootId });
    }

    internal string BeforeKnownWriterDispatch(string authenticatedOwnerSid)
    {
        RequireOpen(authenticatedOwnerSid);
        if (state.Writers.Length >= 64) throw new Refusal("UPDATE_WRITER_LIMIT");
        var id = Guid.NewGuid().ToString("D");
        Publish(Next() with { Writers = [.. state.Writers, new Writer(id, bootId)] });
        return id;
    }

    internal void CompleteKnownWriter(string writerId, NativeUpdateWriterWitness witness)
    {
        RequireAvailable();
        var writer = state.Writers.SingleOrDefault(item => item.Id == writerId)
            ?? throw new Refusal("UPDATE_WRITER_IDENTITY_MISMATCH");
        if (writer.BootId != bootId || witness.WriterId != writerId || !witness.ObserveCessation())
            throw new Refusal("UPDATE_WRITER_CESSATION_UNVERIFIED");
        Publish(Next() with { Writers = state.Writers.Where(item => item.Id != writerId).ToArray() });
    }

    internal void Close(string authenticatedOwnerSid, UpdateEligibilityPosition expected, string transactionId)
    {
        RequireOpen(authenticatedOwnerSid);
        if (!CanonicalGuid(transactionId) || Position() != expected) throw new Refusal("UPDATE_ADMISSION_POSITION_CONFLICT");
        if (state.UnboundHistory || state.OpaqueBootId is not null || state.BootId != bootId)
            throw new Refusal("UPDATE_EPOCH_INELIGIBLE");
        Publish(Next() with { Phase = "closing", TransactionId = transactionId });
    }

    internal string Seal(string transactionId)
    {
        RequireAvailable();
        if (state.Phase != "closing" || state.TransactionId != transactionId || state.BootId != bootId
            || state.UnboundHistory || state.OpaqueBootId is not null || state.Writers.Length != 0)
            throw new Refusal("UPDATE_ADMISSION_NOT_QUIESCENT");
        var seal = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        Publish(Next() with { Phase = "sealed", Seal = seal });
        return seal;
    }

    internal void RequireSeal(string transactionId, string seal)
    {
        RequireAvailable();
        if (state.Phase != "sealed" || state.TransactionId != transactionId || state.BootId != bootId
            || !Wire.Digest(seal) || state.Seal != seal || state.UnboundHistory || state.OpaqueBootId is not null || state.Writers.Length != 0)
            throw new Refusal("UPDATE_ADMISSION_SEAL_INVALID");
    }

    // Reboot never repairs legacy history or an external target that could have installed a future launch source.
    internal void StartColdEpoch(string authenticatedOwnerSid)
    {
        RequireOwner(authenticatedOwnerSid);
        if (state.Phase != "open" || state.BootId == bootId || state.UnboundHistory || state.OpaqueBootId is not null
            || state.Writers.Any(item => item.BootId != state.BootId))
            throw new Refusal("UPDATE_COLD_EPOCH_UNVERIFIED");
        Publish(Next() with { BootId = bootId, Epoch = Guid.NewGuid().ToString("D"), Writers = [] });
    }

    internal string ResumeTransactionAfterColdBoot(string authenticatedOwnerSid, string transactionId, string maintenanceEpoch)
    {
        RequireOwner(authenticatedOwnerSid);
        if (state.BootId == bootId || state.UnboundHistory || state.OpaqueBootId is not null
            || state.Epoch != maintenanceEpoch || state.Writers.Any(item => item.BootId != state.BootId)
            || (state.Phase != "open" && (state.Phase is not ("closing" or "sealed") || state.TransactionId != transactionId)))
            throw new Refusal("UPDATE_RECOVERY_REBOOT_REQUIRED");
        var seal = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        Publish(Next() with { BootId = bootId, Phase = "sealed", TransactionId = transactionId, Writers = [], Seal = seal });
        return seal;
    }

    internal void RecordUnboundHistory()
    {
        RequireAvailable();
        Publish(Next() with { UnboundHistory = true, Phase = "held", Seal = null });
    }

    internal void ReopenAfterVerifiedTransaction(string transactionId, string seal)
    {
        RequireSeal(transactionId, seal);
        Publish(Next() with { Phase = "open", TransactionId = null, Seal = null });
    }

    internal void ReopenWithVerifiedWriter(string transactionId, string seal, NativeUpdateWriterWitness witness)
    {
        RequireSeal(transactionId, seal);
        if (!CanonicalGuid(witness.WriterId) || !witness.ObserveRunning()) throw new Refusal("UPDATE_WRITER_PROCESS_UNAVAILABLE");
        Publish(Next() with { Phase = "open", TransactionId = null, Seal = null,
            Writers = [new Writer(witness.WriterId, bootId)] });
    }

    internal UpdateEligibilityPosition ClosingPosition(string authenticatedOwnerSid)
    {
        RequireOpen(authenticatedOwnerSid);
        if (state.UnboundHistory || state.OpaqueBootId is not null || state.BootId != bootId)
            throw new Refusal("UPDATE_EPOCH_INELIGIBLE");
        return Position();
    }

    private UpdateEligibilityPosition Position() => new(installationId, state.BootId, state.Epoch, state.Revision);
    private State Next() => state with { Revision = checked(state.Revision + 1) };
    private void RequireAvailable()
    {
        if (unavailable) throw new Refusal("UPDATE_ELIGIBILITY_STORE_UNAVAILABLE");
        var current = store.Read("eligibility.json");
        if (store.Read("eligibility.pending.json") is not null || current is null || current.Digest != digest)
            throw new Refusal("UPDATE_ELIGIBILITY_POSITION_CONFLICT");
    }
    private void RequireOwner(string sid)
    {
        RequireAvailable();
        if (!String.Equals(sid, state.OwnerSid, StringComparison.Ordinal)) throw new Refusal("UPDATE_ELIGIBILITY_OWNER_MISMATCH");
    }
    private void RequireOpen(string sid)
    {
        RequireOwner(sid);
        if (state.Phase != "open" || state.BootId != bootId) throw new Refusal("UPDATE_ADMISSION_CLOSED");
    }
    private void Publish(State next)
    {
        try
        {
            var bytes = Encode(next);
            store.Stage("eligibility.pending.json", bytes);
            store.PublishStage("eligibility.pending.json", "eligibility.json", digest);
            var readback = store.Read("eligibility.json") ?? throw new Refusal("UPDATE_ELIGIBILITY_READBACK_MISSING");
            if (!readback.Bytes.AsSpan().SequenceEqual(bytes)) throw new Refusal("UPDATE_ELIGIBILITY_READBACK_CHANGED");
            state = next;
            digest = readback.Digest;
        }
        catch { unavailable = true; throw; }
    }

    private static byte[] Encode(State value) => Wire.Encode(new JsonObject
    {
        ["schema"] = 1, ["installationId"] = value.InstallationId, ["ownerSid"] = value.OwnerSid,
        ["bootId"] = value.BootId, ["epoch"] = value.Epoch, ["revision"] = Wire.Decimal(value.Revision),
        ["phase"] = value.Phase, ["transactionId"] = value.TransactionId, ["unboundHistory"] = value.UnboundHistory,
        ["opaqueBootId"] = value.OpaqueBootId, ["writers"] = new JsonArray(value.Writers.Select(item => (JsonNode)new JsonObject
        { ["id"] = item.Id, ["bootId"] = item.BootId }).ToArray()), ["seal"] = value.Seal,
    });

    private static State Decode(byte[] bytes, string installationId)
    {
        var value = Wire.Object(bytes);
        Wire.Fields(value, "schema", "installationId", "ownerSid", "bootId", "epoch", "revision", "phase", "transactionId", "unboundHistory", "opaqueBootId", "writers", "seal");
        if (Wire.Integer(value, "schema") != 1 || Wire.Text(value, "installationId") != installationId || !Wire.Digest(installationId))
            throw new Refusal("UPDATE_ELIGIBILITY_IDENTITY_MISMATCH");
        string? Optional(string name) => value[name] is null ? null : Wire.Text(value, name);
        if (value["unboundHistory"] is not JsonValue history || !history.TryGetValue<bool>(out var unbound)
            || value["writers"] is not JsonArray writers || writers.Count > 64)
            throw new Refusal("UPDATE_ELIGIBILITY_INVALID");
        var entries = writers.Select(item =>
        {
            var row = item as JsonObject ?? throw new Refusal("UPDATE_ELIGIBILITY_INVALID");
            Wire.Fields(row, "id", "bootId");
            return new Writer(Wire.Text(row, "id"), Wire.Text(row, "bootId"));
        }).ToArray();
        var result = new State(installationId, Wire.Text(value, "ownerSid"), Wire.Text(value, "bootId"), Wire.Text(value, "epoch"),
            Wire.Decimal(Wire.Text(value, "revision")), Wire.Text(value, "phase"), Optional("transactionId"), unbound, Optional("opaqueBootId"), entries, Optional("seal"));
        if (!ValidSid(result.OwnerSid) || !CanonicalGuid(result.BootId) || !CanonicalGuid(result.Epoch) || result.Revision == 0
            || result.Phase is not ("open" or "closing" or "sealed" or "held")
            || (result.TransactionId is not null && !CanonicalGuid(result.TransactionId))
            || (result.OpaqueBootId is not null && !CanonicalGuid(result.OpaqueBootId))
            || entries.Any(item => !CanonicalGuid(item.Id) || !CanonicalGuid(item.BootId)) || entries.Select(item => item.Id).Distinct().Count() != entries.Length
            || (result.Phase is "closing" or "sealed" && result.TransactionId is null)
            || (result.Phase == "open" && (result.TransactionId is not null || result.Seal is not null))
            || (result.Phase == "sealed" && (result.Seal is null || !Wire.Digest(result.Seal) || unbound || result.OpaqueBootId is not null || entries.Length != 0))
            || (result.Phase != "sealed" && result.Seal is not null) || !bytes.AsSpan().SequenceEqual(Encode(result)))
            throw new Refusal("UPDATE_ELIGIBILITY_INVALID");
        return result;
    }

    private static bool ValidSid(string sid) => sid.Length is > 6 and <= 184 && sid.StartsWith("S-1-", StringComparison.Ordinal)
        && sid[4..].Split('-').All(component => component.Length is > 0 and <= 10 && component.All(char.IsAsciiDigit));
    private static bool CanonicalGuid(string text) => Guid.TryParseExact(text, "D", out var value) && value != Guid.Empty && value.ToString("D") == text;

#if NATIVE_UPDATE_TESTS || NATIVE_CONTAINMENT_TESTS
    internal static NativeUpdateEligibility EnrollFixture(WindowsStoreIO store, string installationId, string ownerSid, string bootId)
        => EnrollForBoot(store, installationId, ownerSid, bootId);
    internal static NativeUpdateEligibility OpenFixture(WindowsStoreIO store, string installationId, string bootId)
        => OpenForBoot(store, installationId, bootId);
#endif
}

[SupportedOSPlatform("windows")]
internal static class NativeBootIdentity
{
    [StructLayout(LayoutKind.Sequential)] private struct BootEnvironment { internal Guid Id; internal uint Firmware; internal ulong Flags; }
    [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtQuerySystemInformation(int informationClass, out BootEnvironment value, uint size, out uint returned);
    internal static string Read()
    {
        // Unsupported native boot information holds enrollment; wall-clock/uptime guesses never clear history.
        var size = (uint)Marshal.SizeOf<BootEnvironment>();
        if (NtQuerySystemInformation(90, out var value, size, out var returned) != 0 || returned != size || value.Id == Guid.Empty)
            throw new Refusal("UPDATE_NATIVE_BOOT_IDENTITY_UNAVAILABLE");
        return value.Id.ToString("D");
    }
}
