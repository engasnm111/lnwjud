using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal static class NativeUpdateData
{
    private const ulong MaximumBytes = 4UL * 1024 * 1024 * 1024;
    private const int MaximumFiles = 16384;

    internal static string DefaultProfile(nint token)
    {
        var folder = new Guid("3eb685db-65f9-4cf6-a03a-e3ef65729f3d");
        var result = SHGetKnownFolderPath(in folder, 0, token, out var text);
        try
        {
            if (result != 0 || Marshal.PtrToStringUni(text) is not { } path || !Path.IsPathFullyQualified(path))
                throw new Refusal("UPDATE_PROFILE_UNAVAILABLE");
            return WindowsStoreIO.ValidatePath(Path.Combine(path, "lnwjud"));
        }
        finally { Marshal.FreeCoTaskMem(text); }
    }

    internal static string CloneNew(string source, string destination, SafeAccessTokenHandle? readAs = null)
    {
        using var parent = ServiceEndpointIdentity.OpenProtected(Path.GetDirectoryName(destination)!, directory: true);
        return CloneNewCore(source, destination, readAs);
    }

    internal static string DigestProtected(string source)
    {
        using var root = ServiceEndpointIdentity.OpenProtected(source, directory: true);
        return CloneNewCore(source, null, null);
    }

    private static string CloneNewCore(string source, string? destination, SafeAccessTokenHandle? readAs)
    {
        _ = WindowsStoreIO.ValidatePath(source);
        if (destination is not null)
        {
            _ = WindowsStoreIO.ValidatePath(destination);
            if (Directory.Exists(destination) || File.Exists(destination)) throw new Refusal("UPDATE_PROFILE_DESTINATION_INVALID");
            Directory.CreateDirectory(destination);
        }
        var pins = new List<SafeFileHandle>();
        var manifest = new JsonArray();
        var folders = new JsonArray();
        ulong total = 0;
        var count = 0;
        T ReadAsUser<T>(Func<T> action) => readAs is null ? action() : WindowsIdentity.RunImpersonated(readAs, action);
        try
        {
            void Visit(string directory)
            {
                var pin = ReadAsUser(() => Pin(directory, directory: true));
                pins.Add(pin);
                foreach (var path in ReadAsUser(() => Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.OrdinalIgnoreCase).ToArray()))
                {
                    var attributes = File.GetAttributes(path);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) throw new Refusal("UPDATE_PROFILE_REPARSE_POINT");
                    var relative = Path.GetRelativePath(source, path);
                    var target = destination is null ? null : Path.Combine(destination, relative);
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        folders.Add(relative.Replace('\\', '/'));
                        if (target is not null) Directory.CreateDirectory(target);
                        Visit(path); continue;
                    }
                    if (++count > MaximumFiles) throw new Refusal("UPDATE_PROFILE_FILE_LIMIT");
                    var handle = ReadAsUser(() => Pin(path, directory: false));
                    pins.Add(handle);
                    var streams = new JsonArray();
                    foreach (var streamName in Streams(path))
                    {
                        var suffix = streamName == "::$DATA" ? "" : streamName[..^6];
                        using var input = suffix.Length == 0 ? null : ReadAsUser(() => Pin(path + suffix, directory: false));
                        var current = input ?? handle;
                        var size = checked((ulong)RandomAccess.GetLength(current));
                        if (size > MaximumBytes - total) throw new Refusal("UPDATE_PROFILE_BYTE_LIMIT");
                        total += size;
                        using var output = target is null ? null : new FileStream(target + suffix, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, FileOptions.WriteThrough);
                        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                        var buffer = new byte[65536];
                        long offset = 0;
                        int read;
                        while ((read = RandomAccess.Read(current, buffer, offset)) != 0)
                        {
                            if ((ulong)read > size - (ulong)offset) throw new Refusal("UPDATE_PROFILE_CHANGED");
                            output?.Write(buffer, 0, read); hash.AppendData(buffer.AsSpan(0, read)); offset += read;
                        }
                        output?.Flush(true);
                        if ((ulong)offset != size) throw new Refusal("UPDATE_PROFILE_CHANGED");
                        var digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                        if (output is not null)
                        {
                            output.Position = 0;
                            if (Convert.ToHexString(SHA256.HashData(output)).ToLowerInvariant() != digest) throw new Refusal("UPDATE_PROFILE_COPY_CHANGED");
                        }
                        streams.Add(new JsonObject { ["name"] = streamName, ["sizeBytes"] = Wire.Decimal(size), ["sha256"] = digest });
                    }
                    manifest.Add(new JsonObject { ["path"] = relative.Replace('\\', '/'), ["streams"] = streams });
                }
            }
            bool SourceExists()
            {
                try { return (File.GetAttributes(source) & FileAttributes.Directory) != 0; }
                catch (FileNotFoundException) { return false; }
                catch (DirectoryNotFoundException) { return false; }
            }
            if (ReadAsUser(SourceExists))
            {
                var components = new Stack<string>();
                for (var path = Path.GetFullPath(source); path.Length > 3; path = Path.GetDirectoryName(path)!) components.Push(path);
                while (components.TryPop(out var path)) pins.Add(ReadAsUser(() => Pin(path, directory: true)));
                Visit(source);
            }
            else if (destination is null) throw new Refusal("UPDATE_PROFILE_SNAPSHOT_MISSING");
            return ReleaseTrustPolicy.Hash(Wire.Encode(new JsonObject { ["schema"] = 1, ["files"] = manifest, ["directories"] = folders }));
        }
        finally { foreach (var pin in pins) pin.Dispose(); }
    }

#if NATIVE_CONTAINMENT_TESTS
    internal static string CloneFixture(string source, string destination) => CloneNewCore(source, destination, null);
#endif

    internal static void MakeWritable(string directory, string ownerSid)
    {
        var user = new SecurityIdentifier(ownerSid);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var pins = new List<(SafeFileHandle Handle, bool Directory, bool Root)>();
        void Capture(string path, bool root)
        {
            var folder = (File.GetAttributes(path) & FileAttributes.Directory) != 0;
            var handle = CreateFileW(path, 0xe0080, 1, 0, 3, 0x00200000 | (folder ? 0x02000000u : 0), 0);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x400) != 0
                || (!folder && info.Links != 1)) { handle.Dispose(); throw new Refusal("UPDATE_PROFILE_SECURITY_UNSAFE"); }
            pins.Add((handle, folder, root));
            if (folder) foreach (var child in Directory.EnumerateFileSystemEntries(path)) Capture(child, false);
        }
        void Secure(SafeFileHandle handle, bool folder, bool root)
        {
            var inheritance = folder ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
            FileSystemSecurity security = folder ? new DirectorySecurity() : new FileSecurity();
            security.SetAccessRuleProtection(true, false); security.SetOwner(system);
            security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(user, root ? FileSystemRights.ReadAndExecute | FileSystemRights.Write : FileSystemRights.Modify,
                inheritance, PropagationFlags.None, AccessControlType.Allow));
            var bytes = security.GetSecurityDescriptorBinaryForm();
            var descriptor = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, descriptor, bytes.Length);
                if (!GetSecurityDescriptorOwner(descriptor, out var owner, out _)
                    || !GetSecurityDescriptorDacl(descriptor, out var present, out var acl, out _) || !present
                    || SetSecurityInfo(handle, 1, 5, owner, 0, acl, 0) != 0)
                    throw new Refusal("UPDATE_PROFILE_SECURITY_UNAVAILABLE");
            }
            finally { Marshal.FreeHGlobal(descriptor); }
        }
        try { Capture(directory, true); foreach (var pin in pins) Secure(pin.Handle, pin.Directory, pin.Root); }
        finally { foreach (var pin in pins) pin.Handle.Dispose(); }
    }

    private static SafeFileHandle Pin(string path, bool directory)
    {
        var handle = CreateFileW(path, 0x80000000, 1, 0, 3, 0x00200000 | (directory ? 0x02000000u : 0), 0);
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var information)
            || (information.Attributes & 0x400) != 0 || ((information.Attributes & 0x10) != 0) != directory
            || (!directory && information.Links != 1))
        { handle.Dispose(); throw new Refusal("UPDATE_PROFILE_FILE_UNSAFE"); }
        return handle;
    }

    private static string[] Streams(string path)
    {
        var find = FindFirstStreamW(path, 0, out var data, 0);
        if (find == -1) throw new Refusal("UPDATE_PROFILE_STREAMS_UNAVAILABLE");
        var result = new List<string>();
        try
        {
            do
            {
                var name = data.Name;
                if (result.Count >= 64 || !name.StartsWith(':') || !name.EndsWith(":$DATA", StringComparison.Ordinal)
                    || name.Contains('/') || name.Contains('\\') || result.Contains(name, StringComparer.OrdinalIgnoreCase))
                    throw new Refusal("UPDATE_PROFILE_STREAMS_UNSAFE");
                result.Add(name);
            } while (FindNextStreamW(find, out data));
            if (Marshal.GetLastWin32Error() != 38 || !result.Contains("::$DATA", StringComparer.Ordinal))
                throw new Refusal("UPDATE_PROFILE_STREAMS_UNAVAILABLE");
            return result.OrderBy(name => name == "::$DATA" ? 0 : 1).ThenBy(name => name, StringComparer.Ordinal).ToArray();
        }
        finally { FindClose(find); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StreamInformation
    { internal long Size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)] internal string Name; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint creation, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint FindFirstStreamW(string path, int level, out StreamInformation data, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool FindNextStreamW(nint find, out StreamInformation data);
    [DllImport("kernel32.dll")] private static extern bool FindClose(nint find);
    [DllImport("shell32.dll")] private static extern int SHGetKnownFolderPath(in Guid folder, uint flags, nint token, out nint path);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, nint owner, nint group, nint dacl, nint sacl);
    [DllImport("advapi32.dll")] private static extern bool GetSecurityDescriptorOwner(nint descriptor, out nint owner, out bool defaulted);
    [DllImport("advapi32.dll")] private static extern bool GetSecurityDescriptorDacl(nint descriptor, out bool present, out nint dacl, out bool defaulted);
}
