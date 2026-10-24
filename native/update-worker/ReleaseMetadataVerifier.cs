using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Collections.Frozen;

namespace Lnwjud.UpdateWorker;

internal sealed record ReleaseArtifact(string Name, string Sha256, ulong SizeBytes);
internal sealed record ReleaseContracts(string Migration, string Worker, string Service);
internal sealed record ReleaseTrustSnapshot
{
    private IReadOnlySet<string> failed = FrozenSet<string>.Empty;
    internal ulong Generation { get; init; }
    internal ulong Revision { get; init; }
    internal ulong HighestAcceptedSequence { get; init; }
    internal ulong LastAcceptedTime { get; init; }
    internal IReadOnlySet<string> FailedCandidateDigests { get => failed; init => failed = value.ToFrozenSet(StringComparer.Ordinal); }
    internal ReleaseTrustSnapshot(ulong generation, ulong revision, ulong highestAcceptedSequence, ulong lastAcceptedTime, IReadOnlySet<string> failedCandidateDigests)
    { Generation = generation; Revision = revision; HighestAcceptedSequence = highestAcceptedSequence; LastAcceptedTime = lastAcceptedTime; FailedCandidateDigests = failedCandidateDigests; }
    internal string Digest => ReleaseTrustPolicy.Hash(Wire.Utf8.GetBytes(
        $"{Generation}:{Revision}:{HighestAcceptedSequence}:{LastAcceptedTime}:" + string.Join(',', FailedCandidateDigests.Order(StringComparer.Ordinal))));
}
internal sealed record ReleaseTimeObservation(bool Usable, ulong UnixSeconds);

internal sealed record RetainedInstallationBaseline
{
    private readonly byte[] originalEnvelope;
    internal ReadOnlySpan<byte> OriginalEnvelope => originalEnvelope;
    internal string EnvelopeSha256 { get; init; }
    internal string Version { get; init; }
    internal ulong Sequence { get; init; }
    internal ReleaseArtifact Artifact { get; init; }
    internal ReleaseArtifact Provenance { get; init; }
    internal ReleaseContracts Contracts { get; init; }
    internal ulong AcceptedAt { get; init; }
    internal string NativeAcceptanceReceiptSha256 { get; init; }
    internal RetainedInstallationBaseline(byte[] originalEnvelope, string envelopeSha256, string version, ulong sequence,
        ReleaseArtifact artifact, ReleaseArtifact provenance, ReleaseContracts contracts, ulong acceptedAt, string nativeAcceptanceReceiptSha256)
    {
        this.originalEnvelope = originalEnvelope.ToArray(); EnvelopeSha256 = envelopeSha256; Version = version; Sequence = sequence;
        Artifact = artifact; Provenance = provenance; Contracts = contracts; AcceptedAt = acceptedAt; NativeAcceptanceReceiptSha256 = nativeAcceptanceReceiptSha256;
    }
}
internal sealed record FailedUpdateRecoveryContext(string TransactionId, string CandidateEnvelopeSha256,
    string CandidateArtifactSha256, ulong CandidateSequence, string BaselineEnvelopeSha256,
    ulong AcceptedTrustGeneration, ulong AcceptedTrustRevision, int RemainingAttempts);

internal sealed record AuthenticatedMetadataReceipt(string EnvelopeSha256, string PayloadSha256,
    string KeyId, string PolicySha256, int PolicyRevision, string TrustSnapshotSha256,
    ulong ExpectedGeneration, ulong ExpectedRevision, ulong ObservedTime);

internal sealed class AuthenticatedReleaseMetadata
{
    internal string ReleaseId { get; }
    internal string Version { get; }
    internal ulong Sequence { get; }
    internal ReleaseArtifact Artifact { get; }
    internal ReleaseArtifact Provenance { get; }
    internal ReleaseContracts Contracts { get; }
    internal AuthenticatedMetadataReceipt Receipt { get; }
    internal bool HistoricalPreviousEligibilityOnly { get; }
    internal AuthenticatedReleaseMetadata(SignedRelease release, ReleaseTrustPolicy policy, ReleaseTrustSnapshot snapshot,
        ulong now, bool historical)
    {
        ReleaseId = release.Text("releaseId"); Version = release.Text("version"); Sequence = release.Number("releaseSequence");
        Artifact = release.Artifact; Provenance = release.Provenance; Contracts = release.Contracts;
        HistoricalPreviousEligibilityOnly = historical;
        Receipt = new AuthenticatedMetadataReceipt(release.EnvelopeDigest, release.PayloadDigest, release.Root.KeyId,
            policy.Digest, policy.Revision, snapshot.Digest, snapshot.Generation, snapshot.Revision, now);
    }
}
internal abstract record ReleaseMetadataVerification
{
    internal sealed record Authenticated(AuthenticatedReleaseMetadata Metadata) : ReleaseMetadataVerification;
    internal sealed record Refused(string Reason) : ReleaseMetadataVerification;
}
internal sealed record AuthenticatedRecoveryMetadata(AuthenticatedMetadataReceipt Receipt,
    string TransactionId, string PreviousEnvelopeSha256, int MaximumAttempts);
internal abstract record RecoveryMetadataVerification
{
    internal sealed record Authenticated(AuthenticatedRecoveryMetadata Metadata) : RecoveryMetadataVerification;
    internal sealed record Refused(string Reason) : RecoveryMetadataVerification;
}

internal sealed class SignedRelease
{
    internal JsonElement Payload { get; }
    internal ReleaseRoot Root { get; }
    internal string EnvelopeDigest { get; }
    internal string PayloadDigest { get; }
    internal ReleaseArtifact Artifact { get; }
    internal ReleaseArtifact Provenance { get; }
    internal ReleaseContracts Contracts { get; }
    internal string Text(string name) => ReleaseValues.Text(Payload, name);
    internal ulong Number(string name) => ReleaseValues.Number(Payload, name);
    internal SignedRelease(JsonElement payload, ReleaseRoot root, string envelopeDigest, string payloadDigest)
    {
        Payload = payload.Clone(); Root = root; EnvelopeDigest = envelopeDigest; PayloadDigest = payloadDigest;
        Artifact = Identity(Payload.GetProperty("artifact")); Provenance = Identity(Payload.GetProperty("provenance"));
        var contracts = Payload.GetProperty("compatibility");
        Contracts = new ReleaseContracts(ReleaseValues.Text(contracts, "migrationContractSha256"),
            ReleaseValues.Text(contracts, "workerContractSha256"), ReleaseValues.Text(contracts, "serviceContractSha256"));
    }
    internal static ReleaseArtifact Identity(JsonElement value) => new(ReleaseValues.Text(value, "name"), ReleaseValues.Text(value, "sha256"), ReleaseValues.Number(value, "sizeBytes"));
}

internal static class ReleaseMetadataVerifier
{
    private static readonly byte[] Domain = Encoding.ASCII.GetBytes("lnwjud-update-release-v1\0");

    internal static ReleaseMetadataVerification VerifyOffer(byte[] envelope, ReleaseTrustPolicy policy, ReleaseSchema schema,
        RetainedInstallationBaseline? baseline, ReleaseTrustSnapshot snapshot, ReleaseTimeObservation time)
    {
        try
        {
            var current = VerifyCommon(envelope.ToArray(), policy, schema, baseline, snapshot, time);
            CheckUpgrade(current, baseline!);
            if (current.Number("releaseSequence") <= snapshot.HighestAcceptedSequence) throw new Refusal("RELEASE_REPLAY_OR_DOWNGRADE");
            if (snapshot.FailedCandidateDigests.Contains(current.Artifact.Sha256)) throw new Refusal("RELEASE_CANDIDATE_QUARANTINED");
            var historical = VerifyBaseline(current, baseline!, policy, schema, time.UnixSeconds);
            return new ReleaseMetadataVerification.Authenticated(new AuthenticatedReleaseMetadata(current, policy, snapshot, time.UnixSeconds, historical));
        }
        catch (Refusal error) { return new ReleaseMetadataVerification.Refused(error.Reason); }
        catch (Exception) { return new ReleaseMetadataVerification.Refused("RELEASE_METADATA_INVALID"); }
    }

    internal static RecoveryMetadataVerification VerifyRecoveryMetadata(byte[] envelope, ReleaseTrustPolicy policy, ReleaseSchema schema,
        RetainedInstallationBaseline? baseline, ReleaseTrustSnapshot snapshot, ReleaseTimeObservation time, FailedUpdateRecoveryContext failed)
    {
        try
        {
            var current = VerifyCommon(envelope.ToArray(), policy, schema, baseline, snapshot, time);
            CheckUpgrade(current, baseline!);
            _ = VerifyBaseline(current, baseline!, policy, schema, time.UnixSeconds);
            if (!Guid.TryParseExact(failed.TransactionId, "D", out var transaction) || transaction.ToString("D") != failed.TransactionId
                || failed.RemainingAttempts != 1 || failed.CandidateEnvelopeSha256 != current.EnvelopeDigest || failed.CandidateArtifactSha256 != current.Artifact.Sha256
                || failed.CandidateSequence != current.Number("releaseSequence") || failed.BaselineEnvelopeSha256 != baseline!.EnvelopeSha256
                || failed.AcceptedTrustGeneration != snapshot.Generation || failed.AcceptedTrustRevision != snapshot.Revision
                || snapshot.HighestAcceptedSequence != failed.CandidateSequence || !snapshot.FailedCandidateDigests.Contains(current.Artifact.Sha256)) throw new Refusal("RELEASE_RECOVERY_CONTEXT_INVALID");
            var authorization = current.Payload.GetProperty("recoveryAuthorization");
            if (time.UnixSeconds >= ReleaseValues.Number(authorization, "expiresAt")) throw new Refusal("RELEASE_RECOVERY_AUTHORIZATION_EXPIRED");
            var metadata = new AuthenticatedReleaseMetadata(current, policy, snapshot, time.UnixSeconds, true);
            return new RecoveryMetadataVerification.Authenticated(new AuthenticatedRecoveryMetadata(metadata.Receipt, failed.TransactionId, baseline.EnvelopeSha256, 1));
        }
        catch (Refusal error) { return new RecoveryMetadataVerification.Refused(error.Reason); }
        catch (Exception) { return new RecoveryMetadataVerification.Refused("RELEASE_METADATA_INVALID"); }
    }

    private static SignedRelease VerifyCommon(byte[] envelope, ReleaseTrustPolicy policy, ReleaseSchema schema,
        RetainedInstallationBaseline? baseline, ReleaseTrustSnapshot snapshot, ReleaseTimeObservation time)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (baseline is null || !Wire.Digest(baseline.NativeAcceptanceReceiptSha256)) throw new Refusal("RELEASE_TRUSTED_BASELINE_UNAVAILABLE");
        if (snapshot.Generation == 0 || snapshot.Revision == 0 || snapshot.FailedCandidateDigests.Count > 256
            || snapshot.FailedCandidateDigests.Any(digest => !Wire.Digest(digest)) || snapshot.HighestAcceptedSequence < baseline.Sequence
            || snapshot.LastAcceptedTime < baseline.AcceptedAt) throw new Refusal("RELEASE_TRUST_STATE_INVALID");
        if (!time.Usable || time.UnixSeconds > 253402300799) throw new Refusal("RELEASE_TIME_UNAVAILABLE");
        if (time.UnixSeconds < snapshot.LastAcceptedTime || time.UnixSeconds < baseline.AcceptedAt) throw new Refusal("RELEASE_CLOCK_ROLLBACK");
        var current = Authenticate(envelope, policy, schema);
        ValidateDomain(current, policy);
        ValidateTime(current, policy, time.UnixSeconds);
        if (!current.Root.Roles.Contains("release") || !current.Root.Roles.Contains("recovery")) throw new Refusal("RELEASE_KEY_ROLE_INVALID");
        return current;
    }

    private static SignedRelease Authenticate(ReadOnlySpan<byte> envelope, ReleaseTrustPolicy policy, ReleaseSchema schema)
    {
        using var outer = ReleaseJson.Parse(envelope, schema.EnvelopeBytes, schema.Depth);
        schema.Validate("envelope", outer.RootElement);
        var keyId = ReleaseValues.Text(outer.RootElement, "keyId");
        var root = policy.Roots.SingleOrDefault(key => key.KeyId == keyId) ?? throw new Refusal("RELEASE_KEY_UNTRUSTED");
        if (root.Revoked || !root.Roles.Contains("release")) throw new Refusal("RELEASE_KEY_REVOKED_OR_ROLE_INVALID");
        var payload = ReleaseValues.Base64(ReleaseValues.Text(outer.RootElement, "payload"));
        var signature = ReleaseValues.Base64(ReleaseValues.Text(outer.RootElement, "signature"));
        if (payload.Length > schema.PayloadBytes || signature.Length != 64) throw new Refusal("RELEASE_SIGNATURE_INVALID");
        var signed = new byte[Domain.Length + payload.Length]; Domain.CopyTo(signed, 0); payload.CopyTo(signed, Domain.Length);
        using var key = ECDsa.Create(); key.ImportSubjectPublicKeyInfo(root.Spki, out var consumed);
        if (consumed != root.Spki.Length || !key.VerifyData(signed, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) throw new Refusal("RELEASE_SIGNATURE_INVALID");
        using var decoded = ReleaseJson.Parse(payload, schema.PayloadBytes, schema.Depth); schema.Validate("payload", decoded.RootElement);
        return new SignedRelease(decoded.RootElement, root, ReleaseTrustPolicy.Hash(envelope), ReleaseTrustPolicy.Hash(payload));
    }

    private static void ValidateDomain(SignedRelease release, ReleaseTrustPolicy policy)
    {
        var payload = release.Payload;
        if (payload.GetProperty("policyRevision").GetInt32() != policy.Revision) throw new Refusal("RELEASE_POLICY_REVISION_MISMATCH");
        var source = payload.GetProperty("source");
        if (!policy.Sources.Contains(new ReleaseSourceAuthority(ReleaseValues.Text(source, "repository"), ReleaseValues.Text(source, "workflow"), ReleaseValues.Text(source, "ref")))) throw new Refusal("RELEASE_SOURCE_UNTRUSTED");
        CheckIdentity(release.Artifact, release.Text("version"), release.Provenance, policy);
        var previous = payload.GetProperty("previous");
        var previousArtifact = SignedRelease.Identity(previous.GetProperty("artifact"));
        var previousProvenance = SignedRelease.Identity(previous.GetProperty("provenance"));
        CheckIdentity(previousArtifact, ReleaseValues.Text(previous, "version"), previousProvenance, policy);
        var recovery = payload.GetProperty("recoveryAuthorization");
        if (ReleaseValues.Text(recovery, "candidateArtifactSha256") != release.Artifact.Sha256
            || ReleaseValues.Number(recovery, "candidateReleaseSequence") != release.Number("releaseSequence")
            || ReleaseValues.Text(recovery, "previousEnvelopeSha256") != ReleaseValues.Text(previous, "envelopeSha256")
            || ReleaseValues.Text(recovery, "previousArtifactSha256") != previousArtifact.Sha256
            || ReleaseValues.Text(recovery, "previousProvenanceSha256") != previousProvenance.Sha256
            || ReleaseValues.Number(recovery, "expiresAt") > release.Number("expiresAt")
            || ReleaseValues.Number(recovery, "expiresAt") <= release.Number("issuedAt")) throw new Refusal("RELEASE_RECOVERY_BINDING_INVALID");
    }
    private static void CheckIdentity(ReleaseArtifact artifact, string version, ReleaseArtifact provenance, ReleaseTrustPolicy policy)
    {
        if (artifact.Name != "lnwjud-Setup-" + version + ".exe" || provenance.Name != "PROVENANCE.json"
            || artifact.SizeBytes > policy.MaximumPackage || provenance.SizeBytes > policy.MaximumProvenance) throw new Refusal("RELEASE_ARTIFACT_IDENTITY_INVALID");
    }
    private static void CheckUpgrade(SignedRelease current, RetainedInstallationBaseline baseline)
    {
        if (current.Number("releaseSequence") <= baseline.Sequence
            || StableVersion.Parse(current.Text("version")).CompareTo(StableVersion.Parse(baseline.Version)) <= 0) throw new Refusal("RELEASE_REPLAY_OR_DOWNGRADE");
    }
    private static void ValidateTime(SignedRelease release, ReleaseTrustPolicy policy, ulong now)
    {
        var issued = release.Number("issuedAt"); var notBefore = release.Number("notBefore"); var expires = release.Number("expiresAt");
        if (issued != notBefore || expires <= issued || expires - issued > policy.MaximumValidity
            || issued > checked(now + policy.FutureSkew) || now < notBefore || now >= expires
            || now >= ReleaseValues.Number(release.Payload.GetProperty("recoveryAuthorization"), "expiresAt")) throw new Refusal("RELEASE_TIME_INVALID");
        if (now < release.Root.NotBefore || now >= release.Root.ExpiresAt || issued < release.Root.NotBefore || issued >= release.Root.ExpiresAt) throw new Refusal("RELEASE_KEY_TIME_INVALID");
    }
    private static bool VerifyBaseline(SignedRelease candidate, RetainedInstallationBaseline baseline,
        ReleaseTrustPolicy policy, ReleaseSchema schema, ulong now)
    {
        if (ReleaseTrustPolicy.Hash(baseline.OriginalEnvelope) != baseline.EnvelopeSha256 || baseline.Sequence == 0
            || !Wire.Digest(baseline.EnvelopeSha256) || baseline.AcceptedAt > now) throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        var original = Authenticate(baseline.OriginalEnvelope, policy, schema);
        ValidateDomain(original, policy); ValidateTime(original, policy, baseline.AcceptedAt);
        var previous = candidate.Payload.GetProperty("previous");
        if (original.Text("version") != baseline.Version || original.Number("releaseSequence") != baseline.Sequence
            || original.Artifact != baseline.Artifact || original.Provenance != baseline.Provenance || original.Contracts != baseline.Contracts
            || ReleaseValues.Text(previous, "version") != baseline.Version || ReleaseValues.Number(previous, "releaseSequence") != baseline.Sequence
            || ReleaseValues.Text(previous, "envelopeSha256") != baseline.EnvelopeSha256
            || SignedRelease.Identity(previous.GetProperty("artifact")) != baseline.Artifact
            || SignedRelease.Identity(previous.GetProperty("provenance")) != baseline.Provenance) throw new Refusal("RELEASE_BASELINE_IDENTITY_INVALID");
        if (candidate.Contracts != baseline.Contracts) throw new Refusal("RELEASE_RECOVERY_CONTRACT_UNSUPPORTED");
        var historical = now >= original.Number("expiresAt") || now >= original.Root.ExpiresAt;
        if (historical && !original.Root.AllowHistoricalRecovery) throw new Refusal("RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED");
        if (!original.Root.Roles.Contains("recovery")) throw new Refusal("RELEASE_HISTORICAL_KEY_ROLE_INVALID");
        return historical;
    }
}
