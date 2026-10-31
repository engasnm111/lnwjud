using System.Text;
using System.Text.Json;

namespace Lnwjud.UpdateWorker;

internal enum ReleaseAuthorizationPurpose { Baseline, Update }

internal sealed class SignedAuthorizationV2
{
    internal JsonElement Payload { get; }
    internal string IdentitySha256 { get; }
    internal string EnvelopeSha256 { get; }
    internal string PayloadSha256 { get; }
    internal string KeyId { get; }
    internal SignedAuthorizationV2(JsonElement payload, string identitySha256, string envelopeSha256, string payloadSha256, string keyId)
    {
        Payload = payload.Clone(); IdentitySha256 = identitySha256; EnvelopeSha256 = envelopeSha256;
        PayloadSha256 = payloadSha256; KeyId = keyId;
    }
}

internal sealed class RetainedAuthorizationV2
{
    private readonly byte[] envelope;
    internal ReadOnlySpan<byte> Envelope => envelope;
    internal ReleaseAuthorizationPurpose Purpose { get; }
    internal string EnvelopeSha256 { get; }
    internal string IdentitySha256 { get; }
    internal string AcceptanceReceiptSha256 { get; }
    internal ulong AcceptedAt { get; }
    internal RetainedAuthorizationV2(byte[] envelope, ReleaseAuthorizationPurpose purpose, string envelopeSha256,
        string identitySha256, string acceptanceReceiptSha256, ulong acceptedAt)
    {
        if (envelope.Length == 0 || envelope.Length > ReleaseSchema.AuthorizationV2().EnvelopeBytes) throw new Refusal("RELEASE_JSON_INVALID");
        this.envelope = envelope.ToArray(); Purpose = purpose; EnvelopeSha256 = envelopeSha256;
        IdentitySha256 = identitySha256; AcceptanceReceiptSha256 = acceptanceReceiptSha256; AcceptedAt = acceptedAt;
    }
}

internal sealed class VerifiedOfferMetadataV2
{
    internal SignedAuthorizationV2 Candidate { get; }
    internal string PreviousEnvelopeSha256 { get; }
    internal string PreviousIdentitySha256 { get; }
    internal string AcceptanceReceiptSha256 { get; }
    internal string PolicySha256 { get; }
    internal string SnapshotSha256 { get; }
    internal ulong Generation { get; }
    internal ulong Revision { get; }
    internal ulong ObservedAt { get; }
    internal VerifiedOfferMetadataV2(SignedAuthorizationV2 candidate, RetainedAuthorizationV2 baseline,
        ReleaseTrustPolicy policy, ReleaseTrustSnapshot snapshot, ulong now)
    {
        Candidate = candidate; PreviousEnvelopeSha256 = baseline.EnvelopeSha256; PreviousIdentitySha256 = baseline.IdentitySha256;
        AcceptanceReceiptSha256 = baseline.AcceptanceReceiptSha256; PolicySha256 = policy.Digest;
        SnapshotSha256 = snapshot.Digest; Generation = snapshot.Generation; Revision = snapshot.Revision; ObservedAt = now;
    }
}

internal static class ReleaseAuthorizationV2
{
    private static readonly byte[] Domain = Encoding.ASCII.GetBytes("lnwjud-update-release-v2\0");

    private static string PayloadName(ReleaseAuthorizationPurpose purpose) => purpose switch
    {
        ReleaseAuthorizationPurpose.Baseline => "baselinePayload",
        ReleaseAuthorizationPurpose.Update => "updatePayload",
        _ => throw new Refusal("RELEASE_AUTHORIZATION_PURPOSE_INVALID")
    };

    internal static ReleaseEvidenceCandidate InspectUnsigned(ReadOnlySpan<byte> bytes, ReleaseTrustPolicy policy,
        ReleaseTimeObservation time, ReleaseAuthorizationPurpose purpose, string keyId)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (!time.Usable || time.UnixSeconds > 253402300799) throw new Refusal("RELEASE_TIME_UNAVAILABLE");
        var schema = ReleaseSchema.AuthorizationV2();
        using var document = ReleaseJson.Parse(bytes, schema.PayloadBytes, schema.Depth);
        schema.Validate(PayloadName(purpose), document.RootElement);
        var root = policy.Roots.SingleOrDefault(value => value.KeyId == keyId) ?? throw new Refusal("RELEASE_KEY_UNTRUSTED");
        if (root.Revoked || !root.Roles.Contains("release")) throw new Refusal("RELEASE_KEY_REVOKED_OR_ROLE_INVALID");
        ValidatePayload(document.RootElement, root, policy, time);
        return new ReleaseEvidenceCandidate(document.RootElement.GetProperty("release"), ReleaseValues.Number(document.RootElement, "issuedAt"));
    }

    internal static SignedAuthorizationV2 Authenticate(ReadOnlySpan<byte> bytes, ReleaseTrustPolicy policy,
        ReleaseTimeObservation time, ReleaseAuthorizationPurpose purpose)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (!time.Usable || time.UnixSeconds > 253402300799) throw new Refusal("RELEASE_TIME_UNAVAILABLE");
        var payloadName = PayloadName(purpose);
        var schema = ReleaseSchema.AuthorizationV2();
        if (bytes.Length == 0 || bytes.Length > schema.EnvelopeBytes) throw new Refusal("RELEASE_JSON_INVALID");
        var snapshot = bytes.ToArray();
        var (payload, root, payloadDigest) = ReleaseMetadataVerifier.AuthenticatePayload(snapshot, policy, schema, Domain, payloadName);
        var identity = ValidatePayload(payload, root, policy, time);
        return new SignedAuthorizationV2(payload, identity, ReleaseTrustPolicy.Hash(snapshot), payloadDigest, root.KeyId);
    }

    private static string ValidatePayload(JsonElement payload, ReleaseRoot root, ReleaseTrustPolicy policy, ReleaseTimeObservation time)
    {
        var issued = ReleaseValues.Number(payload, "issuedAt");
        var expiry = ReleaseValues.Number(payload, "expiresAt");
        if (payload.GetProperty("policyRevision").GetInt32() != policy.Revision) throw new Refusal("RELEASE_POLICY_REVISION_MISMATCH");
        if (issued != ReleaseValues.Number(payload, "notBefore") || expiry <= issued || time.UnixSeconds < issued
            || time.UnixSeconds >= expiry || issued > checked(time.UnixSeconds + policy.FutureSkew)
            || expiry - issued > policy.MaximumValidity) throw new Refusal("RELEASE_TIME_INVALID");
        if (!root.Roles.Contains("recovery") || time.UnixSeconds < root.NotBefore || time.UnixSeconds >= root.ExpiresAt
            || issued < root.NotBefore || issued >= root.ExpiresAt) throw new Refusal("RELEASE_KEY_TIME_INVALID");
        var release = payload.GetProperty("release");
        var source = release.GetProperty("source");
        _ = policy.SelectSource(ReleaseValues.Text(source, "repository"), ReleaseValues.Text(source, "workflow"), ReleaseValues.Text(source, "ref"));
        var artifact = SignedRelease.Identity(release.GetProperty("artifact"));
        var provenance = SignedRelease.Identity(release.GetProperty("provenance"));
        var expected = ReleaseMetadataVerifier.ExpectedArtifactName(ReleaseValues.Text(release, "platform"), ReleaseValues.Text(release, "architecture"),
            ReleaseValues.Text(release, "distribution"), ReleaseValues.Text(release, "version"));
        ReleaseMetadataVerifier.CheckIdentity(artifact, expected, provenance, policy);
        return ReleaseTrustPolicy.Hash(ReleaseSchema.Identity().EncodeReleaseIdentity(Wire.Utf8.GetBytes(release.GetRawText())));
    }

    internal static VerifiedOfferMetadataV2 VerifyOffer(ReadOnlySpan<byte> bytes, ReleaseTrustPolicy policy,
        ReleaseTimeObservation time, RetainedAuthorizationV2? baseline, ReleaseTrustSnapshot snapshot)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (baseline is null || !Wire.Digest(baseline.AcceptanceReceiptSha256)) throw new Refusal("RELEASE_TRUSTED_BASELINE_UNAVAILABLE");
        if (!time.Usable || time.UnixSeconds > 253402300799) throw new Refusal("RELEASE_TIME_UNAVAILABLE");
        if (snapshot.Generation == 0 || snapshot.Revision == 0 || snapshot.FailedCandidateDigests.Count > 256
            || snapshot.FailedCandidateDigests.Any(digest => !Wire.Digest(digest))) throw new Refusal("RELEASE_TRUST_STATE_INVALID");
        if (baseline.AcceptedAt > time.UnixSeconds || snapshot.LastAcceptedTime > time.UnixSeconds
            || snapshot.LastAcceptedTime < baseline.AcceptedAt) throw new Refusal("RELEASE_CLOCK_ROLLBACK");
        if (!Wire.Digest(baseline.EnvelopeSha256) || !Wire.Digest(baseline.IdentitySha256)
            || ReleaseTrustPolicy.Hash(baseline.Envelope) != baseline.EnvelopeSha256) throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        var previous = Authenticate(baseline.Envelope, policy, new(true, baseline.AcceptedAt), baseline.Purpose);
        if (previous.IdentitySha256 != baseline.IdentitySha256) throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        var previousRoot = policy.Roots.Single(root => root.KeyId == previous.KeyId);
        if ((time.UnixSeconds >= ReleaseValues.Number(previous.Payload, "expiresAt") || time.UnixSeconds >= previousRoot.ExpiresAt)
            && !previousRoot.AllowHistoricalRecovery) throw new Refusal("RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED");
        var candidate = Authenticate(bytes, policy, time, ReleaseAuthorizationPurpose.Update);
        var oldRelease = previous.Payload.GetProperty("release");
        var newRelease = candidate.Payload.GetProperty("release");
        var oldSequence = ReleaseValues.Number(oldRelease, "releaseSequence");
        var newSequence = ReleaseValues.Number(newRelease, "releaseSequence");
        if (snapshot.HighestAcceptedSequence < oldSequence) throw new Refusal("RELEASE_TRUST_STATE_INVALID");
        var versionOrder = StableVersion.Parse(ReleaseValues.Text(newRelease, "version"))
            .CompareTo(StableVersion.Parse(ReleaseValues.Text(oldRelease, "version")));
        var sameArtifact = ReleaseValues.Text(newRelease.GetProperty("artifact"), "sha256")
            == ReleaseValues.Text(oldRelease.GetProperty("artifact"), "sha256");
        // A signed, higher-sequence build may refresh the same semantic version,
        // but cannot replay the identical installed artifact or downgrade.
        if (newSequence <= oldSequence || newSequence <= snapshot.HighestAcceptedSequence
            || versionOrder < 0 || (versionOrder == 0 && sameArtifact))
            throw new Refusal("RELEASE_REPLAY_OR_DOWNGRADE");
        if (ReleaseValues.Text(candidate.Payload.GetProperty("recovery"), "previousReleaseIdentity") != baseline.IdentitySha256)
            throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        foreach (var field in new[] { "platform", "architecture", "distribution" })
            if (ReleaseValues.Text(oldRelease, field) != ReleaseValues.Text(newRelease, field)) throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        foreach (var field in new[] { "migrationContractSha256", "workerContractSha256", "serviceContractSha256" })
            if (ReleaseValues.Text(oldRelease.GetProperty("compatibility"), field) != ReleaseValues.Text(newRelease.GetProperty("compatibility"), field))
                throw new Refusal("RELEASE_RECOVERY_CONTRACT_UNSUPPORTED");
        if (snapshot.FailedCandidateDigests.Contains(ReleaseValues.Text(newRelease.GetProperty("artifact"), "sha256")))
            throw new Refusal("RELEASE_CANDIDATE_QUARANTINED");
        return new VerifiedOfferMetadataV2(candidate, baseline, policy, snapshot, time.UnixSeconds);
    }
}
