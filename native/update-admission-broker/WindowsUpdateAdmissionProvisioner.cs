using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateAdmission;

// Attended, elevated SCM enrollment of an ALREADY protected and independently
// selected broker image. This does not enroll a journal, start the service,
// authenticate an image signer, or enable an update operation.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionProvisioner
{
    private const uint ScManagerCreateService = 0x0002;
    private const uint ServiceAllAccess = 0x000F01FF;
    private const uint ServiceOwnProcess = 0x0010;
    private const uint ServiceAutoStart = 0x0002;
    private const uint ServiceDisabled = 0x0004;
    private const uint ServiceNoChange = 0xFFFFFFFF;
    private const uint ServiceErrorNormal = 0x0001;
    private const uint ServiceConfigSidInfo = 5;
    private const uint OwnerAndDaclSecurityInformation = 5;
    private const uint DaclSecurityInformation = 4;
    private const uint SecurityDescriptorRevision = 1;
    private const string ServiceSecurityDescriptor =
        "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;LC;;;AU)";

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceSidInfo { internal uint Type; }

    private sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeServiceHandle() : base(true) { }
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenSCManagerW")]
    private static extern SafeServiceHandle OpenScManager(string? machine, string? database, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateServiceW")]
    private static extern SafeServiceHandle CreateService(SafeServiceHandle manager, string name, string displayName,
        uint access, uint type, uint startType, uint errorControl, string binaryPath,
        string? group, nint tag, string? dependencies, string? account, string? password);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ChangeServiceConfigW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig(SafeServiceHandle service, uint type, uint startType,
        uint errorControl, string? binaryPath, string? group, nint tag, string? dependencies,
        string? account, string? password, string? displayName);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "ChangeServiceConfig2W")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig2(SafeServiceHandle service, uint level, ref ServiceSidInfo info);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetServiceObjectSecurity")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceObjectSecurity(SafeServiceHandle service, uint securityInformation, nint descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true,
        EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSecurityDescriptor(string sddl, uint revision,
        out nint descriptor, out uint length);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteService(SafeServiceHandle service);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(nint handle);

    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint pointer);

    internal static byte[] ValidatePin(string? sha256)
    {
        if (sha256 is null || sha256.Length != 64 || !sha256.All(Uri.IsHexDigit))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        return Convert.FromHexString(sha256);
    }

    internal static void ProvisionService(string expectedSha256)
    {
        if (!OperatingSystem.IsWindows()
            || !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new Refusal("MAINTENANCE_SERVICE_PROVISIONER_REQUIRES_ELEVATION");

        var pin = ValidatePin(expectedSha256);
        var commonFiles = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles);
        var image = WindowsUpdateAdmissionRegistration.ExpectedImagePath(commonFiles);
        WindowsUpdateAdmissionRegistration.VerifyImageFilesystem(commonFiles);
        // An operator-provided digest is a mismatch guard, NOT an independently
        // trusted signer. A trusted installer must supply an authenticated pin.
        using (var stream = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(stream), pin))
                throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        }
        WindowsUpdateAdmissionRegistration.VerifyImageFilesystem(commonFiles);

        using var manager = OpenScManager(null, null, ScManagerCreateService);
        if (manager.IsInvalid) throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
        // Create-only: never seize or modify an existing service, even if its
        // name matches. No start, no service replacement, no journal creation.
        using var service = CreateService(manager, WindowsUpdateAdmissionService.ServiceName,
            "lnwjud Update Admission (unavailable until trusted enrollment)",
            ServiceAllAccess, ServiceOwnProcess, ServiceDisabled, ServiceErrorNormal,
            "\"" + image + "\" service", null, 0, null, @"NT AUTHORITY\LocalService", null);
        if (service.IsInvalid) throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");

        var completed = false;
        try
        {
            var sid = new ServiceSidInfo { Type = 1 }; // SERVICE_SID_TYPE_UNRESTRICTED
            if (!ChangeServiceConfig2(service, ServiceConfigSidInfo, ref sid))
                throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
            if (!ConvertSecurityDescriptor(ServiceSecurityDescriptor, SecurityDescriptorRevision,
                    out var descriptor, out _))
                throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
            try
            {
                // Some elevated admin tokens cannot assign the BA owner.
                // DACL-only fallback is safe ONLY if the subsequent readback
                // confirms SCM already assigned a trusted owner (SY or BA).
                if (!SetServiceObjectSecurity(service, OwnerAndDaclSecurityInformation, descriptor)
                    && !SetServiceObjectSecurity(service, DaclSecurityInformation, descriptor))
                    throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
            }
            finally { _ = LocalFree(descriptor); }

            // Do not make the service startable until its SID and ACL are set.
            if (!ChangeServiceConfig(service, ServiceNoChange, ServiceAutoStart, ServiceNoChange,
                    null, null, 0, null, null, null, null))
                throw new Refusal("MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
            // Re-read the actual SCM record, not our input arguments.
            WindowsUpdateAdmissionRegistration.VerifyServiceConfiguration(commonFiles);
            WindowsUpdateAdmissionRegistration.VerifyImageFilesystem(commonFiles);
            using (var stream = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(stream), pin))
                    throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
            }
            completed = true;
        }
        finally
        {
            // A partial registration must not be left as an apparently
            // provisioned service. An uncertain cleanup is a hard failure.
            if (!completed && !DeleteService(service))
                throw new Refusal("MAINTENANCE_SERVICE_PROVISION_ROLLBACK_UNVERIFIED");
        }
    }
}
