using System.Text.Json.Nodes;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateWorker;

internal sealed record Journal(ulong Generation, ulong Revision, string PreviousDigest, ProcessOwner Owner, JsonObject Payload)
{
    internal string Phase => Wire.Text(Payload, "phase");
    internal string TransactionId => Wire.Text(Payload, "transactionId");
    internal bool Known => Phase is "preauth" or "unavailable";
    internal bool Terminal => Phase == "unavailable";

    internal byte[] Encode(string installationId) => Wire.Encode(new JsonObject
    {
        ["schema"] = 1, ["installationId"] = installationId,
        ["generation"] = Wire.Decimal(Generation), ["revision"] = Wire.Decimal(Revision),
        ["previousDigest"] = PreviousDigest,
        ["owner"] = new JsonObject { ["pid"] = Owner.Pid, ["creationTime"] = Owner.CreationTime, ["executable"] = Owner.Executable },
        ["payloadDigest"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Wire.Encode(Payload))).ToLowerInvariant(),
        ["payload"] = Payload.DeepClone()
    });

    internal static Journal Decode(byte[] bytes, string installationId)
    {
        var value = Wire.Object(bytes);
        Wire.Fields(value, "schema", "installationId", "generation", "revision", "previousDigest", "owner", "payloadDigest", "payload");
        if (Wire.Integer(value, "schema") != 1 || Wire.Text(value, "installationId") != installationId) throw new Refusal("JOURNAL_IDENTITY_MISMATCH");
        var generation = Wire.Decimal(Wire.Text(value, "generation"));
        var revision = Wire.Decimal(Wire.Text(value, "revision"));
        if (generation == 0 || revision == 0) throw new Refusal("JOURNAL_INVALID");
        var previous = Wire.Text(value, "previousDigest");
        if (previous != "none" && !Wire.Digest(previous)) throw new Refusal("JOURNAL_INVALID");
        var owner = value["owner"] as JsonObject ?? throw new Refusal("JOURNAL_INVALID");
        Wire.Fields(owner, "pid", "creationTime", "executable");
        var pid = Wire.Integer(owner, "pid");
        var creation = Wire.Text(owner, "creationTime");
        var executable = Wire.Text(owner, "executable");
        if (pid <= 0 || Wire.Decimal(creation) == 0 || executable.Length is < 1 or > 32768 || !Path.IsPathFullyQualified(executable)) throw new Refusal("JOURNAL_INVALID");
        var payload = value["payload"] as JsonObject ?? throw new Refusal("JOURNAL_INVALID");
        var digest = Wire.Text(value, "payloadDigest");
        if (!Wire.Digest(digest) || digest != Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Wire.Encode(payload))).ToLowerInvariant()) throw new Refusal("JOURNAL_CHECKSUM_INVALID");
        var transaction = Wire.Text(payload, "transactionId");
        if (!Guid.TryParseExact(transaction, "D", out var guid) || guid.ToString("D") != transaction) throw new Refusal("JOURNAL_INVALID");
        var phase = Wire.Text(payload, "phase");
        if (phase is "preauth" or "unavailable")
        {
            Wire.Fields(payload, phase == "preauth"
                ? ["transactionId", "requestId", "releaseId", "policyRevision", "phase", "effects", "history"]
                : ["transactionId", "requestId", "releaseId", "policyRevision", "phase", "effects", "history", "reason"]);
            if (!Wire.Identifier(Wire.Text(payload, "requestId")) || !Wire.Identifier(Wire.Text(payload, "releaseId"))
                || Wire.Integer(payload, "policyRevision") < 1 || Wire.Text(payload, "effects") != "none"
                || (phase == "unavailable" && Wire.Text(payload, "reason") != "PACKAGE_AUTHENTICATION_UNAVAILABLE")) throw new Refusal("JOURNAL_INVALID");
            if (payload["history"] is not JsonArray history || history.Count > 64) throw new Refusal("JOURNAL_INVALID");
            var ids = new HashSet<string>(StringComparer.Ordinal) { Wire.Text(payload, "requestId") };
            foreach (var item in history)
            {
                if (item is not JsonObject receipt) throw new Refusal("JOURNAL_INVALID");
                Wire.Fields(receipt, "requestId", "releaseId", "policyRevision", "transactionId");
                var oldTransaction = Wire.Text(receipt, "transactionId");
                if (!Wire.Identifier(Wire.Text(receipt, "requestId")) || !ids.Add(Wire.Text(receipt, "requestId"))
                    || !Wire.Identifier(Wire.Text(receipt, "releaseId")) || Wire.Integer(receipt, "policyRevision") < 1
                    || !Guid.TryParseExact(oldTransaction, "D", out var oldGuid) || oldGuid.ToString("D") != oldTransaction) throw new Refusal("JOURNAL_INVALID");
            }
        }
        return new Journal(generation, revision, previous, new ProcessOwner(pid, creation, executable), payload);
    }
}

[SupportedOSPlatform("windows")]
internal sealed class UpdateWorkerCore : IDisposable
{
    private readonly WindowsStoreIO io;
    private readonly string installationId;
    private readonly ProcessOwner owner = WindowsStoreIO.CurrentOwner();
    private readonly Action<string>? boundary;
    internal UpdateWorkerCore(string root, string installationId, Action<string>? boundary = null)
    { io = new WindowsStoreIO(root); this.installationId = installationId; this.boundary = boundary; }

    internal JsonObject Execute(Command command)
    {
        Journal? current = null;
        try
        {
            var file = io.Read("journal.json");
            if (file is not null) current = Journal.Decode(file.Bytes, installationId);
            if (command.Name == "capabilities") return Reply(command.RequestId, current, new JsonObject
            { ["kind"] = "capabilities", ["platform"] = "windows", ["architecture"] = "x64", ["automaticInstallation"] = "unavailable", ["reason"] = "TRANSACTION_BOOTSTRAP_ONLY" });
            var pending = io.Read("journal.pending.json");
            if (pending is not null)
            {
                if (command.Name != "recover") return Held(command.RequestId, current, "PUBLICATION_PENDING");
                var staged = Journal.Decode(pending.Bytes, installationId);
                if (!staged.Known || staged.PreviousDigest != (file?.Digest ?? "none") || staged.Revision != checked((current?.Revision ?? 0) + 1)
                    || staged.Generation < (current?.Generation ?? 1) || staged.Generation > checked((current?.Generation ?? 0) + 1)
                    || !MayAdopt(staged.Owner)) return Held(command.RequestId, current, "PENDING_STATE_UNVERIFIED");
                io.PublishStage(staged.PreviousDigest);
                file = io.Read("journal.json");
                current = staged;
            }
            if (current is not null && !current.Known) return Held(command.RequestId, current, "UNSUPPORTED_PENDING_PHASE");
            if (command.Name == "status") return current is null || current.Terminal
                ? Reply(command.RequestId, current, new JsonObject { ["kind"] = "none", ["safeToStart"] = true })
                : Held(command.RequestId, current, "PREAUTH_PENDING");
            if (command.Name == "recover")
            {
                if (current is null || current.Terminal) return Reply(command.RequestId, current, new JsonObject { ["kind"] = "none", ["safeToStart"] = true });
                if (!MayAdopt(current.Owner)) return Held(command.RequestId, current, "PREVIOUS_OWNER_UNVERIFIED");
                current = Finish(current, file!.Digest);
                return Reply(command.RequestId, current, Outcome(current, "recovered", "PREAUTH_OWNER_RECOVERED"));
            }
            if (current is not null && !current.Terminal) return Held(command.RequestId, current,
                Wire.Text(current.Payload, "requestId") == command.RequestId ? "PREAUTH_PENDING" : "TRANSACTION_BUSY");
            var matching = current is null ? null : Wire.Text(current.Payload, "requestId") == command.RequestId
                ? current.Payload : ((JsonArray)current.Payload["history"]!).OfType<JsonObject>().FirstOrDefault(item => Wire.Text(item, "requestId") == command.RequestId);
            if (matching is not null)
            {
                if (Wire.Text(matching, "releaseId") != command.ReleaseId || Wire.Integer(matching, "policyRevision") != command.PolicyRevision)
                    throw new Refusal("REQUEST_ID_CONFLICT");
                var outcome = Outcome(current!, "unavailable", "PACKAGE_AUTHENTICATION_UNAVAILABLE");
                outcome["transactionId"] = Wire.Text(matching, "transactionId");
                return Reply(command.RequestId, current, outcome);
            }
            if (command.ExpectedGeneration != (current?.Generation ?? 0) || command.ExpectedRevision != (current?.Revision ?? 0)) throw new Refusal("POSITION_CONFLICT");
            if (current is not null && !MayAdopt(current.Owner)) return Held(command.RequestId, current, "PREVIOUS_OWNER_UNVERIFIED");
            var history = current is null ? new JsonArray() : (JsonArray)current.Payload["history"]!.DeepClone();
            if (current is not null)
            {
                if (history.Count >= 64) throw new Refusal("REQUEST_HISTORY_FULL");
                history.Add(new JsonObject { ["requestId"] = current.Payload["requestId"]!.DeepClone(), ["releaseId"] = current.Payload["releaseId"]!.DeepClone(),
                    ["policyRevision"] = current.Payload["policyRevision"]!.DeepClone(), ["transactionId"] = current.TransactionId });
            }
            var payload = new JsonObject { ["transactionId"] = Guid.NewGuid().ToString("D"), ["requestId"] = command.RequestId,
                ["releaseId"] = command.ReleaseId, ["policyRevision"] = command.PolicyRevision, ["phase"] = "preauth", ["effects"] = "none", ["history"] = history };
            var preauth = new Journal(checked((current?.Generation ?? 0) + 1), checked((current?.Revision ?? 0) + 1), file?.Digest ?? "none", owner, payload);
            Commit(preauth);
            boundary?.Invoke("preauth-committed");
            current = Finish(preauth, io.Read("journal.json")!.Digest);
            return Reply(command.RequestId, current, Outcome(current, "unavailable", "PACKAGE_AUTHENTICATION_UNAVAILABLE"));
        }
        catch (Refusal error) { return Unverified(command.RequestId, current, error.Reason); }
        catch (Exception) { return Unverified(command.RequestId, current, "JOURNAL_UNVERIFIED"); }
    }

    private bool MayAdopt(ProcessOwner previous) => previous == owner || WindowsStoreIO.Observe(previous) == "gone";
    private Journal Finish(Journal previous, string digest)
    {
        var payload = (JsonObject)previous.Payload.DeepClone();
        payload["phase"] = "unavailable"; payload["reason"] = "PACKAGE_AUTHENTICATION_UNAVAILABLE";
        var terminal = new Journal(previous.Owner == owner ? previous.Generation : checked(previous.Generation + 1), checked(previous.Revision + 1), digest, owner, payload);
        Commit(terminal);
        return terminal;
    }
    private void Commit(Journal journal)
    {
        io.Stage(journal.Encode(installationId)); boundary?.Invoke("stage-flushed");
        io.PublishStage(journal.PreviousDigest); boundary?.Invoke("publication-readback");
    }
    private static JsonObject Outcome(Journal journal, string kind, string reason) => new()
    { ["kind"] = kind, ["reason"] = reason, ["safeToStart"] = true, ["transactionId"] = journal.TransactionId, ["phase"] = "unavailable" };
    private JsonObject Held(string id, Journal? journal, string reason)
    {
        var result = new JsonObject { ["kind"] = "held", ["reason"] = reason, ["safeToStart"] = false };
        if (journal is not null) result["transactionId"] = journal.TransactionId;
        return Reply(id, journal, result);
    }
    private JsonObject Unverified(string id, Journal? journal, string reason) => journal is not null ? Held(id, journal, reason)
        : Envelope(installationId, id, null, null, new JsonObject { ["kind"] = "held", ["reason"] = reason, ["safeToStart"] = false });
    internal JsonObject Reply(string? id, Journal? journal, JsonObject result) => Envelope(installationId, id,
        journal is null ? "0" : Wire.Decimal(journal.Generation), journal is null ? "0" : Wire.Decimal(journal.Revision), result);
    internal static JsonObject Envelope(string installationId, string? id, string? generation, string? revision, JsonObject result) => new()
    { ["protocol"] = 1, ["buildId"] = Wire.BuildId, ["installationId"] = installationId, ["requestId"] = id,
        ["generation"] = generation, ["revision"] = revision, ["result"] = result };
    public void Dispose() => io.Dispose();
}
