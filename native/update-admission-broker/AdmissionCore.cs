using System.Runtime.Versioning;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateAdmission;

internal sealed record AdmissionStatus(string Phase, string Epoch, ulong Revision, string TransactionId, ulong Generation, int HeldPermits, int UnquiescedParticipants, string Digest);
internal sealed record DrainReceipt(string Domain, string Epoch, string TransactionId, ulong Generation, ulong Revision, string Digest);

[SupportedOSPlatform("windows")]
internal sealed class AdmissionCore : IDisposable
{
    private readonly AdmissionStore store;
    private readonly object gate = new();
    private JsonObject state;
    private NativeFile current;
    private bool poisoned;
#if ADMISSION_ISOLATED_TESTS
    internal Action? AfterStage { get; set; }
#endif

    internal AdmissionCore(StoreIdentity identity)
    {
        store = new AdmissionStore(identity);
        try
        {
            if (store.Read("admission.pending.json") is not null) throw new Refusal("ADMISSION_PUBLICATION_PENDING");
            var existing = store.Read("admission.json");
            current = existing ?? throw new Refusal("ADMISSION_STATE_MISSING"); state = Parse(current.Bytes).State;
        }
        catch { store.Dispose(); throw; }
    }

#if ADMISSION_ISOLATED_TESTS
    internal static void InitializeIsolated(StoreIdentity identity)
    {
        using var io = new AdmissionStore(identity);
        io.MarkFreshBootstrap();
        if (io.Read("admission.json") is not null || io.Read("admission.pending.json") is not null) throw new Refusal("ADMISSION_BOOTSTRAP_NOT_FRESH");
        var initial = new JsonObject { ["phase"] = "open", ["epoch"] = Guid.NewGuid().ToString("D"), ["transaction"] = "", ["generation"] = "0", ["participants"] = new JsonObject(), ["permits"] = new JsonObject(), ["disposition"] = "", ["finished"] = new JsonArray() };
        io.Stage(Envelope(initial, 1, "none")); io.PublishStage("none");
    }
#endif

    internal static void RecoverPublication(StoreIdentity identity)
    {
        using var io = new AdmissionStore(identity);
        var pending = io.Read("admission.pending.json");
        if (pending is null) return;
        var next = Parse(pending.Bytes);
        var previous = io.Read("admission.json");
        if (previous is null) throw new Refusal("ADMISSION_STATE_MISSING");
        var oldRevision = Parse(previous.Bytes).Revision;
        if (next.Predecessor != previous.Digest || oldRevision == ulong.MaxValue || next.Revision != oldRevision + 1)
            throw new Refusal("ADMISSION_RECOVERY_CONFLICT");
        io.PublishStage(next.Predecessor);
    }

    private static byte[] Envelope(JsonObject state, ulong revision, string predecessor) => AdmissionProtocol.Encode(new JsonObject
    {
        ["schema"] = 1, ["domain"] = AdmissionProtocol.Domain, ["revision"] = AdmissionProtocol.Decimal(revision), ["predecessor"] = predecessor, ["state"] = state.DeepClone(),
    });

    private static (JsonObject State, ulong Revision, string Predecessor) Parse(byte[] bytes)
    {
        var envelope = AdmissionProtocol.Object(bytes, AdmissionStore.MaximumJournalBytes);
        AdmissionProtocol.Fields(envelope, "schema", "domain", "revision", "predecessor", "state");
        if (envelope["schema"]?.ToJsonString() != "1" || AdmissionProtocol.Text(envelope, "domain") != AdmissionProtocol.Domain) throw new Refusal("ADMISSION_STATE_SCHEMA");
        var revision = AdmissionProtocol.Number(envelope, "revision"); var predecessor = AdmissionProtocol.Text(envelope, "predecessor");
        if (revision == 0 || predecessor != "none" && !AdmissionProtocol.Digest(predecessor) || (revision == 1) != (predecessor == "none")) throw new Refusal("ADMISSION_STATE_POSITION");
        var value = envelope["state"] as JsonObject ?? throw new Refusal("ADMISSION_STATE_INVALID");
        AdmissionProtocol.Fields(value, "phase", "epoch", "transaction", "generation", "participants", "permits", "disposition", "finished");
        var phase = AdmissionProtocol.Text(value, "phase"); var transaction = AdmissionProtocol.Text(value, "transaction");
        if (phase is not ("open" or "closing" or "sealed") || !Guid.TryParseExact(AdmissionProtocol.Text(value, "epoch"), "D", out _)) throw new Refusal("ADMISSION_STATE_INVALID");
        var generation = AdmissionProtocol.Number(value, "generation");
        var disposition = AdmissionProtocol.Text(value, "disposition");
        if (transaction.Length == 0 ? generation != 0 || phase != "open" : !AdmissionProtocol.Identifier(transaction) || generation == 0) throw new Refusal("ADMISSION_STATE_INVALID");
        if (disposition.Length != 0 && (phase != "open" || !AdmissionProtocol.Identifier(disposition))) throw new Refusal("ADMISSION_STATE_INVALID");
        if (phase == "open" && transaction.Length != 0 && disposition.Length == 0) throw new Refusal("ADMISSION_STATE_INVALID");
        var finished = value["finished"] as JsonArray ?? throw new Refusal("ADMISSION_STATE_INVALID");
        var transactions = new HashSet<string>(StringComparer.Ordinal);
        if (finished.Count > 256) throw new Refusal("ADMISSION_STATE_LIMIT");
        foreach (var item in finished)
        {
            if (item is not JsonValue text || !text.TryGetValue<string>(out var id) || !AdmissionProtocol.Identifier(id) || !transactions.Add(id)) throw new Refusal("ADMISSION_STATE_INVALID");
        }
        if (transaction.Length != 0 && transactions.Contains(transaction) != (phase == "open")) throw new Refusal("ADMISSION_STATE_INVALID");
        var participants = value["participants"] as JsonObject ?? throw new Refusal("ADMISSION_STATE_INVALID");
        var permits = value["permits"] as JsonObject ?? throw new Refusal("ADMISSION_STATE_INVALID");
        if (participants.Count > 128 || permits.Count > 512) throw new Refusal("ADMISSION_STATE_LIMIT");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in participants)
        {
            var item = entry.Value as JsonObject ?? throw new Refusal("ADMISSION_STATE_INVALID"); AdmissionProtocol.Fields(item, "identity", "status", "issued", "settledThrough");
            var issued = AdmissionProtocol.Number(item, "issued"); var settled = AdmissionProtocol.Number(item, "settledThrough");
            if (settled > issued || issued - settled > 512) throw new Refusal("ADMISSION_STATE_INVALID");
            if (!AdmissionProtocol.Identifier(entry.Key) || !AdmissionProtocol.Identifier(AdmissionProtocol.Text(item, "identity")) || !identities.Add(AdmissionProtocol.Text(item, "identity"))
                || AdmissionProtocol.Text(item, "status") is not ("active" or "quiesced" or "quarantined")) throw new Refusal("ADMISSION_STATE_INVALID");
        }
        foreach (var entry in permits)
        {
            var item = entry.Value as JsonObject ?? throw new Refusal("ADMISSION_STATE_INVALID"); AdmissionProtocol.Fields(item, "participant", "kind", "status", "attempt");
            var participant = AdmissionProtocol.Text(item, "participant"); var kind = AdmissionProtocol.Text(item, "kind"); var status = AdmissionProtocol.Text(item, "status"); var attempt = AdmissionProtocol.Text(item, "attempt");
            if (!AdmissionProtocol.Identifier(entry.Key) || participants[participant] is not JsonObject member || kind is not ("startup" or "call" or "background" or "job") || status is not ("held" or "settled")
                || (kind == "job" ? !AdmissionProtocol.Identifier(attempt) : attempt.Length != 0)
                || status == "held" && AdmissionProtocol.Text(member, "status") != "active") throw new Refusal("ADMISSION_STATE_INVALID");
            var prefix = participant + ".";
            if (!entry.Key.StartsWith(prefix, StringComparison.Ordinal)) throw new Refusal("ADMISSION_STATE_INVALID");
            var sequence = AdmissionProtocol.Decimal(entry.Key[prefix.Length..]);
            if (sequence <= AdmissionProtocol.Number(member, "settledThrough") || sequence > AdmissionProtocol.Number(member, "issued")) throw new Refusal("ADMISSION_STATE_INVALID");
        }
        foreach (var entry in participants)
        {
            var member = (JsonObject)entry.Value!;
            if ((ulong)permits.Count(x => AdmissionProtocol.Text((JsonObject)x.Value!, "participant") == entry.Key) != AdmissionProtocol.Number(member, "issued") - AdmissionProtocol.Number(member, "settledThrough")) throw new Refusal("ADMISSION_STATE_INVALID");
        }
        if (phase == "sealed" && (Held(value) != 0 || Active(value) != 0)) throw new Refusal("ADMISSION_STATE_INVALID");
        return (value, revision, predecessor);
    }

    private static int Held(JsonObject value) => ((JsonObject)value["permits"]!).Count(entry => AdmissionProtocol.Text((JsonObject)entry.Value!, "status") == "held");
    private static int Active(JsonObject value) => ((JsonObject)value["participants"]!).Count(entry => AdmissionProtocol.Text((JsonObject)entry.Value!, "status") == "active");
    private static string Field(JsonObject value, string name) => AdmissionProtocol.Text(value, name);
    private void Available() { if (poisoned) throw new Refusal("ADMISSION_OWNER_UNCERTAIN"); }
    private ulong Revision => AdmissionProtocol.Number(AdmissionProtocol.Object(current.Bytes, AdmissionStore.MaximumJournalBytes), "revision");
    private void Save(JsonObject next)
    {
        Available(); if (Revision == ulong.MaxValue) throw new Refusal("ADMISSION_POSITION_EXHAUSTED");
        var bytes = Envelope(next, Revision + 1, current.Digest); _ = Parse(bytes);
        try
        {
            store.Stage(bytes);
#if ADMISSION_ISOLATED_TESTS
            AfterStage?.Invoke();
#endif
            store.PublishStage(current.Digest);
            current = store.Read("admission.json") ?? throw new Refusal("ADMISSION_STATE_MISSING"); state = Parse(current.Bytes).State;
        }
        catch { poisoned = true; throw; }
    }

    internal AdmissionStatus Status()
    {
        lock (gate) { Available(); return new(Field(state, "phase"), Field(state, "epoch"), Revision, Field(state, "transaction"), AdmissionProtocol.Number(state, "generation"), Held(state), Active(state), current.Digest); }
    }

    internal string Register(RuntimePrincipal principal)
    {
        lock (gate)
        {
            Available(); if (principal.Retired) throw new Refusal("ADMISSION_PRINCIPAL_RETIRED"); var members = (JsonObject)state["participants"]!;
            var previous = members.FirstOrDefault(x => Field((JsonObject)x.Value!, "identity") == principal.Identity);
            if (previous.Value is not null) return previous.Key;
            if (members.Count == 128) throw new Refusal("ADMISSION_PARTICIPANT_LIMIT");
            var id = Guid.NewGuid().ToString("D"); var next = (JsonObject)state.DeepClone();
            ((JsonObject)next["participants"]!)[id] = new JsonObject { ["identity"] = principal.Identity, ["status"] = Field(state, "phase") == "open" ? "active" : "quarantined", ["issued"] = "0", ["settledThrough"] = "0" }; Save(next); return id;
        }
    }

    private JsonObject Member(RuntimePrincipal principal, string id)
    {
        Available();
        if (principal.Retired) throw new Refusal("ADMISSION_PRINCIPAL_RETIRED");
        if (((JsonObject)state["participants"]!)[id] is not JsonObject member || Field(member, "identity") != principal.Identity) throw new Refusal("ADMISSION_PARTICIPANT_MISMATCH");
        return member;
    }

    internal string Enter(RuntimePrincipal principal, string participant, ulong sequence, string kind) => AddPermit(principal, participant, sequence, kind, "", null);
    internal string Promote(RuntimePrincipal principal, string participant, ulong sequence, string attemptId, string parent) => AddPermit(principal, participant, sequence, "job", attemptId, parent);
    private string AddPermit(RuntimePrincipal principal, string participant, ulong sequence, string kind, string attempt, string? parent)
    {
        lock (gate)
        {
            var member = Member(principal, participant); var permits = (JsonObject)state["permits"]!;
            var id = participant + "." + AdmissionProtocol.Decimal(sequence);
            if (sequence == 0 || sequence <= AdmissionProtocol.Number(member, "settledThrough")) throw new Refusal("ADMISSION_PERMIT_ALREADY_SETTLED");
            if (!AdmissionProtocol.Identifier(id) || kind is not ("startup" or "call" or "background" or "job") || kind == "job" && !AdmissionProtocol.Identifier(attempt)) throw new Refusal("ADMISSION_PERMIT_INVALID");
            if (permits[id] is JsonObject old)
            {
                if (Field(old, "participant") != participant || Field(old, "kind") != kind || Field(old, "attempt") != attempt) throw new Refusal("ADMISSION_PERMIT_CONFLICT");
                if (Field(old, "status") != "held") throw new Refusal("ADMISSION_PERMIT_ALREADY_SETTLED"); return id;
            }
            var issued = AdmissionProtocol.Number(member, "issued");
            if (issued == ulong.MaxValue || sequence != issued + 1) throw new Refusal("ADMISSION_SEQUENCE_CONFLICT");
            if (Field(member, "status") != "active") throw new Refusal("ADMISSION_PARTICIPANT_QUIESCENT");
            if (parent is null ? Field(state, "phase") != "open" : Field(state, "phase") == "sealed") throw new Refusal("ADMISSION_CLOSED");
            if (parent is not null && (permits[parent] is not JsonObject owned || Field(owned, "participant") != participant || Field(owned, "status") != "held" || Field(owned, "kind") == "job")) throw new Refusal("ADMISSION_PARENT_INVALID");
            if (permits.Count == 512) throw new Refusal("ADMISSION_PERMIT_LIMIT");
            var next = (JsonObject)state.DeepClone(); ((JsonObject)next["permits"]!)[id] = new JsonObject { ["participant"] = participant, ["kind"] = kind, ["status"] = "held", ["attempt"] = attempt };
            ((JsonObject)((JsonObject)next["participants"]!)[participant]!)["issued"] = AdmissionProtocol.Decimal(sequence); Save(next); return id;
        }
    }

    internal void Settle(RuntimePrincipal principal, string permitId, NativeEvidence proof)
    {
        lock (gate)
        {
            Available(); var permit = ((JsonObject)state["permits"]!)[permitId] as JsonObject;
            if (permit is null)
            {
                var split = permitId.LastIndexOf('.'); if (split < 1) throw new Refusal("ADMISSION_PERMIT_UNKNOWN");
                var priorMember = Member(principal, permitId[..split]); var sequence = AdmissionProtocol.Decimal(permitId[(split + 1)..]);
                if (sequence == 0 || sequence > AdmissionProtocol.Number(priorMember, "settledThrough") || proof.Binding != permitId || proof.Kind is not (SettlementKind.OperationSettled or SettlementKind.NativeJobZeroAndReleased)) throw new Refusal("ADMISSION_PERMIT_UNKNOWN");
                return;
            }
            _ = Member(principal, Field(permit, "participant"));
            var required = Field(permit, "kind") == "job" ? SettlementKind.NativeJobZeroAndReleased : SettlementKind.OperationSettled;
            if (proof.Kind != required || proof.Binding != permitId) throw new Refusal("ADMISSION_SETTLEMENT_UNPROVEN");
            if (Field(permit, "status") == "settled") return;
            var next = (JsonObject)state.DeepClone(); var records = (JsonObject)next["permits"]!; ((JsonObject)records[permitId]!)["status"] = "settled";
            var participant = Field(permit, "participant"); var member = (JsonObject)((JsonObject)next["participants"]!)[participant]!;
            var watermark = AdmissionProtocol.Number(member, "settledThrough"); var issued = AdmissionProtocol.Number(member, "issued");
            while (watermark < issued)
            {
                var id = participant + "." + AdmissionProtocol.Decimal(watermark + 1);
                if (records[id] is not JsonObject record || Field(record, "status") != "settled") break;
                records.Remove(id); watermark++;
            }
            member["settledThrough"] = AdmissionProtocol.Decimal(watermark); Save(next);
        }
    }

    internal void RetireParticipant(RuntimePrincipal principal, string participant, NativeEvidence proof)
    {
        lock (gate)
        {
            var member = Member(principal, participant);
            if (proof.Kind != SettlementKind.OwnerCessation || proof.Binding != $"{principal.Identity}:{participant}") throw new Refusal("ADMISSION_PARTICIPANT_CESSATION_UNPROVEN");
            if (Field(member, "status") == "active" || AdmissionProtocol.Number(member, "issued") != AdmissionProtocol.Number(member, "settledThrough")) throw new Refusal("ADMISSION_WORK_HELD");
            var next = (JsonObject)state.DeepClone(); ((JsonObject)next["participants"]!).Remove(participant); Save(next); principal.Retire();
        }
    }

    internal void Quiesce(RuntimePrincipal principal, string participant, NativeEvidence proof)
    {
        lock (gate)
        {
            var member = Member(principal, participant);
            if (proof.Kind != SettlementKind.ParticipantQuiesced || proof.Binding != $"{participant}:{Field(state, "epoch")}") throw new Refusal("ADMISSION_QUIESCENCE_UNPROVEN");
            if (((JsonObject)state["permits"]!).Any(x => Field((JsonObject)x.Value!, "participant") == participant && Field((JsonObject)x.Value!, "status") == "held")) throw new Refusal("ADMISSION_WORK_HELD");
            if (Field(member, "status") != "active") return;
            var next = (JsonObject)state.DeepClone(); ((JsonObject)((JsonObject)next["participants"]!)[participant]!)["status"] = "quiesced"; Save(next);
        }
    }

    private void Owner(UpdatePrincipal owner, ulong expectedRevision)
    {
        Available(); if (Field(state, "transaction") != owner.TransactionId || AdmissionProtocol.Number(state, "generation") != owner.Generation) throw new Refusal("ADMISSION_OWNER_FENCED");
        if (Revision != expectedRevision) throw new Refusal("ADMISSION_REVISION_CONFLICT");
    }
    internal void Close(UpdatePrincipal owner, ulong expectedRevision)
    {
        lock (gate)
        {
            Available();
            if (Field(state, "phase") != "open") { Owner(owner, expectedRevision); return; }
            if (((JsonArray)state["finished"]!).Any(item => item!.GetValue<string>() == owner.TransactionId)) throw new Refusal("ADMISSION_TRANSACTION_FINISHED");
            if (((JsonArray)state["finished"]!).Count == 256) throw new Refusal("ADMISSION_TRANSACTION_LIMIT");
            if (Revision != expectedRevision || owner.Generation != 1) throw new Refusal("ADMISSION_REVISION_CONFLICT");
            var next = (JsonObject)state.DeepClone(); next["phase"] = "closing"; next["epoch"] = Guid.NewGuid().ToString("D"); next["transaction"] = owner.TransactionId; next["generation"] = AdmissionProtocol.Decimal(owner.Generation); next["disposition"] = ""; Save(next);
        }
    }

    internal DrainReceipt Seal(UpdatePrincipal owner, ulong expectedRevision)
    {
        lock (gate)
        {
            Owner(owner, expectedRevision); if (Field(state, "phase") == "open" || Held(state) != 0 || Active(state) != 0) throw new Refusal("ADMISSION_DRAIN_INCOMPLETE");
            if (Field(state, "phase") != "sealed") { var next = (JsonObject)state.DeepClone(); next["phase"] = "sealed"; Save(next); }
            return new(AdmissionProtocol.Domain, Field(state, "epoch"), owner.TransactionId, owner.Generation, Revision, current.Digest);
        }
    }

    internal void RecoverOwner(UpdatePrincipal successor, ulong expectedRevision, NativeEvidence proof)
    {
        lock (gate)
        {
            Available(); var generation = AdmissionProtocol.Number(state, "generation");
            if (Field(state, "phase") == "open" || Field(state, "transaction") != successor.TransactionId || generation == ulong.MaxValue || successor.Generation != generation + 1 || Revision != expectedRevision
                || proof.Kind != SettlementKind.OwnerCessation || proof.Binding != $"{successor.TransactionId}:{generation}") throw new Refusal("ADMISSION_OWNER_RECOVERY_UNPROVEN");
            var next = (JsonObject)state.DeepClone(); next["generation"] = AdmissionProtocol.Decimal(successor.Generation); next["phase"] = "closing"; Save(next);
        }
    }

    internal void Reopen(UpdatePrincipal owner, ulong expectedRevision, string dispositionId, NativeEvidence proof)
    {
        lock (gate)
        {
            Owner(owner, expectedRevision);
            if (!AdmissionProtocol.Identifier(dispositionId) || proof.Kind != SettlementKind.AcceptedDisposition || proof.Binding != $"{owner.TransactionId}:{owner.Generation}:{Field(state, "epoch")}:{dispositionId}") throw new Refusal("ADMISSION_DISPOSITION_UNPROVEN");
            if (Field(state, "phase") == "open") { if (Field(state, "disposition") != dispositionId) throw new Refusal("ADMISSION_DISPOSITION_CONFLICT"); return; }
            if (Field(state, "phase") != "sealed") throw new Refusal("ADMISSION_DRAIN_INCOMPLETE");
            var next = (JsonObject)state.DeepClone(); next["phase"] = "open"; next["disposition"] = dispositionId;
            ((JsonArray)next["finished"]!).Add(owner.TransactionId);
            foreach (var member in (JsonObject)next["participants"]!) ((JsonObject)member.Value!)["status"] = "active";
            Save(next);
        }
    }
    public void Dispose() { lock (gate) { poisoned = true; store.Dispose(); } }
}
