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
