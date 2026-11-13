using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateAdmission;


internal sealed record NativeFile(byte[] Bytes, string Identity, string Digest);

[SupportedOSPlatform("windows")]
internal sealed class AdmissionStore : IDisposable
{
    internal const int MaximumJournalBytes = 524_288;
    private readonly List<SafeFileHandle> directories = [];
    private readonly string root;
    private readonly string sid;
    private readonly SafeFileHandle ownerLock;
    private bool locked;
    internal string Root => root;

    internal AdmissionStore(StoreIdentity identity)
    {
        root = ValidatePath(identity.Directory);
        sid = identity.OwnerSid;
        try
        {
            PinDirectories(root);
            // The installed store lives below a ProgramData directory that is
            // writable for new child creation by Users. Its immediate parent
            // must therefore be independently protected before path-based IO.
            if (identity.RequireProtectedParent)
            {
                if (directories.Count < 3) throw new Refusal("STATE_PARENT_ACL_UNSAFE");
                ValidateProtectedParent(directories[^2], sid);
            }
            ValidateSecurity(directories[^1], "STATE_ROOT", sid);
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
            if (!Directory.Exists(current)) throw new Refusal("STATE_ROOT_UNPROVISIONED");
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

    private FileInformation ValidateFile(SafeFileHandle handle, int maximum)
    {
        if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & (Reparse | DirectoryAttribute)) != 0
            || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > maximum) throw new Refusal("JOURNAL_FILE_UNSAFE");
        ValidateSecurity(handle, "JOURNAL", sid);
        return info;
    }

    private static void ValidateSecurity(SafeFileHandle handle, string scope, string ownerSid)
    {
        if (GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor) != 0)
            throw new Refusal(scope + "_ACL_UNVERIFIED");
        try
        {
            var length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65_536) throw new Refusal(scope + "_ACL_UNVERIFIED");
            var bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            ValidateSecurityDescriptor(new RawSecurityDescriptor(bytes, 0), ownerSid, scope);
        }
        finally { _ = LocalFree(descriptor); }
    }

    internal static void ValidateRootDacl(RawSecurityDescriptor security, string ownerSid) =>
        ValidateSecurityDescriptor(security, ownerSid, "STATE_ROOT");

    private static void ValidateSecurityDescriptor(RawSecurityDescriptor security, string ownerSid, string scope)
    {
        if (security.Owner?.Value != ownerSid || security.DiscretionaryAcl is null
            || (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
            throw new Refusal(scope + "_ACL_UNSAFE");
        foreach (GenericAce ace in security.DiscretionaryAcl)
        {
            if (ace is not QualifiedAce common || common.IsCallback)
                throw new Refusal(scope + "_ACL_UNVERIFIED");
            if (common.AceQualifier != AceQualifier.AccessAllowed) continue;
            const int writes = 0x40000000 | 0x10000000 | 0x000D0156;
            if ((common.AccessMask & writes) != 0 && common.SecurityIdentifier.Value != ownerSid
                && common.SecurityIdentifier.Value is not "S-1-5-18" and not "S-1-5-32-544")
                throw new Refusal(scope + "_ACL_UNSAFE");
        }
    }

    internal static void VerifyProtectedRootPath(string path, string serviceSid)
    {
        using var handle = OpenDirectory(path);
        ValidateSecurity(handle, "STATE_ROOT", serviceSid);
    }

    // ProgramData itself permits ordinary Users to create child directories.
    // The installed journal's immediate parent must not permit those Users to
    // replace or mutate the journal root. The service SID may only create its
    // own child directory; SYSTEM and Administrators retain full control.
    internal static void ValidateProtectedParentDacl(RawSecurityDescriptor security, string serviceSid)
    {
        if (security.Owner?.Value is not ("S-1-5-18" or "S-1-5-32-544")
            || (security.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0
            || (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0
            || security.DiscretionaryAcl is not { } acl)
            throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        foreach (GenericAce ace in acl)
        {
            if (ace is not QualifiedAce qualified || qualified.IsCallback)
                throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
            // Inherit-only allows do not grant access to the parent itself,
            // but may grant write access to the future journal root or files.
            if (qualified.AceQualifier != AceQualifier.AccessAllowed)
                continue;
            const int writes = 0x40000000 | 0x10000000 | 0x000D0156;
            var granted = qualified.AccessMask & writes;
            var principal = qualified.SecurityIdentifier.Value;
            if (principal is "S-1-5-18" or "S-1-5-32-544") continue;
            if (principal == serviceSid && (granted & ~0x4) == 0) continue;
            if (granted != 0) throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        }
    }

    private static void ValidateProtectedParent(SafeFileHandle handle, string serviceSid)
    {
        if (GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor) != 0)
            throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
        try
        {
            var length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65_536) throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
            var bytes = new byte[length];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            ValidateProtectedParentDacl(new RawSecurityDescriptor(bytes, 0), serviceSid);
        }
        finally { _ = LocalFree(descriptor); }
    }

    internal static void VerifyProtectedParentPath(string path, string serviceSid)
    {
        using var handle = OpenDirectory(path);
        ValidateProtectedParent(handle, serviceSid);
    }

    private static string Identity(FileInformation info) => $"{info.Volume:x8}:{info.IndexHigh:x8}{info.IndexLow:x8}";

    internal NativeFile? Read(string name)
    {
        if (name is not ("admission.json" or "admission.pending.json")) throw new Refusal("STORE_NAME_INVALID");
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
        using var handle = OpenFile(Path.Combine(root, "admission.pending.json"), GenericRead | GenericWrite, 1, WriteThrough);
        RandomAccess.Write(handle, bytes, 0);
        if (!FlushFileBuffers(handle)) throw new Refusal("JOURNAL_FLUSH_FAILED");
        var readback = new byte[bytes.Length];
        if (RandomAccess.Read(handle, readback, 0) != bytes.Length || !readback.AsSpan().SequenceEqual(bytes)) throw new Refusal("JOURNAL_STAGE_CHANGED");
    }

#if ADMISSION_ISOLATED_TESTS
    internal void MarkFreshBootstrap()
    {
        using var marker = OpenFile(Path.Combine(root, "bootstrap.marker"), GenericRead | GenericWrite, 1, WriteThrough);
        RandomAccess.Write(marker, new byte[] { 1 }, 0);
        if (!FlushFileBuffers(marker)) throw new Refusal("ADMISSION_BOOTSTRAP_FLUSH_FAILED");
    }
#endif

    internal void PublishStage(string expectedPredecessor)
    {
        var previous = Read("admission.json");
        if ((previous?.Digest ?? "none") != expectedPredecessor) throw new Refusal("JOURNAL_CAS_CONFLICT");
        var staged = Read("admission.pending.json") ?? throw new Refusal("JOURNAL_STAGE_MISSING");
        if (!MoveFileExW(Path.Combine(root, "admission.pending.json"), Path.Combine(root, "admission.json"), 9))
            throw new Refusal("JOURNAL_PUBLICATION_FAILED");
        var published = Read("admission.json") ?? throw new Refusal("JOURNAL_READBACK_MISSING");
        if (published.Identity != staged.Identity || published.Digest != staged.Digest) throw new Refusal("JOURNAL_READBACK_CHANGED");
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
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
}
