using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal sealed record NativeInstalledUpdate(string InstallationId, string OwnerSid, string ProfileRoot,
    string Layout, string? Envelope, string? IdentityDigest, string? AcceptanceDigest, string? Version,
    ulong Sequence, ulong AcceptedAt, ReleaseAuthorizationPurpose Purpose, Dictionary<string, string> DataPaths)
{
    internal string[] FailedCandidates { get; init; } = [];
    internal bool Accepted => Envelope is not null && IdentityDigest is not null && AcceptanceDigest is not null && Version is not null;
    internal WindowsBaselineLayout ReadLayout() => WindowsBaselineLayout.Parse(Convert.FromBase64String(Layout),
        ReleaseTrustPolicy.Hash(Convert.FromBase64String(Layout)));
    internal RetainedAuthorizationV2 Retained() => Accepted
        ? new(Convert.FromBase64String(Envelope!), Purpose, ReleaseTrustPolicy.Hash(Convert.FromBase64String(Envelope!)),
            IdentityDigest!, AcceptanceDigest!, AcceptedAt) : throw new Refusal("RELEASE_TRUSTED_BASELINE_UNAVAILABLE");
    internal string DataPath(DataGeneration generation) => DataPaths.TryGetValue(generation.Id, out var path)
        ? path : throw new Refusal("UPDATE_DATA_GENERATION_MISSING");

    internal JsonObject Encode() => new()
    {
        ["schema"] = 1, ["installationId"] = InstallationId, ["ownerSid"] = OwnerSid, ["profileRoot"] = ProfileRoot,
        ["layout"] = Layout, ["envelope"] = Envelope, ["identityDigest"] = IdentityDigest,
        ["acceptanceDigest"] = AcceptanceDigest, ["version"] = Version, ["sequence"] = Wire.Decimal(Sequence),
        ["acceptedAt"] = Wire.Decimal(AcceptedAt), ["purpose"] = Purpose == ReleaseAuthorizationPurpose.Baseline ? "baseline" : "update",
        ["dataPaths"] = new JsonObject(DataPaths.Select(entry => KeyValuePair.Create<string, JsonNode?>(entry.Key, JsonValue.Create(entry.Value)))),
        ["failedCandidates"] = new JsonArray(FailedCandidates.Select(value => (JsonNode)JsonValue.Create(value)!).ToArray()),
    };

    internal static NativeInstalledUpdate Decode(byte[] bytes)
    {
        var value = Wire.Object(bytes);
        Wire.Fields(value, "schema", "installationId", "ownerSid", "profileRoot", "layout", "envelope", "identityDigest",
            "acceptanceDigest", "version", "sequence", "acceptedAt", "purpose", "dataPaths", "failedCandidates");
        if (Wire.Integer(value, "schema") != 1 || value["dataPaths"] is not JsonObject paths || paths.Count is < 1 or > 4)
            throw new Refusal("UPDATE_INSTALLATION_INVALID");
        string? Optional(string name) => value[name] is null ? null : Wire.Text(value, name);
        var result = new NativeInstalledUpdate(Wire.Text(value, "installationId"), Wire.Text(value, "ownerSid"),
            Wire.Text(value, "profileRoot"), Wire.Text(value, "layout"), Optional("envelope"), Optional("identityDigest"),
            Optional("acceptanceDigest"), Optional("version"), Wire.Decimal(Wire.Text(value, "sequence")),
            Wire.Decimal(Wire.Text(value, "acceptedAt")), Wire.Text(value, "purpose") switch
            { "baseline" => ReleaseAuthorizationPurpose.Baseline, "update" => ReleaseAuthorizationPurpose.Update, _ => throw new Refusal("UPDATE_INSTALLATION_INVALID") },
            paths.ToDictionary(entry => entry.Key, entry => entry.Value?.GetValue<string>() ?? throw new Refusal("UPDATE_INSTALLATION_INVALID"), StringComparer.Ordinal))
        { FailedCandidates = value["failedCandidates"] is JsonArray failed && failed.Count <= 128
            ? failed.Select(entry => entry?.GetValue<string>() ?? throw new Refusal("UPDATE_INSTALLATION_INVALID")).ToArray()
            : throw new Refusal("UPDATE_INSTALLATION_INVALID") };
        if (!Wire.Digest(result.InstallationId) || !result.OwnerSid.StartsWith("S-1-", StringComparison.Ordinal)
            || !Path.IsPathFullyQualified(result.ProfileRoot)
            || result.FailedCandidates.Any(digest => !Wire.Digest(digest)) || result.FailedCandidates.Distinct(StringComparer.Ordinal).Count() != result.FailedCandidates.Length
            || paths.Any(entry => !Guid.TryParseExact(entry.Key, "D", out _) || !Path.IsPathFullyQualified(entry.Value?.GetValue<string>() ?? ""))
            || (result.Envelope is not null && (!result.Accepted || !Wire.Digest(result.IdentityDigest!) || !Wire.Digest(result.AcceptanceDigest!) || result.AcceptedAt == 0)))
            throw new Refusal("UPDATE_INSTALLATION_INVALID");
        _ = result.ReadLayout();
        if (result.Version is not null) _ = StableVersion.Parse(result.Version);
        if (!bytes.AsSpan().SequenceEqual(Wire.Encode(result.Encode()))) throw new Refusal("UPDATE_INSTALLATION_NONCANONICAL");
        return result;
    }

    internal static void Publish(WindowsStoreIO store, string name, JsonObject value)
    {
        if (name is not ("installation" or "offer")) throw new Refusal("UPDATE_STATE_NAME_INVALID");
        var bytes = Wire.Encode(value);
        var previous = store.Read(name + ".json");
        store.Stage(name + ".pending.json", bytes);
        store.PublishStage(name + ".pending.json", name + ".json", previous?.Digest ?? "none");
        if (store.Read(name + ".json")?.Digest != ReleaseTrustPolicy.Hash(bytes)) throw new Refusal("UPDATE_STATE_READBACK_CHANGED");
    }

    internal static DataGeneration PlannedData(string ownerSid, string transactionId, string? previousId = null)
    {
        var id = Guid.NewGuid().ToString("D");
        var identity = Wire.Encode(new JsonObject { ["schema"] = 1, ["ownerSid"] = ownerSid, ["generationId"] = id,
            ["transactionId"] = transactionId, ["previousGenerationId"] = previousId });
        return DataGeneration.Create(id, ReleaseTrustPolicy.Hash(identity));
    }
}
