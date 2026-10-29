using System.Security.Cryptography;
using System.Text.Json;
using System.Collections.Frozen;
using System.Text.RegularExpressions;

namespace Lnwjud.UpdateWorker;

internal sealed class ReleaseRoot
{
    private readonly byte[] spki;
    internal string KeyId { get; }
    internal ReadOnlySpan<byte> Spki => spki;
    internal IReadOnlySet<string> Roles { get; }
    internal ulong NotBefore { get; }
    internal ulong ExpiresAt { get; }
    internal bool Revoked { get; }
    internal bool AllowHistoricalRecovery { get; }
    internal ReleaseRoot(string keyId, byte[] spki, IEnumerable<string> roles, ulong notBefore, ulong expiresAt, bool revoked, bool allowHistoricalRecovery)
    {
        KeyId = keyId; this.spki = spki.ToArray(); Roles = roles.ToFrozenSet(StringComparer.Ordinal);
        NotBefore = notBefore; ExpiresAt = expiresAt; Revoked = revoked; AllowHistoricalRecovery = allowHistoricalRecovery;
    }
}
internal sealed record ReleaseSourceAuthority(string Repository, string Workflow, string Ref,
    string BuilderWorkflowUri, string BuilderDigest, string BuildConfigUri, string BuildConfigDigestRule,
    string Issuer, string RunnerEnvironment);
internal sealed record ReleaseVerifier(string Filename, string Version, string Sha256);

internal sealed class ReleaseTrustPolicy
{
    internal int Revision { get; }
    internal string Digest { get; }
    internal IReadOnlyList<ReleaseRoot> Roots { get; }
    internal IReadOnlyList<ReleaseSourceAuthority> Sources { get; }
    internal ulong MaximumValidity { get; }
    internal ulong FutureSkew { get; }
    internal ulong MaximumPackage { get; }
    internal ulong MaximumProvenance { get; }
    internal bool Configured { get; }
    internal ReleaseVerifier? Verifier { get; }

    internal ReleaseSourceAuthority SelectSource(string repository, string workflow, string reference) =>
        Sources.SingleOrDefault(source => source.Repository == repository && source.Workflow == workflow && source.Ref == reference)
        ?? throw new Refusal("RELEASE_SOURCE_UNTRUSTED");

    private ReleaseTrustPolicy(byte[] bytes)
    {
        using var document = ReleaseJson.Parse(bytes, 65_536);
        var value = document.RootElement;
        Fields(value, "protocol", "revision", "roots", "authorities", "verifier", "limits");
        if (Integer(value, "protocol") != 1 || Integer(value, "revision") != 1) throw new Refusal("RELEASE_POLICY_UNSUPPORTED");
        Revision = 1; Digest = Hash(bytes);
        var limits = value.GetProperty("limits");
        Fields(limits, "maximumValiditySeconds", "maximumFutureSkewSeconds", "maximumPackageBytes", "maximumProvenanceBytes");
        MaximumValidity = Bound(limits, "maximumValiditySeconds", 86_400);
        FutureSkew = Bound(limits, "maximumFutureSkewSeconds", 300, true);
        MaximumPackage = Bound(limits, "maximumPackageBytes", 2_147_483_648);
        MaximumProvenance = Bound(limits, "maximumProvenanceBytes", 1_048_576);
        var roots = new List<ReleaseRoot>();
        var rootArray = value.GetProperty("roots");
        if (rootArray.ValueKind != JsonValueKind.Array || rootArray.GetArrayLength() > 16) throw new Refusal("RELEASE_POLICY_INVALID");
        foreach (var entry in rootArray.EnumerateArray()) roots.Add(ParseRoot(entry));
        if (roots.Select(root => root.KeyId).Distinct(StringComparer.Ordinal).Count() != roots.Count) throw new Refusal("RELEASE_POLICY_INVALID");
        Roots = roots.AsReadOnly();
        var sources = new List<ReleaseSourceAuthority>();
        var authorities = value.GetProperty("authorities");
        if (authorities.ValueKind != JsonValueKind.Array || authorities.GetArrayLength() > 16) throw new Refusal("RELEASE_POLICY_INVALID");
        foreach (var authority in authorities.EnumerateArray())
        {
            Fields(authority, "repository", "workflow", "ref", "builderWorkflowUri", "builderDigest", "buildConfigUri", "buildConfigDigestRule", "issuer", "runnerEnvironment");
            foreach (var property in authority.EnumerateObject())
                if (property.Value.ValueKind != JsonValueKind.String || property.Value.GetString()!.Length is < 1 or > 2048) throw new Refusal("RELEASE_POLICY_INVALID");
            if (ReleaseValues.Text(authority, "repository") != "https://github.com/engasnm111/lnwjud"
                || ReleaseValues.Text(authority, "issuer") != "https://token.actions.githubusercontent.com"
                || ReleaseValues.Text(authority, "runnerEnvironment") != "github-hosted"
                || ReleaseValues.Text(authority, "buildConfigDigestRule") != "source-commit") throw new Refusal("RELEASE_POLICY_INVALID");
            var source = new ReleaseSourceAuthority(ReleaseValues.Text(authority, "repository"), ReleaseValues.Text(authority, "workflow"), ReleaseValues.Text(authority, "ref"),
                ReleaseValues.Text(authority, "builderWorkflowUri"), ReleaseValues.Text(authority, "builderDigest"), ReleaseValues.Text(authority, "buildConfigUri"),
                ReleaseValues.Text(authority, "buildConfigDigestRule"), ReleaseValues.Text(authority, "issuer"), ReleaseValues.Text(authority, "runnerEnvironment"));
            if (!Regex.IsMatch(source.Workflow, @"\A\.github/workflows/[A-Za-z0-9._-]+\.ya?ml\z")
                || !Regex.IsMatch(source.Ref, @"\Arefs/heads/[A-Za-z0-9._/-]+\z")
                || !Regex.IsMatch(source.BuilderDigest, @"\A[a-f0-9]{40}\z")
                || !Regex.IsMatch(source.BuilderWorkflowUri, @"\Ahttps://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/\.github/workflows/[A-Za-z0-9._-]+\.ya?ml@[A-Za-z0-9._/-]+\z")
                || source.BuildConfigUri != $"{source.Repository}/{source.Workflow}@{source.Ref}"
                || sources.Any(item => item.Repository == source.Repository && item.Workflow == source.Workflow && item.Ref == source.Ref))
                throw new Refusal("RELEASE_POLICY_INVALID");
            sources.Add(source);
        }
        Sources = sources.AsReadOnly();
        var verifier = value.GetProperty("verifier");
        if (verifier.ValueKind != JsonValueKind.Null)
        {
            Fields(verifier, "version", "sha256", "filename");
            if (!Wire.Digest(ReleaseValues.Text(verifier, "sha256")) || ReleaseValues.Text(verifier, "filename") is not ("gh" or "gh.exe")
                || !Regex.IsMatch(ReleaseValues.Text(verifier, "version"), @"\A[0-9]+\.[0-9]+\.[0-9]+\z")) throw new Refusal("RELEASE_POLICY_INVALID");
            Verifier = new ReleaseVerifier(ReleaseValues.Text(verifier, "filename"), ReleaseValues.Text(verifier, "version"), ReleaseValues.Text(verifier, "sha256"));
        }
        Configured = roots.Count > 0 && sources.Count > 0 && verifier.ValueKind != JsonValueKind.Null;
    }

    internal static ReleaseTrustPolicy Embedded() => Parse(ReleaseJson.Resource("update-release-policy.json"));
    internal static ReleaseTrustPolicy Parse(byte[] bytes)
    {
        try { return new ReleaseTrustPolicy(bytes.ToArray()); }
        catch (Refusal) { throw; }
        catch (Exception) { throw new Refusal("RELEASE_POLICY_INVALID"); }
    }
    internal static string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static void Fields(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != names.Length
            || value.EnumerateObject().Any(property => !names.Contains(property.Name, StringComparer.Ordinal))) throw new Refusal("RELEASE_POLICY_INVALID");
    }
    internal static int Integer(JsonElement value, string name)
    {
        var node = value.GetProperty(name);
        if (node.ValueKind != JsonValueKind.Number || !node.GetRawText().All(c => c is >= '0' and <= '9') || !node.TryGetInt32(out var number)) throw new Refusal("RELEASE_POLICY_INVALID");
        return number;
    }
    private static ulong Bound(JsonElement value, string name, ulong maximum, bool zero = false)
    {
        var number = ReleaseValues.Number(value, name);
        if ((!zero && number == 0) || number > maximum) throw new Refusal("RELEASE_POLICY_INVALID");
        return number;
    }
    private static ReleaseRoot ParseRoot(JsonElement value)
    {
        Fields(value, "keyId", "algorithm", "spkiBase64", "spkiSha256", "roles", "notBefore", "expiresAt", "revoked", "allowHistoricalRecovery");
        var keyId = ReleaseValues.Text(value, "keyId");
        if (!Wire.Identifier(keyId, 64) || ReleaseValues.Text(value, "algorithm") != "ecdsa-p256-sha256-p1363") throw new Refusal("RELEASE_POLICY_INVALID");
        var spkiText = ReleaseValues.Text(value, "spkiBase64");
        if (spkiText.Length > 512) throw new Refusal("RELEASE_POLICY_INVALID");
        var spki = ReleaseValues.Base64(spkiText);
        if (Hash(spki) != ReleaseValues.Text(value, "spkiSha256")) throw new Refusal("RELEASE_POLICY_INVALID");
        using var key = ECDsa.Create(); key.ImportSubjectPublicKeyInfo(spki, out var read);
        if (read != spki.Length || key.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7"
            || !key.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(spki)) throw new Refusal("RELEASE_POLICY_INVALID");
        var roles = value.GetProperty("roles");
        if (roles.ValueKind != JsonValueKind.Array || roles.GetArrayLength() is < 1 or > 2) throw new Refusal("RELEASE_POLICY_INVALID");
        var selectedRoles = roles.EnumerateArray().Select(role => role.GetString()!).ToHashSet(StringComparer.Ordinal);
        if (selectedRoles.Count != roles.GetArrayLength() || selectedRoles.Any(role => role is not ("release" or "recovery"))) throw new Refusal("RELEASE_POLICY_INVALID");
        var notBefore = Bound(value, "notBefore", 253402300799, true);
        var expiresAt = Bound(value, "expiresAt", 253402300799);
        if (notBefore >= expiresAt) throw new Refusal("RELEASE_POLICY_INVALID");
        return new ReleaseRoot(keyId, spki, selectedRoles, notBefore, expiresAt,
            value.GetProperty("revoked").GetBoolean(), value.GetProperty("allowHistoricalRecovery").GetBoolean());
    }
}
