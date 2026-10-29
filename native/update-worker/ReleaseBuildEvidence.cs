using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Lnwjud.UpdateWorker;

internal sealed class ReleaseEvidenceCandidate
{
    internal JsonElement Payload { get; }
    internal ReleaseArtifact Artifact { get; }
    internal ulong IssuedAt { get; }
    internal string Text(string name) => ReleaseValues.Text(Payload, name);
    internal ReleaseEvidenceCandidate(JsonElement payload, ulong issuedAt)
    {
        Payload = payload.Clone();
        Artifact = SignedRelease.Identity(Payload.GetProperty("artifact"));
        IssuedAt = issuedAt;
    }
    internal static ReleaseEvidenceCandidate FromSigned(SignedRelease release) => new(release.Payload, release.Number("issuedAt"));
}

internal static class ReleaseBuildEvidence
{
    internal const int MaximumOutput = 4 * 1024 * 1024;
    private static JsonDocument Parse(ReadOnlySpan<byte> bytes, int maximum)
    {
        var document = ReleaseJson.Parse(bytes, maximum, 64);
        try { RequireSafeNumbers(document.RootElement); return document; }
        catch { document.Dispose(); throw; }
    }
    private static void RequireSafeNumbers(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && Decimal(value) is null) throw new Refusal("RELEASE_JSON_INVALID");
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var property in value.EnumerateObject()) RequireSafeNumbers(property.Value);
        if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) RequireSafeNumbers(item);
    }
    private static JsonElement Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) ? property : default;
    private static string? Text(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } property ? property.GetString() : null;
    private static string? Decimal(JsonElement value)
    {
        if (value.ValueKind is not (JsonValueKind.Number or JsonValueKind.String)) return null;
        var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
        return Regex.IsMatch(text, @"\A(?:0|[1-9][0-9]*)\z") && ulong.TryParse(text, out var number)
            && (value.ValueKind != JsonValueKind.Number || number <= 9_007_199_254_740_991) ? text : null;
    }

    internal static void RequireRun(ReadOnlySpan<byte> bytes, ReleaseEvidenceCandidate release)
    {
        using var document = Parse(bytes, MaximumOutput);
        var run = document.RootElement;
        var source = release.Payload.GetProperty("source");
        if (Text(run, "status") != "completed" || Text(run, "conclusion") != "success" || Text(run, "event") != "push"
            || Text(run, "head_sha") != Text(source, "commit") || Text(run, "head_branch") != Text(source, "ref")!["refs/heads/".Length..]
            || Text(run, "path") != Text(source, "workflow") || Decimal(Property(run, "id")) != Text(source, "runId")
            || Decimal(Property(run, "run_attempt")) != Text(source, "runAttempt")) throw new Refusal("RELEASE_BUILD_RUN_REFUSED");
    }

    internal static void RequireAttestation(ReadOnlySpan<byte> bytes, ReleaseEvidenceCandidate release, ReleaseArtifact subject, ReleaseSourceAuthority authority)
    {
        using var document = Parse(bytes, MaximumOutput);
        var results = document.RootElement;
        if (results.ValueKind != JsonValueKind.Array || results.GetArrayLength() is < 1 or > 64) throw new Refusal("RELEASE_ATTESTATION_REFUSED");
        var source = release.Payload.GetProperty("source");
        foreach (var result in results.EnumerateArray())
        {
            var verified = Property(result, "verificationResult");
            var certificate = Property(Property(verified, "signature"), "certificate");
            var statement = Property(verified, "statement");
            var timestamps = Property(verified, "verifiedTimestamps");
            var subjects = Property(statement, "subject");
            if (Text(certificate, "issuer") == authority.Issuer && Text(certificate, "subjectAlternativeName") == authority.BuilderWorkflowUri
                && Text(certificate, "sourceRepositoryURI") == Text(source, "repository") && Text(certificate, "sourceRepositoryDigest") == Text(source, "commit")
                && Text(certificate, "sourceRepositoryRef") == Text(source, "ref") && Text(certificate, "buildSignerURI") == authority.BuilderWorkflowUri
                && Text(certificate, "buildSignerDigest") == authority.BuilderDigest && Text(certificate, "buildConfigURI") == authority.BuildConfigUri
                && authority.BuildConfigDigestRule == "source-commit" && Text(certificate, "buildConfigDigest") == Text(source, "commit")
                && Text(certificate, "runnerEnvironment") == "github-hosted"
                && Text(certificate, "runInvocationURI") == $"{Text(source, "repository")}/actions/runs/{Text(source, "runId")}/attempts/{Text(source, "runAttempt")}"
                && timestamps.ValueKind == JsonValueKind.Array && timestamps.GetArrayLength() is > 0 and <= 16
                && timestamps.EnumerateArray().All(item => Timestamp(item, release.IssuedAt))
                && timestamps.EnumerateArray().Any(item => Text(item, "type") == "Tlog")
                && Text(statement, "predicateType") == "https://slsa.dev/provenance/v1" && subjects.ValueKind == JsonValueKind.Array
                && subjects.EnumerateArray().Any(item => Text(item, "name") == subject.Name && Text(Property(item, "digest"), "sha256") == subject.Sha256)) return;
        }
        throw new Refusal("RELEASE_ATTESTATION_REFUSED");
    }

    private static bool Timestamp(JsonElement value, ulong issued)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != 3
            || Text(value, "type") is not ("Tlog" or "TimestampAuthority")) return false;
        var uriText = Text(value, "uri"); var timestamp = Text(value, "timestamp");
        if (uriText is null || uriText.Length > 2048 || !Uri.TryCreate(uriText, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || uri.Host.Length == 0 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0
            || timestamp is null || !Regex.IsMatch(timestamp, @"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z\z")
            || !DateTimeOffset.TryParseExact(timestamp[..19] + "Z", "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)) return false;
        var seconds = parsed.ToUnixTimeSeconds();
        return seconds >= 0 && (ulong)seconds <= issued + 300;
    }

    internal static void RequireProvenance(ReadOnlySpan<byte> bytes, ReleaseEvidenceCandidate release)
    {
        using var document = Parse(bytes, 1_048_576);
        var provenance = document.RootElement; var source = release.Payload.GetProperty("source");
        var actualSource = Property(provenance, "source"); var build = Property(provenance, "build");
        var artifacts = Property(provenance, "artifacts");
        if (Text(provenance, "product") != release.Text("product") || Text(provenance, "version") != release.Text("version")
            || Text(provenance, "platform") != release.Text("platform") || Text(provenance, "arch") != release.Text("architecture")
            || Text(actualSource, "repository") != Text(source, "repository") || Text(actualSource, "commit") != Text(source, "commit")
            || Property(actualSource, "dirty").ValueKind != JsonValueKind.False || Text(build, "environment") != "github-actions"
            || Text(build, "runId") != Text(source, "runId") || Text(build, "runAttempt") != Text(source, "runAttempt")
            || Text(build, "ref") != Text(source, "ref") || artifacts.ValueKind != JsonValueKind.Array) throw new Refusal("RELEASE_PROVENANCE_REFUSED");
        var matches = artifacts.EnumerateArray().Where(item => Text(item, "name") == release.Artifact.Name).ToArray();
        if (matches.Length != 1 || Text(matches[0], "sha256") != release.Artifact.Sha256
            || Decimal(Property(matches[0], "sizeBytes")) != Wire.Decimal(release.Artifact.SizeBytes)) throw new Refusal("RELEASE_PROVENANCE_REFUSED");
    }
}
