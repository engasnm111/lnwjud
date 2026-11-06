using System.Text.Json;

namespace Lnwjud.UpdateWorker;

/// <summary>
/// A signed first install can be read and pinned, but cannot be enrolled as
/// installed solely because the package publisher supplied an envelope.
/// A protected native installation receipt is required for later updates.
/// </summary>
internal sealed class AuthenticatedBaselinePackage : IDisposable
{
    internal SignedAuthorizationV2 Authorization { get; }
    internal EnrollmentPackageFiles Files { get; }

    private AuthenticatedBaselinePackage(SignedAuthorizationV2 authorization, EnrollmentPackageFiles files)
    {
        Authorization = authorization;
        Files = files;
    }

    internal static AuthenticatedBaselinePackage Open(string directory, ReleaseTrustPolicy policy, ReleaseTimeObservation time)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        var files = new EnrollmentPackageFiles(directory);
        try
        {
            var envelope = files.Read("RELEASE.json", ReleaseSchema.AuthorizationV2().EnvelopeBytes);
            var authorization = ReleaseAuthorizationV2.Authenticate(envelope, policy, time, ReleaseAuthorizationPurpose.Baseline);
            AuthenticatedPackageFiles.Pin(files, authorization.Payload.GetProperty("release"), policy);
            return new AuthenticatedBaselinePackage(authorization, files);
        }
        catch
        {
            files.Dispose();
            throw;
        }
    }

    public void Dispose() => Files.Dispose();
}

internal static class AuthenticatedPackageFiles
{
    internal static void Pin(EnrollmentPackageFiles files, JsonElement release, ReleaseTrustPolicy policy)
    {
        var artifact = SignedRelease.Identity(release.GetProperty("artifact"));
        var provenance = SignedRelease.Identity(release.GetProperty("provenance"));
        if (ReleaseValues.Text(release, "platform") != "win32"
            || ReleaseValues.Text(release, "architecture") != "x64"
            || ReleaseValues.Text(release, "distribution") != "windows-nsis")
            throw new Refusal("RELEASE_TARGET_UNSUPPORTED");
        files.Verify(artifact.Name, artifact, policy.MaximumPackage);
        files.Verify(provenance.Name, provenance, policy.MaximumProvenance);
        var evidence = release.GetProperty("buildEvidence");
        files.PinBundle("artifact.bundle.json", ReleaseValues.Text(evidence, "artifactAttestationSha256"));
        files.PinBundle("provenance.bundle.json", ReleaseValues.Text(evidence, "provenanceAttestationSha256"));
        files.RecheckAll();
    }
}
