using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateAdmission;

// Attended, create-only protection of the immediate ProgramData journal
// parent. No store, journal, trust enrollment or update permit is created.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionStoreParentProvisioner
{
    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdministratorsSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal nint SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateDirectoryW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryWithSecurity(string path, ref SecurityAttributes security);

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { internal uint Low; internal int High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes { internal Luid Luid; internal uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        internal uint Count;
        internal LuidAndAttributes Entry;
    }

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(nint process, uint access, out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "LookupPrivilegeValueW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string? system, string privilege, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "AdjustTokenPrivileges")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(SafeAccessTokenHandle token, bool disableAll,
        ref TokenPrivileges desired, uint bufferLength, out TokenPrivileges previous, out uint returned);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "AdjustTokenPrivileges")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RestoreTokenPrivileges(SafeAccessTokenHandle token, bool disableAll,
        ref TokenPrivileges previous, uint bufferLength, nint ignoredPrevious, nint ignoredLength);

    private static void WithRestorePrivilege(Action action)
    {
        const uint tokenAdjustPrivileges = 0x20, tokenQuery = 0x8, enabled = 0x2;
        if (!OpenProcessToken(GetCurrentProcess(), tokenAdjustPrivileges | tokenQuery, out var token))
            throw new Refusal("MAINTENANCE_STORE_ROOT_PRIVILEGE_UNAVAILABLE");
        using (token)
        {
            if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out var luid))
                throw new Refusal("MAINTENANCE_STORE_ROOT_PRIVILEGE_UNAVAILABLE");
            var desired = new TokenPrivileges
            {
                Count = 1,
                Entry = new LuidAndAttributes { Luid = luid, Attributes = enabled },
            };
            if (!AdjustTokenPrivileges(token, false, ref desired,
                    (uint)Marshal.SizeOf<TokenPrivileges>(), out var previous, out _)
                || Marshal.GetLastWin32Error() == 1300)
                throw new Refusal("MAINTENANCE_STORE_ROOT_PRIVILEGE_UNAVAILABLE");
            try { action(); }
            finally
            {
                // Restore the exact prior privilege state, even on refusal.
                if (previous.Count != 0 && !RestoreTokenPrivileges(token, false,
                        ref previous, 0, 0, 0))
                    throw new Refusal("MAINTENANCE_STORE_ROOT_PRIVILEGE_RESTORE_UNVERIFIED");
            }
        }
    }

    internal static DirectorySecurity ProtectedRootSecurity(SecurityIdentifier serviceSid)
    {
        if (serviceSid is null || serviceSid.Value is "S-1-5-18" or "S-1-5-32-544")
            throw new Refusal("STATE_ROOT_ACL_UNSAFE");
        var security = new DirectorySecurity();
        security.SetOwner(serviceSid);
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var owner in new[] { serviceSid, SystemSid, AdministratorsSid })
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
                inherit, PropagationFlags.None, AccessControlType.Allow));
        AdmissionStore.ValidateRootDacl(
            new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0), serviceSid.Value);
        return security;
    }

    internal static DirectorySecurity ProtectedParentSecurity(SecurityIdentifier serviceSid)
    {
        if (serviceSid is null || serviceSid.Value is "S-1-5-18" or "S-1-5-32-544")
            throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
        var security = new DirectorySecurity();
        security.SetOwner(AdministratorsSid);
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl,
            inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl,
            inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(serviceSid,
            FileSystemRights.ReadAndExecute | FileSystemRights.CreateDirectories,
            InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        AdmissionStore.ValidateProtectedParentDacl(
            new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0), serviceSid.Value);
        return security;
    }

    private static void ValidateProgramDataBase(string basePath)
    {
        if (!Path.IsPathFullyQualified(basePath) || basePath.StartsWith(@"\\", StringComparison.Ordinal)
            || Path.GetPathRoot(basePath)?.Length != 3 || !Directory.Exists(basePath)
            || (File.GetAttributes(basePath) & FileAttributes.ReparsePoint) != 0)
            throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
        var security = new DirectoryInfo(basePath).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        ValidateProgramDataDacl(new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0));
    }

    internal static void ValidateProgramDataDacl(RawSecurityDescriptor descriptor)
    {
        if (descriptor.Owner?.Value is not ("S-1-5-18" or "S-1-5-32-544")
            || descriptor.DiscretionaryAcl is not { } acl)
            throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
        foreach (GenericAce ace in acl)
        {
            if (ace is not QualifiedAce rule || rule.IsCallback)
                throw new Refusal("STATE_PARENT_ACL_UNVERIFIED");
            if (rule.AceQualifier != AceQualifier.AccessAllowed
                || (rule.AceFlags & AceFlags.InheritOnly) != 0
                || rule.SecurityIdentifier.Value is "S-1-5-18" or "S-1-5-32-544")
                continue;
            // Users may create ProgramData children but may not delete or
            // replace a protected child or modify the parent's security.
            // Allow only FILE_ADD_FILE and FILE_ADD_SUBDIRECTORY writes on
            // ProgramData itself. Other write/attribute/ACL rights are unsafe.
            const int dangerous = 0x520D0156 & ~0x6;
            if ((rule.AccessMask & dangerous) != 0)
                throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        }
    }

    private static SecurityIdentifier ResolveServiceSid()
    {
        try
        {
            return (SecurityIdentifier)new NTAccount(@"NT SERVICE\LnwjudUpdateAdmission")
                .Translate(typeof(SecurityIdentifier));
        }
        catch (IdentityNotMappedException)
        {
            throw new Refusal("MAINTENANCE_STORE_SERVICE_IDENTITY_UNAVAILABLE");
        }
    }

    internal static void ProvisionParent()
    {
        if (!OperatingSystem.IsWindows()
            || !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new Refusal("MAINTENANCE_STORE_PARENT_REQUIRES_ELEVATION");

        var serviceSid = ResolveServiceSid();
        var basePath = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData))
            .TrimEnd(Path.DirectorySeparatorChar);
        ValidateProgramDataBase(basePath);
        var parent = Path.Combine(basePath, "lnwjud");
        if (File.Exists(parent)) throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        if (!Directory.Exists(parent))
            CreateProtectedDirectoryOnce(parent, ProtectedParentSecurity(serviceSid),
                "MAINTENANCE_STORE_PARENT_PROVISIONING_REFUSED");
        AdmissionStore.VerifyProtectedParentPath(parent, serviceSid.Value);
        ValidateProgramDataBase(basePath);
    }

    // Create-only root staging. The root is owned by the dedicated service SID
    // and has no journal, initial snapshot, trust enrollment or update permit.
    // A failed ACL readback leaves the root untouched rather than deleting an
    // object whose identity or contents cannot be proved safe to remove.
    internal static void ProvisionRoot()
    {
        if (!OperatingSystem.IsWindows()
            || !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new Refusal("MAINTENANCE_STORE_ROOT_REQUIRES_ELEVATION");

        var serviceSid = ResolveServiceSid();
        var commonFiles = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles);
        WindowsUpdateAdmissionRegistration.VerifyServiceConfiguration(commonFiles);
        WindowsUpdateAdmissionRegistration.VerifyImageFilesystem(commonFiles);

        var basePath = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData))
            .TrimEnd(Path.DirectorySeparatorChar);
        ValidateProgramDataBase(basePath);
        var parent = Path.Combine(basePath, "lnwjud");
        AdmissionStore.VerifyProtectedParentPath(parent, serviceSid.Value);
        var root = Path.Combine(parent, "update-admission");
        // Elevated Administrators may need SeRestorePrivilege to assign a
        // dedicated service SID as owner. Enable only for create/readback.
        WithRestorePrivilege(() => CreateProtectedRootDirectory(root, serviceSid));
        AdmissionStore.VerifyProtectedParentPath(parent, serviceSid.Value);
        ValidateProgramDataBase(basePath);
    }

    internal static void CreateProtectedRootDirectory(string root, SecurityIdentifier serviceSid)
    {
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal)
            || Directory.Exists(root) || File.Exists(root))
            throw new Refusal("MAINTENANCE_STORE_ROOT_ALREADY_EXISTS");

        CreateProtectedDirectoryOnce(root, ProtectedRootSecurity(serviceSid),
            "MAINTENANCE_STORE_ROOT_PROVISIONING_REFUSED");
        AdmissionStore.VerifyProtectedRootPath(root, serviceSid.Value);
    }

    // Atomic create-only operation. A competing directory or reparse point
    // cannot be adopted or have its ACL changed by the provisioner.
    internal static void CreateProtectedDirectoryOnce(string path, DirectorySecurity security, string refusal)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal)
            || Directory.Exists(path) || File.Exists(path))
            throw new Refusal(refusal);
        var bytes = security.GetSecurityDescriptorBinaryForm();
        var descriptor = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = descriptor,
            };
            if (!CreateDirectoryWithSecurity(path, ref attributes))
                throw new Refusal(refusal);
        }
        finally { Marshal.FreeHGlobal(descriptor); }
    }
}
