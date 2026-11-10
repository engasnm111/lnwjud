using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateAdmission;

// Read-only SCM registration check. A matching configuration is necessary,
// but not sufficient, for trusted enrollment: no image provenance, store
// provisioning, peer authorization or installer capability is conferred.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionRegistration
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryConfig = 0x0001;
    private const uint ReadControl = 0x00020000;
    private const uint OwnerAndDaclSecurityInformation = 0x00000005;
    // A non-administrator may inspect status, but must not reconfigure,
    // start/stop, delete, take ownership of or change this service's DACL.
    private const int PrivilegedServiceRights = 0x000D0172 | 0x70000000;
    private const uint ServiceOwnProcess = 0x0010;
    private const uint ServiceAutoStart = 0x0002;
    private const uint ServiceErrorNormal = 0x0001;
    private const uint ServiceSidUnrestricted = 0x0001;
    private const uint ServiceConfigSidInfo = 5;
    private const int ErrorInsufficientBuffer = 122;
    private const uint MaximumConfigurationBytes = 64 * 1024;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceConfig
    {
        internal uint Type;
        internal uint StartType;
        internal uint ErrorControl;
        internal nint BinaryPath;
        internal nint LoadOrderGroup;
        internal uint TagId;
        internal nint Dependencies;
        internal nint Account;
        internal nint DisplayName;
    }

    private sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeServiceHandle() : base(true) { }
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenSCManagerW")]
    private static extern SafeServiceHandle OpenScManager(string? machine, string? database, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenServiceW")]
    private static extern SafeServiceHandle OpenService(SafeServiceHandle manager, string name, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryServiceConfigW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig(SafeServiceHandle service, nint buffer, uint size, out uint needed);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryServiceConfig2W")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig2(SafeServiceHandle service, uint level, nint buffer, uint size, out uint needed);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "QueryServiceObjectSecurity")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceObjectSecurity(SafeServiceHandle service, uint securityInformation,
        nint buffer, uint size, out uint needed);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(nint handle);

    internal static string ExpectedImagePath(string commonProgramFiles)
    {
        if (string.IsNullOrWhiteSpace(commonProgramFiles) || !Path.IsPathFullyQualified(commonProgramFiles)
            || commonProgramFiles.Contains('"') || commonProgramFiles.Contains('\0')
            || commonProgramFiles.StartsWith(@"\\", StringComparison.Ordinal))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        var root = Path.GetFullPath(commonProgramFiles);
        if (root.Length < 3 || root[2..].Contains(':')) throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        return Path.Combine(root, "lnwjud", "UpdateAdmission", "v1", "lnwjud-update-admission-broker.exe");
    }

    internal static void Validate(string command, string account, uint serviceType,
        uint startType, uint errorControl, uint sidType, string commonProgramFiles)
    {
        var expected = "\"" + ExpectedImagePath(commonProgramFiles) + "\" service";
        if (!string.Equals(command, expected, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(account, @"NT AUTHORITY\LocalService", StringComparison.OrdinalIgnoreCase)
            || serviceType != ServiceOwnProcess || startType != ServiceAutoStart
            || errorControl != ServiceErrorNormal || sidType != ServiceSidUnrestricted)
            throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
    }

    internal static void ValidateRunningImage(string? image, string commonProgramFiles)
    {
        if (string.IsNullOrWhiteSpace(image) || !string.Equals(image, ExpectedImagePath(commonProgramFiles), StringComparison.OrdinalIgnoreCase))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
    }

    // Read-only service-object ACL check; this is not proof of image bytes or
    // protected parent-directory ACLs. Unknown/conditional allow ACEs refuse.
    internal static void ValidateServiceDacl(RawSecurityDescriptor descriptor)
    {
        static bool PrivilegedSid(SecurityIdentifier? sid) => sid?.Value is "S-1-5-18" or "S-1-5-32-544";
        if (!PrivilegedSid(descriptor.Owner)
            || (descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0
            || descriptor.DiscretionaryAcl is not { } acl)
            throw new Refusal("MAINTENANCE_SERVICE_DACL_UNVERIFIED");
        foreach (GenericAce ace in acl)
        {
            if (ace is not QualifiedAce qualified)
                throw new Refusal("MAINTENANCE_SERVICE_DACL_UNVERIFIED");
            if (qualified.AceQualifier != AceQualifier.AccessAllowed) continue;
            if ((qualified.AccessMask & PrivilegedServiceRights) != 0
                && !PrivilegedSid(qualified.SecurityIdentifier))
                throw new Refusal("MAINTENANCE_SERVICE_DACL_UNVERIFIED");
            if (qualified.IsCallback)
                throw new Refusal("MAINTENANCE_SERVICE_DACL_UNVERIFIED");
        }
    }

    internal static void VerifyInstalled()
    {
        if (!OperatingSystem.IsWindows()) throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
        ValidateRunningImage(Environment.ProcessPath, Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles));
        using var manager = OpenScManager(null, null, ScManagerConnect);
        if (manager.IsInvalid) throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
        using var service = OpenService(manager, WindowsUpdateAdmissionService.ServiceName, ServiceQueryConfig | ReadControl);
        if (service.IsInvalid) throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");

        var configBytes = RequiredSize((nint buffer, uint size, out uint needed) =>
            QueryServiceConfig(service, buffer, size, out needed));
        var configBuffer = Marshal.AllocHGlobal(checked((int)configBytes));
        try
        {
            if (!QueryServiceConfig(service, configBuffer, configBytes, out _))
                throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
            var config = Marshal.PtrToStructure<ServiceConfig>(configBuffer);
            var command = Marshal.PtrToStringUni(config.BinaryPath) ?? "";
            var account = Marshal.PtrToStringUni(config.Account) ?? "";
            var sidBytes = RequiredSize((nint buffer, uint size, out uint needed) =>
                QueryServiceConfig2(service, ServiceConfigSidInfo, buffer, size, out needed));
            if (sidBytes < sizeof(uint)) throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
            var sidBuffer = Marshal.AllocHGlobal(checked((int)sidBytes));
            try
            {
                if (!QueryServiceConfig2(service, ServiceConfigSidInfo, sidBuffer, sidBytes, out _))
                    throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
                Validate(command, account, config.Type, config.StartType, config.ErrorControl,
                    unchecked((uint)Marshal.ReadInt32(sidBuffer)),
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles));
                var daclBytes = RequiredSize((nint buffer, uint size, out uint needed) =>
                    QueryServiceObjectSecurity(service, OwnerAndDaclSecurityInformation, buffer, size, out needed));
                var daclBuffer = Marshal.AllocHGlobal(checked((int)daclBytes));
                try
                {
                    if (!QueryServiceObjectSecurity(service, OwnerAndDaclSecurityInformation, daclBuffer, daclBytes, out _))
                        throw new Refusal("MAINTENANCE_SERVICE_DACL_UNVERIFIED");
                    var bytes = new byte[checked((int)daclBytes)];
                    Marshal.Copy(daclBuffer, bytes, 0, bytes.Length);
                    ValidateServiceDacl(new RawSecurityDescriptor(bytes, 0));
                }
                finally { Marshal.FreeHGlobal(daclBuffer); }
            }
            finally { Marshal.FreeHGlobal(sidBuffer); }
        }
        finally { Marshal.FreeHGlobal(configBuffer); }
    }

    private delegate bool Query(nint buffer, uint size, out uint needed);

    private static uint RequiredSize(Query query)
    {
        if (query(0, 0, out var needed) || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer
            || needed == 0 || needed > MaximumConfigurationBytes)
            throw new Refusal("MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED");
        return needed;
    }
}
