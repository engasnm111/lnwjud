using System.Text.Json.Nodes;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateWorker;

internal sealed record NativeUpdateHealthEvidence
{
    internal string Target { get; }
    internal string TransactionId { get; }
    internal string SlotDigest { get; }
    internal string DataGenerationId { get; }
    internal string DataManifestDigest { get; }
    internal string Version { get; }
    internal int ProcessId { get; }
    internal string CreationTime { get; }
    internal string ImageSha256 { get; }
    internal string ChallengeSha256 { get; }
    internal string ReportSha256 { get; }

    private NativeUpdateHealthEvidence(string target, string transactionId, string slotDigest,
        string dataGenerationId, string dataManifestDigest, string version, int processId, string creationTime,
        string imageSha256, string challengeSha256, string reportSha256)
        => (Target, TransactionId, SlotDigest, DataGenerationId, DataManifestDigest, Version, ProcessId, CreationTime,
            ImageSha256, ChallengeSha256, ReportSha256) = (target, transactionId, slotDigest, dataGenerationId,
            dataManifestDigest, version, processId, creationTime, imageSha256, challengeSha256, reportSha256);
    [SupportedOSPlatform("windows")]
    internal static NativeUpdateHealthEvidence Capture(UpdateTransactionJournal transaction, bool previous,
        string expectedVersion, NativeUpdateWriterWitness witness, string challenge, JsonObject report)
    {
        Wire.Fields(report, "transactionId", "challenge", "version", "dataGenerationId", "migrationReady", "runtimeReady", "tunnelConnected", "profileDigest");
        var data = previous ? transaction.PreviousDataGeneration : transaction.CandidateDataGeneration;
        var connected = report["tunnelConnected"] is JsonValue value && value.TryGetValue<bool>(out var actual)
            ? actual : throw new Refusal("UPDATE_HEALTH_REPORT_INVALID");
        var profile = report["profileDigest"] is null ? null : Wire.Text(report, "profileDigest");
        if (!Wire.Digest(challenge) || Wire.Text(report, "challenge") != challenge
            || Wire.Text(report, "transactionId") != transaction.TransactionId
            || Wire.Text(report, "version") != expectedVersion || Wire.Text(report, "dataGenerationId") != data.Id
            || report["migrationReady"]?.GetValue<bool>() != true || report["runtimeReady"]?.GetValue<bool>() != true
            || (transaction.Tunnel.Enabled && profile != transaction.Tunnel.ProfileDigest)
            || (transaction.Tunnel.WasConnected && !connected) || (!transaction.Tunnel.Enabled && connected)
            || !witness.ObserveRunning()) throw new Refusal("UPDATE_HEALTH_UNVERIFIED");
        _ = StableVersion.Parse(expectedVersion);
        return new(previous ? "previous" : "candidate", transaction.TransactionId,
            previous ? transaction.PreviousSlotDigest : transaction.CandidateSlotDigest, data.Id, data.ManifestDigest,
            expectedVersion, witness.ProcessId, witness.CreationTime, witness.ImageSha256,
            ReleaseTrustPolicy.Hash(Wire.Utf8.GetBytes(challenge)), ReleaseTrustPolicy.Hash(Wire.Encode(report)));
    }

    internal bool Matches(UpdateTransactionJournal transaction, bool previous)
    {
        var data = previous ? transaction.PreviousDataGeneration : transaction.CandidateDataGeneration;
        return Target == (previous ? "previous" : "candidate") && TransactionId == transaction.TransactionId
            && SlotDigest == (previous ? transaction.PreviousSlotDigest : transaction.CandidateSlotDigest)
            && DataGenerationId == data.Id && DataManifestDigest == data.ManifestDigest
            && (previous || Version == transaction.CandidateVersion) && ProcessId > 0 && Wire.Decimal(CreationTime) > 0
            && Wire.Digest(ImageSha256) && Wire.Digest(ChallengeSha256) && Wire.Digest(ReportSha256);
    }

    internal JsonObject Encode() => new()
    {
        ["target"] = Target, ["transactionId"] = TransactionId, ["slotDigest"] = SlotDigest,
        ["dataGenerationId"] = DataGenerationId, ["dataManifestDigest"] = DataManifestDigest, ["version"] = Version,
        ["processId"] = ProcessId, ["creationTime"] = CreationTime, ["imageSha256"] = ImageSha256,
        ["challengeSha256"] = ChallengeSha256, ["reportSha256"] = ReportSha256,
    };

    internal static NativeUpdateHealthEvidence Decode(JsonObject value)
    {
        Wire.Fields(value, "target", "transactionId", "slotDigest", "dataGenerationId", "dataManifestDigest", "version",
            "processId", "creationTime", "imageSha256", "challengeSha256", "reportSha256");
        var result = new NativeUpdateHealthEvidence(Wire.Text(value, "target"), Wire.Text(value, "transactionId"),
            Wire.Text(value, "slotDigest"), Wire.Text(value, "dataGenerationId"), Wire.Text(value, "dataManifestDigest"),
            Wire.Text(value, "version"), Wire.Integer(value, "processId"), Wire.Text(value, "creationTime"),
            Wire.Text(value, "imageSha256"), Wire.Text(value, "challengeSha256"), Wire.Text(value, "reportSha256"));
        _ = StableVersion.Parse(result.Version);
        return result;
    }
}
