using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class ServiceEndpointIdentity
{
    internal const int QueryLimitedInformation = 0x1000;
    private const uint OwnerGroupDacl = 7;
    private static readonly SecurityIdentifier SystemSid = new("S-1-5-18");
    private static readonly SecurityIdentifier AdministratorsSid = new("S-1-5-32-544");
    private static readonly SecurityIdentifier AuthenticatedUsersSid = new("S-1-5-11");
    private static readonly SecurityIdentifier TrustedInstallerSid = new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTag { internal uint Attributes, ReparseTag; }

    [DllImport("kernel32.dll")] private static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder path, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetKernelObjectSecurity(nint handle, uint information, byte[]? descriptor, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetKernelObjectSecurity(nint handle, uint information, byte[] descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenService(nint manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(nint service, int level, out ServiceStatusProcess status, uint size, out uint needed);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(nint service);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out AttributeTag info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle file, int objectType, uint information, out nint owner, out nint group, out nint dacl, out nint sacl, out nint descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(nint descriptor);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);

    internal sealed class ProductionServiceAuthority : IDisposable
    {
        private readonly PackagePin package;
        private ProductionServiceAuthority(PackagePin package) => this.package = package;

        internal static ProductionServiceAuthority Activate()
        {
            RequirePrimarySystemToken();
            var imagePath = QueryImagePath(GetCurrentProcess());
            var package = PinInstalledImage(imagePath, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
            try
            {
                using var manifest = PinProtectedFile(Path.Combine(Path.GetDirectoryName(imagePath)!, "manifest.json"), package);
                if (manifest.Length is < 2 or > 65536) throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
                using var document = JsonDocument.Parse(manifest, new JsonDocumentOptions { MaxDepth = 8 });
                var root = document.RootElement;
                if (root.GetProperty("schemaVersion").GetInt32() != 2 || root.GetProperty("buildId").GetString() != Program.BuildId
                    || root.GetProperty("platform").GetString() != "win32" || root.GetProperty("architecture").GetString() != "x64"
                    || root.GetProperty("filename").GetString() != "lnwjud-containment.exe"
                    || root.GetProperty("pinFilename").GetString() != "lnwjud-containment-pin.node")
                    throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
                VerifyHash(package.Image, root.GetProperty("sha256").GetString() ?? "");
                using var pin = PinProtectedFile(Path.Combine(Path.GetDirectoryName(imagePath)!, "lnwjud-containment-pin.node"), package);
                VerifyHash(pin, root.GetProperty("pinSha256").GetString() ?? "");
                GrantOwnProcessQuery();
                return new ProductionServiceAuthority(package);
            }
            catch { package.Dispose(); throw; }
        }

        internal void RequireActive() => package.RequireActive();
        public void Dispose() => package.Dispose();
    }

    internal sealed class VerifiedEndpoint : IDisposable
    {
        private readonly SafeProcessHandle process;
        private readonly PackagePin package;
        private readonly nint service;
        private readonly SafePipeHandle pipe;
        private readonly uint pid;
        private VerifiedEndpoint(SafeProcessHandle process, PackagePin package, nint service, SafePipeHandle pipe, uint pid)
        {
            this.process = process;
            this.package = package;
            this.service = service;
            this.pipe = pipe;
            this.pid = pid;
        }

        internal static VerifiedEndpoint Connect(SafePipeHandle pipe, string expectedSha256)
        {
            ValidateHash(expectedSha256);
            var pid = PipePid(pipe);
            var manager = OpenSCManager(null, null, 1);
            if (manager == 0) throw new IOException("SERVICE_ENDPOINT_SCM_UNAVAILABLE");
            nint service;
            try { service = OpenService(manager, WindowsContainmentService.ServiceName, 4); }
            finally { _ = CloseServiceHandle(manager); }
            if (service == 0) throw new IOException("SERVICE_ENDPOINT_NOT_INSTALLED");
            SafeProcessHandle? process = null;
            PackagePin? package = null;
            try
            {
                RequireService(service, pid);
                process = OpenProcess(QueryLimitedInformation, false, pid);
                if (process.IsInvalid) throw new IOException("SERVICE_ENDPOINT_PROCESS_UNAVAILABLE");
                package = PinInstalledImage(QueryImagePath(process.DangerousGetHandle()), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
                VerifyHash(package.Image, expectedSha256);
                var endpoint = new VerifiedEndpoint(process, package, service, pipe, pid);
                endpoint.Revalidate();
                return endpoint;
            }
            catch
            {
                package?.Dispose();
                process?.Dispose();
                _ = CloseServiceHandle(service);
                throw;
            }
        }

        internal void Revalidate()
        {
            package.RequireActive();
            RequireService(service, pid);
            if (PipePid(pipe) != pid || !GetExitCodeProcess(process, out var exitCode) || exitCode != 259)
                throw new IOException("SERVICE_ENDPOINT_RESTARTED");
        }

        public void Dispose()
        {
            package.Dispose();
            process.Dispose();
            _ = CloseServiceHandle(service);
        }
    }

    private sealed class PackagePin : IDisposable
    {
        internal FileStream Image { get; }
        internal List<SafeFileHandle> Ancestors { get; } = new();
        internal PackagePin(FileStream image) => Image = image;
        internal void RequireActive()
        {
            if (Image.SafeFileHandle.IsClosed) throw new ObjectDisposedException(nameof(PackagePin));
        }
        public void Dispose()
        {
            Image.Dispose();
            foreach (var ancestor in Ancestors) ancestor.Dispose();
        }
    }

    internal static ProductionServiceAuthority ActivateProductionService() => ProductionServiceAuthority.Activate();
    internal static VerifiedEndpoint VerifyConnectedServer(SafePipeHandle pipe, string expectedSha256) => VerifiedEndpoint.Connect(pipe, expectedSha256);

    private static void RequirePrimarySystemToken()
    {
        if (!OpenProcessToken(GetCurrentProcess(), 8, out var token)) throw new IOException("SERVICE_ENDPOINT_PRIMARY_TOKEN_UNAVAILABLE");
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
            WindowsContainmentServiceClient.ValidateServerAccount(identity.User?.Value);
    }

    private static string QueryImagePath(nint process)
    {
        var image = new StringBuilder(32768);
        var size = (uint)image.Capacity;
        if (!QueryFullProcessImageName(process, 0, image, ref size) || size == 0 || size >= image.Capacity)
            throw new IOException("SERVICE_ENDPOINT_IMAGE_UNAVAILABLE");
        return Path.GetFullPath(image.ToString());
    }

    private static uint PipePid(SafePipeHandle pipe)
    {
        if (!GetNamedPipeServerProcessId(pipe, out var pid) || pid == 0) throw new IOException("SERVICE_ENDPOINT_PID_UNAVAILABLE");
        return pid;
    }

    private static void RequireService(nint service, uint pipePid)
    {
        if (!QueryServiceStatusEx(service, 0, out var status, (uint)Marshal.SizeOf<ServiceStatusProcess>(), out _))
            throw new IOException("SERVICE_ENDPOINT_STATUS_UNAVAILABLE");
        ValidateServiceBinding(pipePid, status.ProcessId, status.CurrentState, status.ServiceType);
    }

    internal static void ValidateServiceBinding(uint pipePid, uint servicePid, uint state, uint serviceType)
    {
        if (pipePid == 0 || pipePid != servicePid || state != 4 || serviceType != 0x10)
            throw new IOException("SERVICE_ENDPOINT_PID_MISMATCH");
    }

    private static void GrantOwnProcessQuery()
    {
        var process = GetCurrentProcess();
        var expected = AddQueryGrant(ReadProcessDescriptor(process));
        if (!SetKernelObjectSecurity(process, 4, Binary(expected))) throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_WRITE_FAILED");
        ValidateGrantReadback(expected, ReadProcessDescriptor(process));
    }

    private static RawSecurityDescriptor ReadProcessDescriptor(nint process)
    {
        _ = GetKernelObjectSecurity(process, OwnerGroupDacl, null, 0, out var needed);
        if (needed is < 20 or > 65536) throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_READ_FAILED");
        var bytes = new byte[needed];
        if (!GetKernelObjectSecurity(process, OwnerGroupDacl, bytes, needed, out _))
            throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_READ_FAILED");
        return new RawSecurityDescriptor(bytes, 0);
    }

    internal static RawSecurityDescriptor AddQueryGrant(RawSecurityDescriptor original)
    {
        if (!IsTrusted(original.Owner) || (original.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || original.DiscretionaryAcl is null)
            throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_INVALID");
        var copy = new RawSecurityDescriptor(Binary(original), 0);
        var acl = copy.DiscretionaryAcl!;
        var found = false;
        var seenAllow = false;
        for (var index = 0; index < acl.Count; index++)
        {
            if (acl[index] is not CommonAce ace || ace.IsCallback
                || ace.AceQualifier is not (AceQualifier.AccessAllowed or AceQualifier.AccessDenied))
                throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_INVALID");
            if (ace.AceQualifier == AceQualifier.AccessDenied)
            {
                if (seenAllow || (ace.AccessMask & (QueryLimitedInformation | unchecked((int)0x90000000))) != 0)
                    throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_DENIED");
                continue;
            }
            seenAllow = true;
            if (IsTrusted(ace.SecurityIdentifier)) continue;
            if (!ace.SecurityIdentifier.Equals(AuthenticatedUsersSid) || ace.AccessMask != QueryLimitedInformation || ace.AceFlags != AceFlags.None || found)
                throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_UNTRUSTED");
            found = true;
        }
        if (!found) acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, QueryLimitedInformation, AuthenticatedUsersSid, false, null));
        return copy;
    }

    internal static void ValidateGrantReadback(RawSecurityDescriptor expected, RawSecurityDescriptor actual)
    {
        _ = AddQueryGrant(actual);
        if (!Binary(expected).AsSpan().SequenceEqual(Binary(actual)))
            throw new IOException("SERVICE_ENDPOINT_PROCESS_DACL_READBACK_MISMATCH");
    }

    private static byte[] Binary(GenericSecurityDescriptor descriptor)
    {
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static bool IsTrusted(SecurityIdentifier? sid) =>
        sid is not null && (sid.Equals(SystemSid) || sid.Equals(AdministratorsSid) || sid.Equals(TrustedInstallerSid)
#if NATIVE_CONTAINMENT_TESTS
        || (WindowsIdentity.GetCurrent().User is { } user && sid.Equals(user))
#endif
        );

    internal static void ValidateProtectedDescriptor(RawSecurityDescriptor descriptor)
    {
        if (!IsTrusted(descriptor.Owner) || (descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || descriptor.DiscretionaryAcl is null)
            throw new IOException("SERVICE_ENDPOINT_IMAGE_OWNER_UNTRUSTED");
        const int mutation = 0x40000000 | 0x10000000 | 0x000d0156;
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            if (entry is not CommonAce ace || ace.IsCallback) throw new IOException("SERVICE_ENDPOINT_IMAGE_ACL_INVALID");
            if (ace.AceQualifier == AceQualifier.AccessDenied) continue;
            if (ace.AceQualifier != AceQualifier.AccessAllowed) throw new IOException("SERVICE_ENDPOINT_IMAGE_ACL_INVALID");
            if ((ace.AceFlags & AceFlags.InheritOnly) == 0 && !IsTrusted(ace.SecurityIdentifier) && (ace.AccessMask & mutation) != 0)
                throw new IOException("SERVICE_ENDPOINT_IMAGE_WRITABLE");
        }
    }

    private static SafeFileHandle OpenProtected(string path, bool directory)
    {
        var handle = CreateFile(path, directory ? 0x20080u : 0x80000000u, directory ? 3u : 1u, 0, 3, 0x00200000 | (directory ? 0x02000000u : 0u), 0);
        try
        {
            if (handle.IsInvalid || !GetFileInformationByHandleEx(handle, 9, out var attributes, (uint)Marshal.SizeOf<AttributeTag>()))
                throw new IOException("SERVICE_ENDPOINT_IMAGE_UNAVAILABLE");
            if ((attributes.Attributes & 0x400) != 0) throw new IOException("SERVICE_ENDPOINT_REPARSE_PATH");
            var final = new StringBuilder(32768);
            var length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity || !String.Equals(final.ToString(), @"\\?\" + Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase))
                throw new IOException("SERVICE_ENDPOINT_IMAGE_PATH_MISMATCH");
            if (GetSecurityInfo(handle, 1, OwnerGroupDacl, out _, out _, out _, out _, out var descriptor) != 0)
                throw new IOException("SERVICE_ENDPOINT_IMAGE_ACL_UNAVAILABLE");
            try
            {
                var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
                Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                ValidateProtectedDescriptor(new RawSecurityDescriptor(bytes, 0));
            }
            finally { _ = LocalFree(descriptor); }
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    private static PackagePin PinInstalledImage(string imagePath, string programFilesRoot)
    {
        _ = WindowsContainmentServiceInstaller.ValidateImagePath(imagePath, programFilesRoot);
        var package = new PackagePin(new FileStream(OpenProtected(imagePath, false), FileAccess.Read));
        try
        {
            var current = Path.GetDirectoryName(imagePath);
            var root = Path.GetFullPath(programFilesRoot);
            while (current is not null)
            {
                package.Ancestors.Add(OpenProtected(current, true));
                if (String.Equals(current, root, StringComparison.OrdinalIgnoreCase)) break;
                current = Path.GetDirectoryName(current);
            }
            if (current is null) throw new IOException("SERVICE_ENDPOINT_IMAGE_PATH_MISMATCH");
            while ((current = Path.GetDirectoryName(current)) is not null)
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("SERVICE_ENDPOINT_REPARSE_PATH");
            return package;
        }
        catch { package.Dispose(); throw; }
    }

    private static FileStream PinProtectedFile(string path, PackagePin package)
    {
        package.RequireActive();
        return new FileStream(OpenProtected(path, false), FileAccess.Read);
    }

    internal static void ValidateImage(string imagePath, string programFilesRoot, string expectedSha256)
    {
        ValidateHash(expectedSha256);
        using var package = PinInstalledImage(imagePath, programFilesRoot);
        VerifyHash(package.Image, expectedSha256);
    }

    private static void ValidateHash(string hash)
    {
        if (hash.Length != 64 || hash.Any(character => !Uri.IsHexDigit(character))) throw new IOException("SERVICE_CLIENT_PACKAGE_ID_INVALID");
    }

    private static void VerifyHash(FileStream image, string expectedSha256)
    {
        ValidateHash(expectedSha256);
        image.Position = 0;
        if (!String.Equals(Convert.ToHexString(SHA256.HashData(image)), expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new IOException("SERVICE_ENDPOINT_PACKAGE_MISMATCH");
    }
}
