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

    internal WindowsBaselineLayout ReadInstalledLayout()
        => WindowsBaselineLayout.ReadInstalledLayout(Files);
}

internal sealed record InstalledFile(string Path, ulong SizeBytes, string Sha256);

internal sealed record WindowsBaselineLayout(string Sha256, InstalledFile Launcher, InstalledFile Service, InstalledFile Application, InstalledFile Manifest)
{
    internal const int MaximumManifestBytes = 8 * 1024 * 1024;
    internal const int MaximumFiles = 16384;
    internal const ulong MaximumSlotBytes = 4UL * 1024 * 1024 * 1024;

    internal static WindowsBaselineLayout ReadInstalledLayout(EnrollmentPackageFiles files)
    {
        using var provenance = ReleaseJson.Parse(files.Read("PROVENANCE.json", 1024 * 1024), 1024 * 1024, 64);
        if (provenance.RootElement.ValueKind != JsonValueKind.Object
            || !provenance.RootElement.TryGetProperty("installedLayout", out var identity))
            throw new Refusal("ENROLLMENT_LAYOUT_BINDING_INVALID");
        WindowsBaselineLayout.Fields(identity, "name", "sizeBytes", "sha256");
        var expected = SignedRelease.Identity(identity);
        if (expected.Name != "INSTALL-LAYOUT.json" || expected.SizeBytes is 0 or > 65536 || !Wire.Digest(expected.Sha256))
            throw new Refusal("ENROLLMENT_LAYOUT_BINDING_INVALID");
        var layout = files.Read(expected.Name, 65536);
        if ((ulong)layout.Length != expected.SizeBytes || ReleaseTrustPolicy.Hash(layout) != expected.Sha256)
            throw new Refusal("ENROLLMENT_LAYOUT_BINDING_INVALID");
        return WindowsBaselineLayout.Parse(layout, expected.Sha256);
    }

    internal static WindowsBaselineLayout Parse(byte[] bytes, string digest)
    {
        using var layout = ReleaseJson.Parse(bytes, 65536);
        var value = layout.RootElement;
        Fields(value, "schemaVersion", "product", "platform", "architecture", "slot", "roles");
        if (value.GetProperty("schemaVersion").GetRawText() != "1" || Text(value, "product") != "lnwjud"
            || Text(value, "platform") != "win32" || Text(value, "architecture") != "x64"
            || Text(value, "slot") != "A") throw new Refusal("ENROLLMENT_LAYOUT_INVALID");
        var roles = value.GetProperty("roles");
        Fields(roles, "stableLauncher", "stableService", "slotApplication", "slotManifest");
        InstalledFile Role(string name, string path)
        {
            var file = ReadFile(roles.GetProperty(name));
            if (file.Path != path || file.SizeBytes == 0 || (name == "slotManifest" && file.SizeBytes > MaximumManifestBytes))
                throw new Refusal("ENROLLMENT_LAYOUT_ROLE_INVALID");
            return file;
        }
        return new(digest, Role("stableLauncher", "lnwjud.exe"), Role("stableService", "resources/native-containment/lnwjud-containment.exe"),
            Role("slotApplication", "slots/A/lnwjud.exe"), Role("slotManifest", "slots/A/manifest.json"));
    }

    internal Dictionary<string, InstalledFile> ReadManifest(byte[] bytes)
    {
        if ((ulong)bytes.Length != Manifest.SizeBytes || ReleaseTrustPolicy.Hash(bytes) != Manifest.Sha256)
            throw new Refusal("ENROLLMENT_SLOT_MANIFEST_MISMATCH");
        using var manifest = ReleaseJson.Parse(bytes, MaximumManifestBytes);
        var value = manifest.RootElement;
        Fields(value, "schemaVersion", "files");
        var list = value.GetProperty("files");
        if (value.GetProperty("schemaVersion").GetRawText() != "1" || list.ValueKind != JsonValueKind.Array
            || list.GetArrayLength() is 0 or > MaximumFiles)
            throw new Refusal("ENROLLMENT_SLOT_MANIFEST_INVALID");
        var files = new Dictionary<string, InstalledFile>(StringComparer.OrdinalIgnoreCase);
        var directories = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        ulong total = 0;
        foreach (var element in list.EnumerateArray())
        {
            var file = ReadFile(element);
            if (file.Path.Length is 0 or > 240 || file.Path.Equals("manifest.json", StringComparison.OrdinalIgnoreCase)
                || file.Path.StartsWith("manifest.json/", StringComparison.OrdinalIgnoreCase)
                || file.Path.Split('/').Any(part => !ValidComponent(part)) || directories.ContainsKey(file.Path)
                || !files.TryAdd(file.Path, file)
                || file.SizeBytes > MaximumSlotBytes - total)
                throw new Refusal("ENROLLMENT_SLOT_MANIFEST_INVALID");
            for (var separator = file.Path.IndexOf('/'); separator >= 0; separator = file.Path.IndexOf('/', separator + 1))
            {
                var parent = file.Path[..separator];
                if (files.ContainsKey(parent) || (directories.TryGetValue(parent, out var existing) && existing != parent))
                    throw new Refusal("ENROLLMENT_SLOT_MANIFEST_INVALID");
                directories.TryAdd(parent, parent);
            }
            total += file.SizeBytes;
        }
        if (!files.TryGetValue("lnwjud.exe", out var app) || app.Path != "lnwjud.exe"
            || app.SizeBytes != Application.SizeBytes || app.Sha256 != Application.Sha256)
            throw new Refusal("ENROLLMENT_SLOT_APPLICATION_MISMATCH");
        return files;
    }

    private static bool ValidComponent(string part)
    {
        if (part.Length is 0 or > 128 || part.EndsWith('.') || part.EndsWith(' ')
            || part.Any(c => c < ' ' || c > '~' || c is '\\' or ':' or '*' or '?' or '"' or '<' or '>' or '|')) return false;
        var stem = part.Split('.')[0].TrimEnd(' ', '.').ToUpperInvariant();
        return stem is not ("CON" or "NUL" or "AUX" or "PRN" or "CONIN$" or "CONOUT$")
            && !(stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal))
                && stem[3] is >= '0' and <= '9');
    }

    private static InstalledFile ReadFile(JsonElement value)
    {
        Fields(value, "path", "sizeBytes", "sha256");
        var file = new InstalledFile(Text(value, "path"), Wire.Decimal(Text(value, "sizeBytes")), Text(value, "sha256"));
        if (!Wire.Digest(file.Sha256) || file.SizeBytes > MaximumSlotBytes) throw new Refusal("ENROLLMENT_LAYOUT_INVALID");
        return file;
    }

    private static string Text(JsonElement value, string name)
    {
        var field = value.GetProperty(name);
        return field.ValueKind == JsonValueKind.String ? field.GetString()! : throw new Refusal("ENROLLMENT_LAYOUT_INVALID");
    }

    internal static void Fields(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != names.Length
            || names.Any(name => !value.TryGetProperty(name, out _))) throw new Refusal("ENROLLMENT_LAYOUT_INVALID");
    }
}
