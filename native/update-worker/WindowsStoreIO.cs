using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateWorker;

internal sealed record ProcessOwner(int Pid, string CreationTime, string Executable);
internal sealed record NativeFile(byte[] Bytes, string Identity, string Digest);

[SupportedOSPlatform("windows")]
internal sealed class WindowsStoreIO : IDisposable
{
    internal const int MaximumJournalBytes = 65_536;
    private readonly List<SafeFileHandle> directories = [];
    private readonly string root;
    private readonly SafeFileHandle ownerLock;
    private bool locked;
    internal string Root => root;

    internal WindowsStoreIO(string stateRoot)
    {
        root = ValidatePath(stateRoot);
        try
        {
            PinDirectories(root);
            ValidateSecurity(directories[^1], "STATE_ROOT");
            ownerLock = OpenFile(Path.Combine(root, "owner.lock"), GenericRead | GenericWrite, 4, WriteThrough, 3);
            ValidateFile(ownerLock, 0);
            var overlap = new OverlappedData();
            if (!LockFileEx(ownerLock, 3, 0, 1, 0, ref overlap))
                throw new Refusal(Marshal.GetLastWin32Error() == 33 ? "OWNER_BUSY" : "OWNER_LOCK_UNAVAILABLE");
            locked = true;
        }
        catch
        {
            ownerLock?.Dispose();
            foreach (var directory in directories) directory.Dispose();
            throw;
        }
    }

    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal static string ValidatePath(string value)
    {
        if (!Path.IsPathFullyQualified(value) || value.StartsWith("\\", StringComparison.Ordinal)
            || value.Contains('\0') || value.Length > 240) throw new Refusal("STATE_ROOT_UNSAFE");
        var full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        var volume = Path.GetPathRoot(full);
        if (volume is null || volume.Length != 3 || full.Length <= volume.Length
            || full[3..].Contains(':')) throw new Refusal("STATE_ROOT_UNSAFE");
        return full;
    }

    private void PinDirectories(string directory)
    {
        var volume = Path.GetPathRoot(directory)!;
        var current = volume;
        directories.Add(OpenDirectory(current));
        foreach (var component in directory[volume.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (!Directory.Exists(current)) CreatePrivateDirectory(current);
            directories.Add(OpenDirectory(current));
        }
    }

    private static SafeFileHandle OpenDirectory(string filename)
    {
        var handle = CreateFileW(filename, Attributes | ReadControl, 3, IntPtr.Zero, 3, OpenReparse | BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Refusal("STATE_ROOT_UNAVAILABLE"); }
        if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & Reparse) != 0 || (info.Attributes & DirectoryAttribute) == 0)
        { handle.Dispose(); throw new Refusal("STATE_ROOT_UNSAFE"); }
        return handle;
    }

    private static void CreatePrivateDirectory(string filename)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new Refusal("USER_IDENTITY_UNAVAILABLE");
        var descriptor = IntPtr.Zero;
        try
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW($"O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", 1, out descriptor, out _))
                throw new Refusal("STATE_ROOT_ACL_UNAVAILABLE");
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            if (!CreateDirectoryW(filename, ref attributes) && Marshal.GetLastWin32Error() != 183) throw new Refusal("STATE_ROOT_CREATE_FAILED");
        }
        finally { if (descriptor != IntPtr.Zero) _ = LocalFree(descriptor); }
    }

    private SafeFileHandle OpenFile(string filename, uint access, uint creation, uint flags = 0, uint share = 5)
    {
        var descriptor = IntPtr.Zero;
        var attributesPointer = IntPtr.Zero;
        SafeFileHandle handle;
        var openError = 0;
        try
        {
            if (creation is 1 or 4)
            {
                using var identity = WindowsIdentity.GetCurrent();
                var sid = identity.User?.Value ?? throw new Refusal("USER_IDENTITY_UNAVAILABLE");
                if (!ConvertStringSecurityDescriptorToSecurityDescriptorW($"O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)(A;;FA;;;BA)", 1, out descriptor, out _))
                    throw new Refusal("JOURNAL_ACL_UNAVAILABLE");
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
                attributesPointer = Marshal.AllocHGlobal(attributes.Length);
                Marshal.StructureToPtr(attributes, attributesPointer, false);
            }
            handle = CreateFileW(filename, access, share, attributesPointer, creation, flags | OpenReparse, IntPtr.Zero);
            if (handle.IsInvalid) openError = Marshal.GetLastWin32Error();
        }
        finally
        {
            if (attributesPointer != IntPtr.Zero) Marshal.FreeHGlobal(attributesPointer);
            if (descriptor != IntPtr.Zero) _ = LocalFree(descriptor);
        }
        if (handle.IsInvalid)
        {
            handle.Dispose();
            if (openError == 2) throw new FileNotFoundException();
            throw new Refusal("JOURNAL_FILE_UNAVAILABLE");
        }
        try { ValidateFile(handle, MaximumJournalBytes); return handle; }
        catch { handle.Dispose(); throw; }
    }

    private static FileInformation ValidateFile(SafeFileHandle handle, int maximum)
    {
        if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & (Reparse | DirectoryAttribute)) != 0
            || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > maximum) throw new Refusal("JOURNAL_FILE_UNSAFE");
        ValidateSecurity(handle, "JOURNAL");
        return info;
    }

    private static void ValidateSecurity(SafeFileHandle handle, string scope)
    {
        if (GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor) != 0)
            throw new Refusal(scope + "_ACL_UNVERIFIED");
        try
        {
            var length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65_536) throw new Refusal(scope + "_ACL_UNVERIFIED");
            var bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            using var user = WindowsIdentity.GetCurrent();
            var sid = user.User?.Value ?? throw new Refusal("USER_IDENTITY_UNAVAILABLE");
            if (security.Owner?.Value != sid || security.DiscretionaryAcl is null) throw new Refusal(scope + "_ACL_UNSAFE");
            foreach (GenericAce ace in security.DiscretionaryAcl)
            {
                if (ace is not QualifiedAce common) throw new Refusal(scope + "_ACL_UNVERIFIED");
                if (common.AceQualifier != AceQualifier.AccessAllowed) continue;
                const int writes = 0x40000000 | 0x10000000 | 0x000D0156;
                if ((common.AccessMask & writes) != 0 && common.SecurityIdentifier.Value != sid
                    && common.SecurityIdentifier.Value is not "S-1-5-18" and not "S-1-5-32-544") throw new Refusal(scope + "_ACL_UNSAFE");
            }
        }
        finally { _ = LocalFree(descriptor); }
    }

    private static string Identity(FileInformation info) => $"{info.Volume:x8}:{info.IndexHigh:x8}{info.IndexLow:x8}";

    internal NativeFile? Read(string name)
    {
        SafeFileHandle handle;
        try { handle = OpenFile(Path.Combine(root, name), GenericRead, 3); }
        catch (FileNotFoundException) { return null; }
        using (handle)
        {
            var before = ValidateFile(handle, MaximumJournalBytes);
            var bytes = new byte[before.SizeLow];
            var count = 0;
            while (count < bytes.Length)
            {
                var read = RandomAccess.Read(handle, bytes.AsSpan(count), count);
                if (read == 0) throw new Refusal("JOURNAL_FILE_CHANGED");
                count += read;
            }
            var after = ValidateFile(handle, MaximumJournalBytes);
            if (Identity(before) != Identity(after) || before.SizeLow != after.SizeLow) throw new Refusal("JOURNAL_FILE_CHANGED");
            return new NativeFile(bytes, Identity(after), Hash(bytes));
        }
    }

    internal void Stage(byte[] bytes)
    {
        if (bytes.Length > MaximumJournalBytes) throw new Refusal("JOURNAL_TOO_LARGE");
        using var handle = OpenFile(Path.Combine(root, "journal.pending.json"), GenericRead | GenericWrite, 1, WriteThrough);
        RandomAccess.Write(handle, bytes, 0);
        if (!FlushFileBuffers(handle)) throw new Refusal("JOURNAL_FLUSH_FAILED");
        var readback = new byte[bytes.Length];
        if (RandomAccess.Read(handle, readback, 0) != bytes.Length || !readback.AsSpan().SequenceEqual(bytes)) throw new Refusal("JOURNAL_STAGE_CHANGED");
    }

    internal void PublishStage(string expectedPredecessor)
    {
        var previous = Read("journal.json");
        if ((previous?.Digest ?? "none") != expectedPredecessor) throw new Refusal("JOURNAL_CAS_CONFLICT");
        var staged = Read("journal.pending.json") ?? throw new Refusal("JOURNAL_STAGE_MISSING");
        if (!MoveFileExW(Path.Combine(root, "journal.pending.json"), Path.Combine(root, "journal.json"), 9))
            throw new Refusal("JOURNAL_PUBLICATION_FAILED");
        var published = Read("journal.json") ?? throw new Refusal("JOURNAL_READBACK_MISSING");
        if (published.Identity != staged.Identity || published.Digest != staged.Digest) throw new Refusal("JOURNAL_READBACK_CHANGED");
    }

    internal static ProcessOwner CurrentOwner()
    {
        using var handle = OpenProcess(0x101000, false, (uint)Environment.ProcessId);
        if (handle.IsInvalid || !GetProcessTimes(handle, out var creation, out _, out _, out _)) throw new Refusal("OWNER_IDENTITY_UNAVAILABLE");
        var path = new char[32_768];
        var length = path.Length;
        if (!QueryFullProcessImageNameW(handle, 0, path, ref length)) throw new Refusal("OWNER_IDENTITY_UNAVAILABLE");
        return new ProcessOwner(Environment.ProcessId, creation.Value.ToString(CultureInfo.InvariantCulture), new string(path, 0, length));
    }

    internal static string Observe(ProcessOwner owner)
    {
        using var handle = OpenProcess(0x101000, false, (uint)owner.Pid);
        if (handle.IsInvalid) return Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown";
        if (!GetExitCodeProcess(handle, out var exit)) return "unknown";
        if (exit != 259) return "gone";
        if (!GetProcessTimes(handle, out var creation, out _, out _, out _)) return "unknown";
        if (creation.Value.ToString(CultureInfo.InvariantCulture) != owner.CreationTime) return "gone";
        return "live";
    }

    public void Dispose()
    {
        if (locked)
        {
            var overlap = new OverlappedData();
            _ = UnlockFileEx(ownerLock, 0, 1, 0, ref overlap);
            locked = false;
        }
        ownerLock.Dispose();
        foreach (var directory in directories) directory.Dispose();
    }

    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Attributes = 0x80, ReadControl = 0x00020000;
    private const uint OpenReparse = 0x00200000, BackupSemantics = 0x02000000, WriteThrough = 0x80000000;
    private const uint Reparse = 0x400, DirectoryAttribute = 0x10;
    [StructLayout(LayoutKind.Sequential)] private struct OverlappedData { public nuint Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeTime { public uint Low, High; public readonly ulong Value => ((ulong)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes; public NativeTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool LockFileEx(SafeFileHandle file, uint flags, uint reserved, uint low, uint high, ref OverlappedData overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnlockFileEx(SafeFileHandle file, uint reserved, uint low, uint high, ref OverlappedData overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool FlushFileBuffers(SafeFileHandle file);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool MoveFileExW(string existing, string destination, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeFileHandle process, out NativeTime creation, out NativeTime exit, out NativeTime kernel, out NativeTime user);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exit);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, [Out] char[] path, ref int size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
}
