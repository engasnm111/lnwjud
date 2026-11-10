using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Lnwjud.UpdateAdmission;

// Attended, create-only protection of the immediate ProgramData journal
// parent. No store, journal, trust enrollment or update permit is created.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionStoreParentProvisioner
{
    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdministratorsSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);

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
        var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
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
            const int dangerous = 0x10000000 | 0x40000000 | 0x00010000 | 0x00000040
                | 0x00040000 | 0x00080000;
            if ((rule.AccessMask & dangerous) != 0)
                throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        }
    }

    internal static void ProvisionParent()
    {
        if (!OperatingSystem.IsWindows()
            || !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new Refusal("MAINTENANCE_STORE_PARENT_REQUIRES_ELEVATION");

        SecurityIdentifier serviceSid;
        try
        {
            serviceSid = (SecurityIdentifier)new NTAccount(@"NT SERVICE\LnwjudUpdateAdmission")
                .Translate(typeof(SecurityIdentifier));
        }
        catch (IdentityNotMappedException)
        {
            throw new Refusal("MAINTENANCE_STORE_SERVICE_IDENTITY_UNAVAILABLE");
        }

        var basePath = Path.GetFullPath(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData))
            .TrimEnd(Path.DirectorySeparatorChar);
        ValidateProgramDataBase(basePath);
        var parent = Path.Combine(basePath, "lnwjud");
        if (File.Exists(parent)) throw new Refusal("STATE_PARENT_ACL_UNSAFE");
        if (!Directory.Exists(parent))
            FileSystemAclExtensions.CreateDirectory(ProtectedParentSecurity(serviceSid), parent);
        AdmissionStore.VerifyProtectedParentPath(parent, serviceSid.Value);
        ValidateProgramDataBase(basePath);
    }
}
