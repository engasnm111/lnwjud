using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;

namespace Lnwjud.UpdateWorker;

// A witness settles one registered first-party writer, never the entire installation.
[SupportedOSPlatform("windows")]
internal sealed class NativeUpdateWriterWitness : IDisposable
{
    private readonly SafeProcessHandle process;
    private readonly SafeFileHandle job;
    private readonly SafeFileHandle image;
    internal string WriterId { get; }
    internal int ProcessId { get; }
    internal string CreationTime { get; }
    internal string ImageSha256 { get; private init; } = "";

    private NativeUpdateWriterWitness(string writerId, int pid, string creationTime, SafeProcessHandle process, SafeFileHandle job, SafeFileHandle image)
        => (WriterId, ProcessId, CreationTime, this.process, this.job, this.image) = (writerId, pid, creationTime, process, job, image);

    internal static NativeUpdateWriterWitness Capture(string writerId, int pid, string jobName, string imagePath, InstalledFile expected)
        => CaptureCore(writerId, pid, jobName, imagePath, expected, true);

    private static NativeUpdateWriterWitness CaptureCore(string writerId, int pid, string jobName, string imagePath, InstalledFile expected, bool protectedImage)
    {
        if (!Guid.TryParseExact(writerId, "D", out _) || pid <= 0 || jobName.Length is 0 or > 256 || !Path.IsPathFullyQualified(imagePath)
            || !Wire.Digest(expected.Sha256)) throw new Refusal("UPDATE_WRITER_IDENTITY_INVALID");
        var process = OpenProcess(0x00101000, false, (uint)pid);
        SafeFileHandle? job = null, image = null;
        try
        {
            if (process.IsInvalid || WaitForSingleObject(process, 0) != 258 || !GetProcessTimes(process, out var creation, out _, out _, out _))
                throw new Refusal("UPDATE_WRITER_PROCESS_UNAVAILABLE");
            var path = new StringBuilder(32768);
            var length = (uint)path.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, path, ref length)
                || !String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(imagePath), StringComparison.OrdinalIgnoreCase))
                throw new Refusal("UPDATE_WRITER_IMAGE_MISMATCH");
            image = CreateFileW(imagePath, 0x80020000, 1, 0, 3, 0x00200000, 0);
            if (image.IsInvalid || !GetFileInformationByHandle(image, out var info) || (info.Attributes & 0x410) != 0 || info.Links != 1
                || (((ulong)info.SizeHigh << 32) | info.SizeLow) != expected.SizeBytes)
                throw new Refusal("UPDATE_WRITER_IMAGE_UNSAFE");
            if (protectedImage) RequireProtectedImage(image);
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                var bytes = new byte[65536];
                long offset = 0;
                int count;
                while ((count = RandomAccess.Read(image, bytes, offset)) != 0) { hash.AppendData(bytes.AsSpan(0, count)); offset += count; }
                if ((ulong)offset != expected.SizeBytes || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != expected.Sha256)
                    throw new Refusal("UPDATE_WRITER_IMAGE_MISMATCH");
            }
            job = OpenJobObjectW(4, false, jobName);
            if (job.IsInvalid || !IsProcessInJob(process, job, out var member) || !member)
                throw new Refusal("UPDATE_WRITER_JOB_MISMATCH");
            return new(writerId, pid, creation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), process, job, image)
                { ImageSha256 = expected.Sha256 };
        }
        catch { image?.Dispose(); job?.Dispose(); process.Dispose(); throw; }
    }

    internal bool ObserveCessation()
    {
        if (process.IsClosed || job.IsClosed || image.IsClosed || WaitForSingleObject(process, 0) != 0)
            return false;
        return QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), 0)
            && accounting.ActiveProcesses == 0;
    }

    internal bool ObserveRunning() => WaitForSingleObject(process, 0) == 258
        && IsProcessInJob(process, job, out var member) && member
        && QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), 0)
        && accounting.ActiveProcesses > 0;

    private static void RequireProtectedImage(SafeFileHandle image)
    {
        if (GetSecurityInfo(image, 1, 5, out _, out _, out _, out _, out var descriptor) != 0)
            throw new Refusal("UPDATE_WRITER_IMAGE_ACL_UNAVAILABLE");
        try
        {
            var size = GetSecurityDescriptorLength(descriptor);
            if (size is < 20 or > 65536) throw new Refusal("UPDATE_WRITER_IMAGE_ACL_UNAVAILABLE");
            var bytes = new byte[size];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            if (!Trusted(security.Owner?.Value) || security.DiscretionaryAcl is null)
                throw new Refusal("UPDATE_WRITER_IMAGE_ACL_UNSAFE");
            foreach (GenericAce ace in security.DiscretionaryAcl)
            {
                if (ace is not QualifiedAce item) throw new Refusal("UPDATE_WRITER_IMAGE_ACL_UNSAFE");
                if (item.AceQualifier == AceQualifier.AccessAllowed && (item.AccessMask & 0x500d0156) != 0 && !Trusted(item.SecurityIdentifier.Value))
                    throw new Refusal("UPDATE_WRITER_IMAGE_ACL_UNSAFE");
            }
        }
        finally { _ = LocalFree(descriptor); }
    }
    private static bool Trusted(string? sid) => sid is "S-1-5-18" or "S-1-5-32-544"
        or "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

    public void Dispose() { image.Dispose(); job.Dispose(); process.Dispose(); }

#if NATIVE_UPDATE_TESTS || NATIVE_CONTAINMENT_TESTS
    internal static NativeUpdateWriterWitness CaptureFixture(string writerId, int pid, string jobName, string imagePath, InstalledFile expected)
        => CaptureCore(writerId, pid, jobName, imagePath, expected, false);
#endif

    [StructLayout(LayoutKind.Sequential)] private struct NativeTime { internal uint Low, High; internal readonly ulong Value => ((ulong)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { internal uint Attributes; internal NativeTime Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting { internal long User, Kernel, PeriodUser, PeriodKernel; internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out NativeTime creation, out NativeTime exit, out NativeTime kernel, out NativeTime user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeProcessHandle process, SafeFileHandle job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out Accounting value, uint size, nint returned);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out nint owner, out nint group, out nint dacl, out nint sacl, out nint descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(nint descriptor);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);
}
