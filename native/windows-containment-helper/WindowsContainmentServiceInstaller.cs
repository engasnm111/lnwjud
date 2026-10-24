using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class WindowsContainmentServiceInstaller
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ScManagerCreateService = 0x0002;
    private const uint ServiceAllAccess = 0xF01FF;
    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceAutoStart = 0x00000002;
    private const uint ServiceErrorNormal = 0x00000001;
    private const uint ServiceControlStop = 1;
    private const uint ServiceStopped = 1;
    private const uint ServiceRunning = 4;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint SecurityDescriptorRevision = 1;
    private const int ErrorInsufficientBuffer = 122;
    private const int ErrorServiceDoesNotExist = 1060;
    private const int ErrorServiceNotActive = 1062;
    private const int ErrorServiceCannotAcceptControl = 1061;
    private const int ErrorServiceAlreadyRunning = 1056;
    private const int ErrorServiceMarkedForDelete = 1072;
    private const int MaximumManifestBytes = 64 * 1024;
    private const string ServiceSecurityDescriptor = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;LC;;;AU)";
    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdministratorsSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier AuthenticatedUsersSid = new(WellKnownSidType.AuthenticatedUserSid, null);
    private static readonly SecurityIdentifier TrustedInstallerSid =
        new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
        internal uint ProcessId;
        internal uint ServiceFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct QueryServiceConfiguration
    {
        internal uint ServiceType;
        internal uint StartType;
        internal uint ErrorControl;
        internal nint BinaryPathName;
        internal nint LoadOrderGroup;
        internal nint TagId;
        internal nint Dependencies;
        internal nint ServiceStartName;
        internal nint DisplayName;
    }

    private sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeServiceHandle() : base(true) { }
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenSCManagerW")]
    private static extern SafeServiceHandle OpenSCManager(string? machine, string? database, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "OpenServiceW")]
    private static extern SafeServiceHandle OpenService(SafeServiceHandle manager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateServiceW")]
    private static extern SafeServiceHandle CreateService(
        SafeServiceHandle manager,
        string serviceName,
        string displayName,
        uint desiredAccess,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPathName,
        string? loadOrderGroup,
        nint tagId,
        string? dependencies,
        string? serviceStartName,
        string? password);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ChangeServiceConfigW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig(
        SafeServiceHandle service,
        uint serviceType,
        uint startType,
        uint errorControl,
        string? binaryPathName,
        string? loadOrderGroup,
        nint tagId,
        string? dependencies,
        string? serviceStartName,
        string? password,
        string? displayName);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryServiceConfigW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig(SafeServiceHandle service, nint config, uint bufferSize, out uint bytesNeeded);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "QueryServiceStatusEx")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(
        SafeServiceHandle service,
        int infoLevel,
        out ServiceStatusProcess status,
        uint bufferSize,
        out uint bytesNeeded);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "ControlService")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ControlService(SafeServiceHandle service, uint control, out ServiceStatus status);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "StartServiceW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartService(SafeServiceHandle service, uint argumentCount, nint arguments);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "DeleteService")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteService(SafeServiceHandle service);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetServiceObjectSecurity")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceObjectSecurity(SafeServiceHandle service, uint securityInformation, nint securityDescriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string stringSecurityDescriptor,
        uint revision,
        out nint securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CloseServiceHandle(nint handle);

    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint memory);

    internal static void Install()
    {
        EnsureWindows();
        var imagePath = Path.GetFullPath(Environment.ProcessPath ?? throw new IOException("SERVICE_INSTALL_IMAGE_UNAVAILABLE"));
        var programFiles = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        var installRoot = ValidateImagePath(imagePath, programFiles);
        EnsureNoReparsePoints(imagePath);
        VerifyProtectedAncestors(installRoot, programFiles);
        SecureInstalledImage(installRoot, imagePath);
        VerifyPackageManifest(imagePath);

        using var manager = OpenSCManager(null, null, ScManagerConnect | ScManagerCreateService);
        if (manager.IsInvalid) throw new IOException("SERVICE_INSTALL_SCM_UNAVAILABLE");

        var service = OpenService(manager, WindowsContainmentService.ServiceName, ServiceAllAccess);
        var created = false;
        if (service.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            service.Dispose();
            if (error != ErrorServiceDoesNotExist) throw new IOException("SERVICE_INSTALL_OPEN_FAILED");
            service = CreateService(
                manager,
                WindowsContainmentService.ServiceName,
                "lnwjud Windows Containment",
                ServiceAllAccess,
                ServiceWin32OwnProcess,
                ServiceAutoStart,
                ServiceErrorNormal,
                BuildServiceCommand(imagePath),
                null,
                0,
                null,
                null,
                null);
            if (service.IsInvalid) throw new IOException("SERVICE_INSTALL_CREATE_FAILED");
            created = true;
        }

        using (service)
        {
            try
            {
                var installedImage = QueryImagePath(service);
                if (!String.Equals(installedImage, imagePath, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("SERVICE_INSTALL_EXISTING_IMAGE_MISMATCH");
                StopAndWait(service);
                if (!ChangeServiceConfig(
                        service,
                        ServiceWin32OwnProcess,
                        ServiceAutoStart,
                        ServiceErrorNormal,
                        BuildServiceCommand(imagePath),
                        null,
                        0,
                        null,
                        "LocalSystem",
                        null,
                        "lnwjud Windows Containment"))
                    throw new IOException("SERVICE_INSTALL_CONFIGURE_FAILED");
                ApplyServiceSecurity(service);
                StartAndWait(service);
            }
            catch
            {
                if (created)
                {
                    try { StopAndWait(service); } catch { }
                    _ = DeleteService(service);
                }
                throw;
            }
        }
    }

    internal static void Uninstall()
    {
        EnsureWindows();
        using var manager = OpenSCManager(null, null, ScManagerConnect);
        if (manager.IsInvalid) throw new IOException("SERVICE_REMOVE_SCM_UNAVAILABLE");
        var service = OpenService(manager, WindowsContainmentService.ServiceName, ServiceAllAccess);
        if (service.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            service.Dispose();
            if (error == ErrorServiceDoesNotExist) return;
            throw new IOException("SERVICE_REMOVE_OPEN_FAILED");
        }

        using (service)
        {
            StopAndWait(service);
            if (!DeleteService(service))
            {
                var error = Marshal.GetLastWin32Error();
                if (error != ErrorServiceMarkedForDelete) throw new IOException("SERVICE_REMOVE_DELETE_FAILED");
            }
        }
    }

    internal static string ValidateImagePath(string helperPath, string programFilesRoot)
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("SERVICE_INSTALL_WINDOWS_REQUIRED");
        if (String.IsNullOrWhiteSpace(helperPath) || String.IsNullOrWhiteSpace(programFilesRoot)
            || helperPath.Contains('"') || helperPath.Contains('\0') || programFilesRoot.Contains('\0'))
            throw new IOException("SERVICE_INSTALL_PATH_INVALID");

        var fullPath = Path.GetFullPath(helperPath);
        var root = Path.GetFullPath(programFilesRoot);
        var relative = Path.GetRelativePath(root, fullPath);
        if (relative == "." || relative == ".."
            || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || Path.IsPathRooted(relative))
            throw new IOException("SERVICE_INSTALL_ROOT_UNPROTECTED");
        if (!String.Equals(Path.GetFileName(fullPath), "lnwjud-containment.exe", StringComparison.OrdinalIgnoreCase))
            throw new IOException("SERVICE_INSTALL_IMAGE_INVALID");

        var containment = new DirectoryInfo(Path.GetDirectoryName(fullPath)!);
        var resources = containment.Parent;
        var installRoot = resources?.Parent;
        if (!String.Equals(containment.Name, "native-containment", StringComparison.OrdinalIgnoreCase)
            || !String.Equals(resources?.Name, "resources", StringComparison.OrdinalIgnoreCase)
            || installRoot is null
            || !IsBelowRoot(installRoot.FullName, root))
            throw new IOException("SERVICE_INSTALL_LAYOUT_INVALID");
        return Path.GetFullPath(installRoot.FullName);
    }

    internal static string BuildServiceCommand(string helperPath)
    {
        if (String.IsNullOrWhiteSpace(helperPath) || helperPath.Contains('"') || helperPath.Contains('\0'))
            throw new IOException("SERVICE_INSTALL_IMAGE_INVALID");
        return "\"" + Path.GetFullPath(helperPath) + "\" service";
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("SERVICE_INSTALL_WINDOWS_REQUIRED");
    }

    private static void VerifyPackageManifest(string imagePath)
    {
        try
        {
            var directory = Path.GetDirectoryName(imagePath) ?? throw new IOException();
            var manifestPath = Path.Combine(directory, "manifest.json");
            var pinPath = Path.Combine(directory, "lnwjud-containment-pin.node");
            EnsureNoReparsePoints(manifestPath);
            EnsureNoReparsePoints(pinPath);
            var manifestInfo = new FileInfo(manifestPath);
            if (!manifestInfo.Exists || manifestInfo.Length is < 2 or > MaximumManifestBytes)
                throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(manifestPath), new JsonDocumentOptions { MaxDepth = 8 });
            var root = manifest.RootElement;
            if (root.GetProperty("schemaVersion").GetInt32() != 2
                || root.GetProperty("buildId").GetString() != Program.BuildId
                || root.GetProperty("platform").GetString() != "win32"
                || root.GetProperty("architecture").GetString() != "x64"
                || root.GetProperty("filename").GetString() != "lnwjud-containment.exe"
                || root.GetProperty("pinFilename").GetString() != "lnwjud-containment-pin.node")
                throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
            var helperHash = root.GetProperty("sha256").GetString() ?? throw new IOException();
            var pinHash = root.GetProperty("pinSha256").GetString() ?? throw new IOException();
            ValidateSha256(helperHash);
            ValidateSha256(pinHash);
            if (!String.Equals(HashFile(imagePath), helperHash, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(HashFile(pinPath), pinHash, StringComparison.OrdinalIgnoreCase))
                throw new IOException("SERVICE_PACKAGE_HASH_MISMATCH");
        }
        catch (Exception exception) when (exception is not IOException { Message: "SERVICE_PACKAGE_MANIFEST_INVALID" or "SERVICE_PACKAGE_HASH_MISMATCH" })
        {
            throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
        }
    }

    private static string HashFile(string filename)
    {
        using var input = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
    }

    private static void ValidateSha256(string value)
    {
        if (value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
            throw new IOException("SERVICE_PACKAGE_MANIFEST_INVALID");
    }

    private static void VerifyProtectedAncestors(string installRoot, string programFilesRoot)
    {
        var current = new DirectoryInfo(installRoot).Parent;
        var reachedProgramFiles = false;
        while (current is not null)
        {
            VerifyTrustedAcl(current);
            if (String.Equals(Path.GetFullPath(current.FullName), Path.GetFullPath(programFilesRoot), StringComparison.OrdinalIgnoreCase))
            {
                reachedProgramFiles = true;
                break;
            }
            current = current.Parent;
        }
        if (!reachedProgramFiles) throw new IOException("SERVICE_INSTALL_ROOT_UNPROTECTED");
    }

    private static void VerifyTrustedAcl(DirectoryInfo directory)
    {
        if (!directory.Exists || (directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_INSTALL_PATH_UNPROTECTED");
        var security = directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        var owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (!IsTrusted(owner)) throw new IOException("SERVICE_INSTALL_OWNER_UNTRUSTED");
        EnsureNoUntrustedWriteRules(security);
    }

    private static void SecureInstalledImage(string installRoot, string imagePath)
    {
        var resources = Path.Combine(installRoot, "resources");
        var containment = Path.Combine(resources, "native-containment");
        foreach (var directoryPath in new[] { installRoot, resources, containment })
        {
            if (!Directory.Exists(directoryPath) || (File.GetAttributes(directoryPath) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("SERVICE_INSTALL_PATH_UNPROTECTED");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.SetOwner(AdministratorsSid);
            var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(AuthenticatedUsersSid, FileSystemRights.ReadAndExecute, inheritance, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(directoryPath).SetAccessControl(security);
            EnsureProtectedAcl(new DirectoryInfo(directoryPath).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
        }

        SecurePackageFile(imagePath);
        SecurePackageFile(Path.Combine(containment, "manifest.json"));
        SecurePackageFile(Path.Combine(containment, "lnwjud-containment-pin.node"));
    }

    private static void SecurePackageFile(string path)
    {
        if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_INSTALL_IMAGE_UNAVAILABLE");
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(AdministratorsSid);
        security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AuthenticatedUsersSid, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        new FileInfo(path).SetAccessControl(security);
        EnsureProtectedAcl(new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
    }

    private static void EnsureProtectedAcl(FileSystemSecurity security)
    {
        var owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (!IsTrusted(owner)) throw new IOException("SERVICE_INSTALL_OWNER_UNTRUSTED");
        EnsureNoUntrustedWriteRules(security);
    }

    private static void EnsureNoUntrustedWriteRules(FileSystemSecurity security)
    {
        const FileSystemRights genericWrite = (FileSystemRights)0x40000000;
        const FileSystemRights genericAll = (FileSystemRights)0x10000000;
        const FileSystemRights writeRights = FileSystemRights.WriteData | FileSystemRights.AppendData
            | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes
            | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
            | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | genericWrite | genericAll;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow
                || (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (!IsTrusted(sid) && (rule.FileSystemRights & writeRights) != 0)
                throw new IOException("SERVICE_INSTALL_ACL_UNTRUSTED");
        }
    }

    private static bool IsTrusted(SecurityIdentifier? sid) =>
        sid is not null && (sid.Equals(SystemSid) || sid.Equals(AdministratorsSid) || sid.Equals(TrustedInstallerSid));

    private static bool IsBelowRoot(string path, string root)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
        return relative != "." && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    private static void EnsureNoReparsePoints(string path)
    {
        var current = Path.GetFullPath(path);
        while (true)
        {
            if ((File.Exists(current) || Directory.Exists(current))
                && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("SERVICE_INSTALL_REPARSE_REFUSED");
            var parent = Directory.GetParent(current);
            if (parent is null) return;
            current = parent.FullName;
        }
    }

    private static void ApplyServiceSecurity(SafeServiceHandle service)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(
                ServiceSecurityDescriptor,
                SecurityDescriptorRevision,
                out var descriptor,
                out _))
            throw new IOException("SERVICE_INSTALL_SECURITY_DESCRIPTOR_INVALID");
        try
        {
            if (!SetServiceObjectSecurity(service, DaclSecurityInformation, descriptor))
                throw new IOException("SERVICE_INSTALL_SECURITY_FAILED");
        }
        finally { _ = LocalFree(descriptor); }
    }

    private static string QueryImagePath(SafeServiceHandle service)
    {
        if (QueryServiceConfig(service, 0, 0, out var required)
            || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer
            || required == 0)
            throw new IOException("SERVICE_INSTALL_CONFIG_UNAVAILABLE");
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!QueryServiceConfig(service, buffer, required, out _))
                throw new IOException("SERVICE_INSTALL_CONFIG_UNAVAILABLE");
            var configuration = Marshal.PtrToStructure<QueryServiceConfiguration>(buffer);
            var command = Marshal.PtrToStringUni(configuration.BinaryPathName) ?? throw new IOException("SERVICE_INSTALL_CONFIG_INVALID");
            if (command.Length < 3 || command[0] != '"')
                throw new IOException("SERVICE_INSTALL_CONFIG_INVALID");
            var endQuote = command.IndexOf('"', 1);
            if (endQuote <= 1 || command[(endQuote + 1)..].Trim() != "service")
                throw new IOException("SERVICE_INSTALL_CONFIG_INVALID");
            return Path.GetFullPath(command[1..endQuote]);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void StopAndWait(SafeServiceHandle service)
    {
        var deadline = Stopwatch.StartNew();
        var stopRequested = false;
        while (deadline.Elapsed < TimeSpan.FromSeconds(30))
        {
            var status = QueryStatus(service);
            if (status.CurrentState == ServiceStopped) return;
            if (status.CurrentState == ServiceRunning && !stopRequested)
            {
                if (!ControlService(service, ServiceControlStop, out _))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != ErrorServiceNotActive && error != ErrorServiceCannotAcceptControl)
                        throw new IOException("SERVICE_STOP_REQUEST_FAILED");
                }
                else stopRequested = true;
            }
            Thread.Sleep(100);
        }
        throw new IOException("SERVICE_STOP_TIMEOUT");
    }

    private static void StartAndWait(SafeServiceHandle service)
    {
        var status = QueryStatus(service);
        if (status.CurrentState == ServiceStopped && !StartService(service, 0, 0))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != ErrorServiceAlreadyRunning) throw new IOException("SERVICE_START_REQUEST_FAILED");
        }

        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(30))
        {
            if (QueryStatus(service).CurrentState == ServiceRunning) return;
            Thread.Sleep(100);
        }
        throw new IOException("SERVICE_START_TIMEOUT");
    }

    private static ServiceStatusProcess QueryStatus(SafeServiceHandle service)
    {
        if (!QueryServiceStatusEx(
                service,
                0,
                out var status,
                (uint)Marshal.SizeOf<ServiceStatusProcess>(),
                out _))
            throw new IOException("SERVICE_STATUS_UNAVAILABLE");
        return status;
    }
}
