using System.IO.Compression;
using System.Security.Cryptography;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal sealed class NativeUpdatePayload : IDisposable
{
    private readonly FileStream archiveFile;
    private readonly ZipArchive archive;
    private readonly Dictionary<string, InstalledFile> files;
    internal WindowsBaselineLayout Layout { get; }

    private NativeUpdatePayload(FileStream archiveFile, ZipArchive archive, WindowsBaselineLayout layout,
        Dictionary<string, InstalledFile> files)
        => (this.archiveFile, this.archive, Layout, this.files) = (archiveFile, archive, layout, files);

    internal static NativeUpdatePayload Open(AuthenticatedUpdatePackage package, ReleaseTrustPolicy policy)
    {
        var layout = WindowsBaselineLayout.ReadInstalledLayout(package.Files);
        using var provenance = ReleaseJson.Parse(package.Files.Read("PROVENANCE.json", checked((int)policy.MaximumProvenance)), checked((int)policy.MaximumProvenance));
        var identity = provenance.RootElement.GetProperty("updatePayload");
        WindowsBaselineLayout.Fields(identity, "name", "sizeBytes", "sha256");
        var payload = SignedRelease.Identity(identity);
        var release = package.Metadata.Candidate.Payload.GetProperty("release");
        if (payload.Name != $"lnwjud-Update-{ReleaseValues.Text(release, "version")}-win32-x64.zip")
            throw new Refusal("UPDATE_PAYLOAD_NAME_INVALID");
        package.Files.Verify(payload.Name, payload, policy.MaximumPackage);
        var stream = new FileStream(package.Files.AbsolutePath(payload.Name), FileMode.Open, FileAccess.Read, FileShare.Read);
        return OpenArchive(stream, layout, package.Files.RecheckAll);
    }

    private static NativeUpdatePayload OpenArchive(FileStream stream, WindowsBaselineLayout layout, Action recheck)
    {
        try
        {
            var zip = new ZipArchive(stream, ZipArchiveMode.Read, true);
            try
            {
                var manifest = ReadManifest(zip, layout);
                var files = layout.ReadManifest(manifest);
                ValidateEntries(zip, files, layout.Manifest);
                recheck();
                return new(stream, zip, layout, files);
            }
            catch { zip.Dispose(); throw; }
        }
        catch { stream.Dispose(); throw; }
    }

    private static byte[] ReadManifest(ZipArchive zip, WindowsBaselineLayout layout)
    {
        if (zip.Entries.Count is 0 or > WindowsBaselineLayout.MaximumFiles + 1)
            throw new Refusal("UPDATE_PAYLOAD_ENTRY_LIMIT");
        var matches = zip.Entries.Where(entry => entry.FullName == "manifest.json").ToArray();
        if (matches.Length != 1 || (ulong)matches[0].Length != layout.Manifest.SizeBytes)
            throw new Refusal("UPDATE_PAYLOAD_MANIFEST_INVALID");
        using var source = matches[0].Open();
        var bytes = new byte[checked((int)layout.Manifest.SizeBytes)];
        source.ReadExactly(bytes);
        if (source.ReadByte() != -1) throw new Refusal("UPDATE_PAYLOAD_MANIFEST_INVALID");
        return bytes;
    }

    private static void ValidateEntries(ZipArchive zip, Dictionary<string, InstalledFile> files, InstalledFile manifest)
    {
        if (zip.Entries.Count != files.Count + 1) throw new Refusal("UPDATE_PAYLOAD_INVENTORY_MISMATCH");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries)
        {
            var mode = (entry.ExternalAttributes >> 16) & 0xf000;
            if (mode is not (0 or 0x8000) || (entry.ExternalAttributes & 0x410) != 0 || !seen.Add(entry.FullName))
                throw new Refusal("UPDATE_PAYLOAD_ENTRY_UNSAFE");
            var expected = entry.FullName == "manifest.json" ? manifest with { Path = "manifest.json" }
                : files.TryGetValue(entry.FullName, out var file) ? file : throw new Refusal("UPDATE_PAYLOAD_INVENTORY_MISMATCH");
            if (entry.FullName != expected.Path || entry.Length < 0 || (ulong)entry.Length != expected.SizeBytes)
                throw new Refusal("UPDATE_PAYLOAD_INVENTORY_MISMATCH");
        }
    }

    internal void ExtractNewSlot(string parentDirectory, string slotName)
    {
        if (slotName is not ("A" or "B")) throw new Refusal("UPDATE_SLOT_NAME_INVALID");
        using var parent = ServiceEndpointIdentity.OpenProtected(parentDirectory, directory: true);
        var destination = Path.Combine(parentDirectory, slotName);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new Refusal("UPDATE_SLOT_ALREADY_PRESENT");
        Directory.CreateDirectory(destination);
        using var root = ServiceEndpointIdentity.OpenProtected(destination, directory: true);
        foreach (var entry in archive.Entries)
        {
            var expected = entry.FullName == "manifest.json" ? Layout.Manifest with { Path = "manifest.json" } : files[entry.FullName];
            var path = Path.Combine(destination, expected.Path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var output = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, FileOptions.WriteThrough);
            using var input = entry.Open();
            CopyVerified(input, output, expected);
        }
        VerifySlot(destination, Layout.Manifest, files);
    }

    internal static void VerifySlot(string directory, InstalledFile manifest, Dictionary<string, InstalledFile> files)
    {
        using var root = ServiceEndpointIdentity.OpenProtected(directory, directory: true);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Visit(string parent)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(parent))
            {
                var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new Refusal("UPDATE_SLOT_REPARSE_POINT");
                if ((attributes & FileAttributes.Directory) != 0) { Visit(path); continue; }
                var relative = Path.GetRelativePath(directory, path).Replace('\\', '/');
                var expected = relative == "manifest.json" ? manifest with { Path = "manifest.json" }
                    : files.TryGetValue(relative, out var file) ? file : throw new Refusal("UPDATE_SLOT_INVENTORY_MISMATCH");
                if (relative != expected.Path || !seen.Add(relative)) throw new Refusal("UPDATE_SLOT_INVENTORY_MISMATCH");
                VerifyFile(path, expected);
            }
        }
        Visit(directory);
        if (seen.Count != files.Count + 1) throw new Refusal("UPDATE_SLOT_INVENTORY_MISMATCH");
    }

    internal static void VerifyFile(string path, InstalledFile expected)
    {
        using var file = ServiceEndpointIdentity.OpenProtected(path, directory: false);
        if ((ulong)RandomAccess.GetLength(file) != expected.SizeBytes) throw new Refusal("UPDATE_INSTALLED_FILE_MISMATCH");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var bytes = new byte[65536];
        long offset = 0;
        int count;
        while ((count = RandomAccess.Read(file, bytes, offset)) != 0) { hash.AppendData(bytes.AsSpan(0, count)); offset += count; }
        if ((ulong)offset != expected.SizeBytes || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != expected.Sha256)
            throw new Refusal("UPDATE_INSTALLED_FILE_MISMATCH");
    }

    private static void CopyVerified(Stream source, FileStream target, InstalledFile expected)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var bytes = new byte[65536];
        ulong count = 0;
        int read;
        while ((read = source.Read(bytes)) != 0)
        {
            if ((ulong)read > expected.SizeBytes - count) throw new Refusal("UPDATE_PAYLOAD_FILE_OVERFLOW");
            target.Write(bytes, 0, read); hash.AppendData(bytes.AsSpan(0, read)); count += (ulong)read;
        }
        target.Flush(true);
        if (count != expected.SizeBytes || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != expected.Sha256)
            throw new Refusal("UPDATE_PAYLOAD_FILE_MISMATCH");
    }

    public void Dispose() { archive.Dispose(); archiveFile.Dispose(); }

#if NATIVE_CONTAINMENT_TESTS
    internal static NativeUpdatePayload OpenFixture(string path, WindowsBaselineLayout layout)
        => OpenArchive(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read), layout, () => { });
    internal void CopyFixture(string name, string destination)
    {
        var expected = files[name];
        using var source = archive.GetEntry(name)!.Open();
        using var target = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        CopyVerified(source, target, expected);
    }
#endif
}
