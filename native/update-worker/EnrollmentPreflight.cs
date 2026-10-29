using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateWorker;

internal abstract record EnrollmentPreflightResult
{
    internal sealed record Authenticated(string ReleaseId, string Version, string ReleaseEnvelopeSha256,
        string LayoutEnvelopeSha256, string PolicySha256) : EnrollmentPreflightResult;
    internal sealed record Refused(string Reason) : EnrollmentPreflightResult;
}

internal sealed record AuthenticatedEnrollmentPackage(SignedRelease Release,
    EnrollmentPreflightResult.Authenticated Metadata, EnrollmentPackageFiles Files) : IDisposable
{
    public void Dispose() => Files.Dispose();
}

internal sealed class UnsignedEvidencePackage : IDisposable
{
    internal ReleaseEvidenceCandidate Candidate { get; }
    internal string CandidateSha256 { get; }
    internal EnrollmentPackageFiles Files { get; }
    private UnsignedEvidencePackage(ReleaseEvidenceCandidate candidate, string candidateSha256, EnrollmentPackageFiles files)
    {
        Candidate = candidate; CandidateSha256 = candidateSha256; Files = files;
    }
    internal static UnsignedEvidencePackage Open(string directory, ReleaseTrustPolicy policy, ReleaseTimeObservation time,
        ReleaseAuthorizationPurpose purpose, string keyId)
    {
        if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        var files = new EnrollmentPackageFiles(directory);
        try
        {
            var bytes = files.Read("CANDIDATE.json", ReleaseSchema.AuthorizationV2().PayloadBytes);
            var candidate = ReleaseAuthorizationV2.InspectUnsigned(bytes, policy, time, purpose, keyId);
            var payload = candidate.Payload;
            var provenance = SignedRelease.Identity(payload.GetProperty("provenance"));
            files.Verify(candidate.Artifact.Name, candidate.Artifact, policy.MaximumPackage);
            files.Verify(provenance.Name, provenance, policy.MaximumProvenance);
            var evidence = payload.GetProperty("buildEvidence");
            files.PinBundle("artifact.bundle.json", ReleaseValues.Text(evidence, "artifactAttestationSha256"));
            files.PinBundle("provenance.bundle.json", ReleaseValues.Text(evidence, "provenanceAttestationSha256"));
            files.RecheckAll();
            return new UnsignedEvidencePackage(candidate, ReleaseTrustPolicy.Hash(bytes), files);
        }
        catch { files.Dispose(); throw; }
    }
    public void Dispose() => Files.Dispose();
}

internal static class EnrollmentPreflight
{
    internal const string LayoutFile = "ENROLLMENT.json";
    internal const string ReleaseFile = "RELEASE.json";
    private static readonly byte[] Domain = Encoding.ASCII.GetBytes("lnwjud-enrollment-layout-v1\0");

    internal static EnrollmentPreflightResult VerifyPackage(string packageDirectory, ReleaseTrustPolicy policy,
        ReleaseSchema releaseSchema, ReleaseTimeObservation time)
    {
        try
        {
            using var package = OpenAuthenticated(packageDirectory, policy, releaseSchema, time);
            return package.Metadata;
        }
        catch (Refusal error) { return new EnrollmentPreflightResult.Refused(error.Reason); }
        catch (Exception) { return new EnrollmentPreflightResult.Refused("ENROLLMENT_METADATA_INVALID"); }
    }

    internal static AuthenticatedEnrollmentPackage OpenAuthenticated(string packageDirectory, ReleaseTrustPolicy policy,
        ReleaseSchema releaseSchema, ReleaseTimeObservation time)
    {
            if (!policy.Configured) throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
            var files = new EnrollmentPackageFiles(packageDirectory);
        try
        {
            var releaseBytes = files.Read(ReleaseFile, releaseSchema.EnvelopeBytes);
            var release = ReleaseMetadataVerifier.AuthenticateInitial(releaseBytes, policy, releaseSchema, time);
            var layoutBytes = files.Read(LayoutFile, 32_768);
            var layoutSchema = new ReleaseSchema(ReleaseJson.Resource("update-enrollment-schema.json"));
            var (payload, root, _) = ReleaseMetadataVerifier.AuthenticatePayload(layoutBytes, policy, layoutSchema, Domain);
            if (time.UnixSeconds < root.NotBefore || time.UnixSeconds >= root.ExpiresAt
                || release.Number("issuedAt") < root.NotBefore || release.Number("issuedAt") >= root.ExpiresAt)
                throw new Refusal("ENROLLMENT_KEY_TIME_INVALID");
            VerifyBinding(payload, release, policy);
            var paths = payload.GetProperty("layout");
            var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var role in new[] { "stableLauncher", "stableService", "slotApplication", "slotManifest" })
            {
                var image = paths.GetProperty(role);
                var path = ReleaseValues.Text(image, "path");
                if (!CanonicalRolePath(path) || !unique.Add(path)) throw new Refusal("ENROLLMENT_LAYOUT_PATH_INVALID");
            }
            files.Verify(release.Artifact.Name, release.Artifact, policy.MaximumPackage);
            files.Verify("PROVENANCE.json", release.Provenance, policy.MaximumProvenance);
            return new AuthenticatedEnrollmentPackage(release, new EnrollmentPreflightResult.Authenticated(release.Text("releaseId"), release.Text("version"),
                release.EnvelopeDigest, ReleaseTrustPolicy.Hash(layoutBytes), policy.Digest), files);
        }
        catch { files.Dispose(); throw; }
    }

    private static void VerifyBinding(JsonElement layout, SignedRelease release, ReleaseTrustPolicy policy)
    {
        var signed = release.Payload;
        if (layout.GetProperty("policyRevision").GetInt32() != policy.Revision
            || ReleaseValues.Text(layout, "releaseId") != release.Text("releaseId")
            || ReleaseValues.Text(layout, "channel") != release.Text("channel")
            || ReleaseValues.Text(layout, "platform") != release.Text("platform")
            || ReleaseValues.Text(layout, "architecture") != release.Text("architecture")
            || ReleaseValues.Text(layout, "distribution") != release.Text("distribution")
            || ReleaseValues.Text(layout, "version") != release.Text("version")
            || ReleaseValues.Number(layout, "releaseSequence") != release.Number("releaseSequence")
            || ReleaseValues.Text(layout, "releaseEnvelopeSha256") != release.EnvelopeDigest
            || SignedRelease.Identity(layout.GetProperty("artifact")) != release.Artifact
            || SignedRelease.Identity(layout.GetProperty("provenance")) != release.Provenance)
            throw new Refusal("ENROLLMENT_RELEASE_BINDING_INVALID");
        var source = layout.GetProperty("source");
        var releaseSource = signed.GetProperty("source");
        foreach (var name in new[] { "repository", "commit", "workflow", "ref", "runId", "runAttempt" })
            if (ReleaseValues.Text(source, name) != ReleaseValues.Text(releaseSource, name))
                throw new Refusal("ENROLLMENT_RELEASE_BINDING_INVALID");
    }

    private static bool CanonicalRolePath(string path)
    {
        if (path.Length is < 1 or > 240 || path.Contains('\\') || path.Contains(':') || path.Contains('\0')
            || path.StartsWith('/') || path.EndsWith('/')) return false;
        var parts = path.Split('/');
        return parts.All(part => part.Length is >= 1 and <= 128 && part is not ("." or "..")
            && !part.EndsWith('.') && !part.EndsWith(' ')
            && !new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
                "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(part.Split('.')[0], StringComparer.OrdinalIgnoreCase)
            && part.All(c => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '_' or '-'));
    }
}

internal sealed class EnrollmentPackageFiles : IDisposable
{
    private readonly Dictionary<string, (SafeFileHandle Handle, FileInfo Identity, string? Digest)> retained = new(StringComparer.OrdinalIgnoreCase);
    private const uint ReadAccess = 0x80000000;
    private const uint Attributes = 0x80;
    private const uint OpenReparse = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint Reparse = 0x400;
    private const uint Directory = 0x10;
    private readonly List<SafeFileHandle> ancestors = [];
    private readonly string directory;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);

    internal EnrollmentPackageFiles(string directory)
    {
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(directory) || directory.Length > 240
            || directory.StartsWith('\\') || directory.Contains('\0') || directory[2..].Contains(':'))
            throw new Refusal("ENROLLMENT_PACKAGE_PATH_INVALID");
        this.directory = Path.GetFullPath(directory);
        if (!this.directory.Equals(directory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
            || this.directory.Split(Path.DirectorySeparatorChar).Any(part => part.EndsWith('.') || part.EndsWith(' ')))
            throw new Refusal("ENROLLMENT_PACKAGE_PATH_INVALID");
        try
        {
            var volume = Path.GetPathRoot(this.directory)!;
            var components = this.directory[volume.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            var current = volume;
            for (var i = 0; i <= components.Length; i++)
            {
                if (i > 0) current = Path.Combine(current, components[i - 1]);
                var handle = CreateFileW(current, Attributes, 1, 0, 3, OpenReparse | BackupSemantics, 0);
                if (handle.IsInvalid) { handle.Dispose(); throw new Refusal("ENROLLMENT_PACKAGE_UNAVAILABLE"); }
                ancestors.Add(handle);
                if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & (Reparse | Directory)) != Directory)
                    throw new Refusal("ENROLLMENT_PACKAGE_PATH_UNSAFE");
            }
        }
        catch { Dispose(); throw; }
    }

    internal byte[] Read(string name, int maximum)
    {
        var handle = Open(name, (ulong)maximum);
        var before = Info(handle, (ulong)maximum);
        var bytes = new byte[before.SizeLow];
        var offset = 0;
        while (offset < bytes.Length)
        {
            var count = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
            if (count == 0) throw new Refusal("ENROLLMENT_PACKAGE_FILE_CHANGED");
            offset += count;
        }
        CheckSame(before, Info(handle, (ulong)maximum));
        RememberDigest(name, ReleaseTrustPolicy.Hash(bytes));
        return bytes;
    }

    internal void Verify(string name, ReleaseArtifact expected, ulong maximum)
    {
        var handle = Open(name, maximum);
        var before = Info(handle, maximum);
        if (before.SizeLow != expected.SizeBytes) throw new Refusal("ENROLLMENT_ARTIFACT_SIZE_MISMATCH");
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[65_536];
        long offset = 0;
        while ((ulong)offset < expected.SizeBytes)
        {
            var count = RandomAccess.Read(handle, buffer.AsSpan(0, (int)Math.Min((ulong)buffer.Length, expected.SizeBytes - (ulong)offset)), offset);
            if (count == 0) throw new Refusal("ENROLLMENT_PACKAGE_FILE_CHANGED");
            digest.AppendData(buffer.AsSpan(0, count));
            offset += count;
        }
        var hash = Convert.ToHexString(digest.GetHashAndReset()).ToLowerInvariant();
        CheckSame(before, Info(handle, maximum));
        if (hash != expected.Sha256) throw new Refusal("ENROLLMENT_ARTIFACT_DIGEST_MISMATCH");
        RememberDigest(name, hash);
    }

    private SafeFileHandle Open(string name, ulong maximum)
    {
        if (retained.TryGetValue(name, out var existing))
        {
            CheckSame(existing.Identity, Info(existing.Handle, maximum));
            return existing.Handle;
        }
        if (retained.Count >= 6) throw new Refusal("ENROLLMENT_PACKAGE_FILE_LIMIT");
        if (name.Contains('\\') || name.Contains('/') || name.Contains(':') || name.EndsWith('.') || name.EndsWith(' '))
            throw new Refusal("ENROLLMENT_PACKAGE_PATH_INVALID");
        var handle = CreateFileW(Path.Combine(directory, name), ReadAccess, 1, 0, 3, OpenReparse, 0);
        if (handle.IsInvalid) { handle.Dispose(); throw new Refusal("ENROLLMENT_PACKAGE_FILE_MISSING"); }
        try { retained.Add(name, (handle, Info(handle, maximum), null)); return handle; }
        catch { handle.Dispose(); throw; }
    }

    private static FileInfo Info(SafeFileHandle handle, ulong maximum)
    {
        if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & (Reparse | Directory)) != 0
            || info.Links != 1 || ((ulong)info.SizeHigh << 32 | info.SizeLow) > maximum)
            throw new Refusal("ENROLLMENT_PACKAGE_FILE_UNSAFE");
        return info;
    }

    private static void CheckSame(FileInfo before, FileInfo after)
    {
        if (before.Volume != after.Volume || before.IndexHigh != after.IndexHigh || before.IndexLow != after.IndexLow
            || before.SizeHigh != after.SizeHigh || before.SizeLow != after.SizeLow
            || before.Write.dwHighDateTime != after.Write.dwHighDateTime || before.Write.dwLowDateTime != after.Write.dwLowDateTime)
            throw new Refusal("ENROLLMENT_PACKAGE_FILE_CHANGED");
    }

    private void RememberDigest(string name, string digest)
    {
        var entry = retained[name];
        if (entry.Digest is not null && entry.Digest != digest) throw new Refusal("ENROLLMENT_PACKAGE_FILE_CHANGED");
        retained[name] = (entry.Handle, entry.Identity, digest);
    }

    internal string AbsolutePath(string name) => retained.ContainsKey(name) ? Path.Combine(directory, name)
        : throw new Refusal("ENROLLMENT_PACKAGE_FILE_NOT_PINNED");

    internal void PinBundle(string name, string digest)
    {
        var bytes = Read(name, 16 * 1024 * 1024);
        if (ReleaseTrustPolicy.Hash(bytes) != digest) throw new Refusal("RELEASE_SUBJECT_CHANGED");
    }

    internal void RecheckAll()
    {
        foreach (var name in retained.Keys.ToArray())
        {
            var entry = retained[name];
            if (entry.Digest is null) throw new Refusal("ENROLLMENT_PACKAGE_FILE_NOT_HASHED");
            var size = ((ulong)entry.Identity.SizeHigh << 32) | entry.Identity.SizeLow;
            Verify(name, new ReleaseArtifact(name, entry.Digest, size), size);
        }
    }

    public void Dispose()
    {
        foreach (var entry in retained.Values) entry.Handle.Dispose();
        retained.Clear();
        foreach (var handle in ancestors) handle.Dispose();
        ancestors.Clear();
    }
}
