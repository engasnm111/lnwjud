using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Lnwjud.UpdateAdmission;

// Attended create-only image staging. A caller-supplied hash is not release
// provenance; an independently authenticated installer must select the pin.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionImageStager
{
    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdministratorsSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier AuthenticatedUsersSid = new(WellKnownSidType.AuthenticatedUserSid, null);

    private const long MaximumImageBytes = 128L * 1024 * 1024;

    internal static void CopyVerified(Stream source, Stream destination, byte[] pin)
    {
        if (!source.CanRead || !source.CanSeek || !destination.CanWrite || pin.Length != 32
            || source.Position != 0 || source.Length is <= 0 or > MaximumImageBytes)
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        var initial = source.Position;
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(source), pin))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        source.Position = initial;
        source.CopyTo(destination);
        destination.Flush();
    }

    private static DirectorySecurity ProtectedDirectorySecurity()
    {
        var security = new DirectorySecurity();
        security.SetOwner(AdministratorsSid);
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AuthenticatedUsersSid, FileSystemRights.ReadAndExecute,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static FileSecurity ProtectedFileSecurity()
    {
        var security = new FileSecurity();
        security.SetOwner(AdministratorsSid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AuthenticatedUsersSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        return security;
    }

    private static void VerifyDirectory(string path)
    {
        if (!Directory.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        WindowsUpdateAdmissionRegistration.ValidateImageDacl(
            new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0));
    }

    private static void PrepareDirectories(string commonFiles, string image)
    {
        var commonRoot = Path.GetFullPath(commonFiles).TrimEnd(Path.DirectorySeparatorChar);
        var volume = Path.GetPathRoot(image)!;
        var current = volume;
        var insideCommonFiles = false;
        foreach (var component in Path.GetDirectoryName(image)![volume.Length..].Split(
            Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (Directory.Exists(current))
                VerifyDirectory(current);
            else
            {
                // Never manufacture missing Windows/Program Files ancestors.
                if (!insideCommonFiles || File.Exists(current))
                    throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
                FileSystemAclExtensions.CreateDirectory(ProtectedDirectorySecurity(), current);
                VerifyDirectory(current);
            }
            if (string.Equals(current, commonRoot, StringComparison.OrdinalIgnoreCase))
                insideCommonFiles = true;
        }
        if (!insideCommonFiles) throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
    }

    internal static void StageImage(string sourcePath, string expectedSha256)
    {
        if (!OperatingSystem.IsWindows()
            || !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new Refusal("MAINTENANCE_SERVICE_PROVISIONER_REQUIRES_ELEVATION");
        var pin = WindowsUpdateAdmissionProvisioner.ValidatePin(expectedSha256);
        var commonFiles = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles);
        var image = WindowsUpdateAdmissionRegistration.ExpectedImagePath(commonFiles);
        if (!Path.IsPathFullyQualified(sourcePath) || sourcePath.StartsWith(@"\\", StringComparison.Ordinal)
            || sourcePath.Contains('\0') || !File.Exists(sourcePath)
            || (File.GetAttributes(sourcePath) & FileAttributes.ReparsePoint) != 0
            || File.Exists(image))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");

        using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (source.Length is <= 0 or > MaximumImageBytes)
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        // Hash before any privileged filesystem creation.
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(source), pin))
            throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        source.Position = 0;

        PrepareDirectories(commonFiles, image);
        var temporary = Path.Combine(Path.GetDirectoryName(image)!,
            ".lnwjud-broker-stage-" + Guid.NewGuid().ToString("N") + ".tmp");
        var moved = false;
        try
        {
            // The protected parent denies unprivileged writes even during
            // creation. Set owner/DACL before reopening for the actual copy.
            using (new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            new FileInfo(temporary).SetAccessControl(ProtectedFileSecurity());
            using (var output = new FileStream(temporary, FileMode.Open, FileAccess.Write,
                       FileShare.None, 65_536, FileOptions.WriteThrough))
            {
                CopyVerified(source, output, pin);
                output.Flush(true);
            }
            using (var verify = new FileStream(temporary, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(verify), pin))
                    throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
            }
            File.Move(temporary, image, false);
            moved = true;
            WindowsUpdateAdmissionRegistration.VerifyImageFilesystem(commonFiles);
            using var final = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(final), pin))
                throw new Refusal("MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        }
        catch
        {
            // Do not erase an unknown pre-existing final image. Only clean
            // this invocation's temp or final when the atomic move succeeded.
            try
            {
                if (moved) File.Delete(image);
                else if (File.Exists(temporary)) File.Delete(temporary);
            }
            catch { throw new Refusal("MAINTENANCE_SERVICE_IMAGE_CLEANUP_UNVERIFIED"); }
            throw;
        }
    }
}
