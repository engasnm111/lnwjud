using System.Text.Json;

namespace Lnwjud.UpdateWorker;

/// <summary>
/// Binds the exact installer, provenance and attestation bundles to an ECDSA-authorized
/// update and the previously accepted installation. This verifies bytes only: it does
/// not grant a process, service, installer, writer or transaction authority.
/// </summary>
internal sealed class AuthenticatedUpdatePackage : IDisposable
{
    internal VerifiedOfferMetadataV2 Metadata { get; }
    internal EnrollmentPackageFiles Files { get; }

    private AuthenticatedUpdatePackage(VerifiedOfferMetadataV2 metadata, EnrollmentPackageFiles files)
    {
        Metadata = metadata;
        Files = files;
    }

    internal static AuthenticatedUpdatePackage Open(string directory, ReleaseTrustPolicy policy,
        ReleaseTimeObservation time, RetainedAuthorizationV2? baseline, ReleaseTrustSnapshot trust)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (baseline is null || !Wire.Digest(baseline.AcceptanceReceiptSha256))
            throw new Refusal("RELEASE_TRUSTED_BASELINE_UNAVAILABLE");
        var files = new EnrollmentPackageFiles(directory);
        try
        {
            var envelope = files.Read("RELEASE.json", ReleaseSchema.AuthorizationV2().EnvelopeBytes);
            var verified = ReleaseAuthorizationV2.VerifyOffer(envelope, policy, time, baseline, trust);
            var release = verified.Candidate.Payload.GetProperty("release");
            AuthenticatedPackageFiles.Pin(files, release, policy);
            return new AuthenticatedUpdatePackage(verified, files);
        }
        catch
        {
            files.Dispose();
            throw;
        }
    }

    public void Dispose() => Files.Dispose();
}
